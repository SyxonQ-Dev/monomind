/**
 * WorkerManager — background worker lifecycle, persistence, alerts, statusline
 *
 * Also exports all shared types, enums, constants used across the workers package.
 * Extracted from workers/index.ts (ARCH-3) to keep index.ts as a thin re-export hub.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { WorkerManagerState } from './worker-manager-state.js';
import {
  WORKER_ALIAS_MAP,
  WORKER_CONFIGS,
  type WorkerConfig,
  type WorkerHandler,
  type WorkerManagerStatus,
  WorkerPriority,
  type WorkerResult,
} from './worker-manager-types.js';

export * from './worker-manager-types.js';

const MAX_CONCURRENCY = 5;

// ============================================================================
// WorkerManager
// ============================================================================

const STATUSLINE_UPDATE_INTERVAL = 10_000; // 10 seconds

export class WorkerManager extends WorkerManagerState {
  private workers: Map<string, WorkerHandler> = new Map();
  private timers: Map<string, NodeJS.Timeout> = new Map();
  // P2-54: WORKER_CONFIGS is a shared module-level constant. register() used
  // to mutate it directly, which leaked dynamically-registered worker
  // configs into every OTHER WorkerManager instance (including unrelated
  // test files and the CLI's `hooks worker list`). Each instance now owns
  // its own config store, seeded from the shared static defaults at
  // construction time; register() writes here instead of to the module
  // constant, and every other read in this class goes through this store.
  private workerConfigs: Map<string, WorkerConfig> = new Map(Object.entries(WORKER_CONFIGS));
  private running = false;
  private startTime?: Date;
  private projectRoot: string;
  private statuslineTimer?: NodeJS.Timeout;
  private autoSaveTimer?: NodeJS.Timeout;
  private initialized = false;

  constructor(projectRoot?: string) {
    super();
    this.projectRoot = projectRoot || process.cwd();
    this.metricsDir = path.join(this.projectRoot, '.monomind', 'metrics');
    this.persistPath = path.join(this.metricsDir, 'workers-state.json');
    this.statuslinePath = path.join(this.metricsDir, 'statusline.json');
    this.initializeMetrics();
  }

  private initializeMetrics(): void {
    for (const [name, config] of this.workerConfigs) {
      this.metrics.set(name, {
        name,
        status: config.enabled ? 'idle' : 'disabled',
        runCount: 0,
        errorCount: 0,
        avgDuration: 0,
      });
    }
  }

  // =========================================================================
  // Core Worker Methods
  // =========================================================================

  /**
   * Register a worker handler
   * Optionally pass config; if not provided, a default config is used for dynamically registered workers
   */
  register(name: string, handler: WorkerHandler, config?: Partial<WorkerConfig>): void {
    this.workers.set(name, handler);

    // Create config if not already known (for dynamic/test workers). Written
    // to this instance's own store — NOT the shared WORKER_CONFIGS constant —
    // so it never leaks into other WorkerManager instances (P2-54).
    if (!this.workerConfigs.has(name)) {
      this.workerConfigs.set(name, {
        name,
        description: config?.description ?? `Dynamic worker: ${name}`,
        interval: config?.interval ?? 60_000,
        enabled: config?.enabled ?? true,
        priority: config?.priority ?? WorkerPriority.Normal,
        timeout: config?.timeout ?? 30_000,
      });
    }

    // Initialize metrics if not already present
    if (!this.metrics.has(name)) {
      this.metrics.set(name, {
        name,
        status: 'idle',
        runCount: 0,
        errorCount: 0,
        avgDuration: 0,
      });
    }

    this.emit('worker:registered', { name });
  }

  /**
   * Initialize and start workers (loads persisted state)
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    await this.ensureMetricsDir();
    await this.loadState();

    this.initialized = true;
    this.emit('manager:initialized');
  }

  /**
   * Start all workers with scheduling
   */
  async start(options?: { autoSave?: boolean; statuslineUpdate?: boolean }): Promise<void> {
    if (this.running) return;

    if (!this.initialized) {
      await this.initialize();
    }

    this.running = true;
    this.startTime = new Date();

    // Schedule all workers
    for (const [name, config] of this.workerConfigs) {
      if (!config.enabled) continue;
      if (config.platforms && !config.platforms.includes(os.platform() as any)) continue;

      this.scheduleWorker(name, config);
    }

    // Auto-save every 5 minutes
    if (options?.autoSave !== false) {
      this.autoSaveTimer = setInterval(() => {
        this.saveState().catch(() => {});
      }, 300_000);
      if (this.autoSaveTimer.unref) this.autoSaveTimer.unref();
    }

    // Update statusline file periodically
    if (options?.statuslineUpdate !== false) {
      this.statuslineTimer = setInterval(() => {
        this.exportStatusline().catch(() => {});
      }, STATUSLINE_UPDATE_INTERVAL);
      if (this.statuslineTimer.unref) this.statuslineTimer.unref();
    }

    this.emit('manager:started');
  }

  /**
   * Stop all workers and save state
   */
  async stop(): Promise<void> {
    this.running = false;

    // Clear all timers
    Array.from(this.timers.values()).forEach((timer) => {
      clearTimeout(timer);
    });
    this.timers.clear();

    if (this.autoSaveTimer) {
      clearInterval(this.autoSaveTimer);
      this.autoSaveTimer = undefined;
    }

    if (this.statuslineTimer) {
      clearInterval(this.statuslineTimer);
      this.statuslineTimer = undefined;
    }

    // Save final state
    await this.saveState();
    await this.exportStatusline();

    this.emit('manager:stopped');
  }

  /**
   * Run a specific worker immediately
   */
  async runWorker(name: string): Promise<WorkerResult> {
    const resolvedName = WORKER_ALIAS_MAP[name] ?? name;
    const handler = this.workers.get(resolvedName);
    const config = this.workerConfigs.get(resolvedName);
    const metrics = this.metrics.get(resolvedName);

    if (!handler || !config || !metrics) {
      return {
        worker: name,
        success: false,
        duration: 0,
        error: `Worker '${name}' not found (resolved: '${resolvedName}')`,
        timestamp: new Date(),
      };
    }

    metrics.status = 'running';
    const startTime = Date.now();

    // P1-24: the losing side of Promise.race is never cancelled, so when the
    // handler wins (the normal case) this timer was left running for up to
    // `config.timeout` (2 min for the security worker), keeping the event
    // loop alive well after the worker actually finished — a one-shot
    // `hooks worker run <name>` CLI invocation would hang open that whole
    // time. Capture the handle and clear it once the race settles (same
    // onnx-teardown class of bug as embed-worker.ts's missing process.exit).
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        handler(),
        new Promise<WorkerResult>((_, reject) => {
          timeoutHandle = setTimeout(() => reject(new Error('Timeout')), config.timeout);
        }),
      ]);
      clearTimeout(timeoutHandle);

      const duration = Date.now() - startTime;

      metrics.status = 'idle';
      metrics.lastRun = new Date();
      metrics.lastDuration = duration;
      metrics.runCount++;
      metrics.avgDuration =
        (metrics.avgDuration * (metrics.runCount - 1) + duration) / metrics.runCount;
      metrics.lastResult = result.data;

      // Check alerts and record history
      const alerts = this.checkAlerts(name, result);
      result.alerts = alerts;
      this.recordHistory(name, result);

      this.emit('worker:completed', { name, result, duration, alerts });

      return result;
    } catch (error) {
      clearTimeout(timeoutHandle);
      const duration = Date.now() - startTime;

      metrics.status = 'error';
      metrics.errorCount++;
      metrics.lastRun = new Date();

      const result: WorkerResult = {
        worker: name,
        success: false,
        duration,
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date(),
      };

      this.emit('worker:error', { name, error, duration });

      return result;
    }
  }

  /**
   * Run all workers (non-blocking with concurrency limit)
   */
  async runAll(concurrency = MAX_CONCURRENCY): Promise<WorkerResult[]> {
    const workers = Array.from(this.workers.keys());
    const results: WorkerResult[] = [];

    // Process in batches to limit concurrency
    for (let i = 0; i < workers.length; i += concurrency) {
      const batch = workers.slice(i, i + concurrency);
      const batchResults = await Promise.all(batch.map((name) => this.runWorker(name)));
      results.push(...batchResults);
    }

    return results;
  }

  /**
   * Get worker status
   */
  getStatus(): WorkerManagerStatus {
    return {
      running: this.running,
      platform: os.platform(),
      workers: Array.from(this.metrics.values()),
      uptime: this.startTime ? Date.now() - this.startTime.getTime() : 0,
      totalRuns: Array.from(this.metrics.values()).reduce((sum, m) => sum + m.runCount, 0),
      lastUpdate: new Date(),
    };
  }

  /**
   * Get statusline-friendly metrics
   */
  getStatuslineMetrics(): Record<string, unknown> {
    const workers = Array.from(this.metrics.values());
    const running = workers.filter((w) => w.status === 'running').length;
    const errors = workers.filter((w) => w.status === 'error').length;
    const total = workers.filter((w) => w.status !== 'disabled').length;

    return {
      workersActive: running,
      workersTotal: total,
      workersError: errors,
      lastResults: Object.fromEntries(
        workers.filter((w) => w.lastResult).map((w) => [w.name, w.lastResult]),
      ),
    };
  }

  private scheduleWorker(name: string, config: WorkerConfig): void {
    const run = async () => {
      if (!this.running) return;

      await this.runWorker(name);

      if (this.running) {
        this.timers.set(name, setTimeout(run, config.interval));
      }
    };

    // Initial run with staggered start
    const stagger = config.priority * 1000;
    this.timers.set(name, setTimeout(run, stagger));
  }
}
