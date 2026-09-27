/**
 * WorkerManagerState — persistence, alerts, historical metrics and statusline
 * state for WorkerManager, which extends it with scheduling and lifecycle.
 */

import { EventEmitter } from 'node:events';
import { renameSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import {
  AlertSeverity,
  type AlertThreshold,
  DEFAULT_THRESHOLDS,
  type HistoricalMetric,
  type PersistedWorkerState,
  type StatuslineData,
  toSecurityStatus,
  type WorkerAlert,
  type WorkerMetrics,
  type WorkerResult,
} from './worker-manager-types.js';

/**
 * Atomic write — write to a tmp path then rename. A crash mid-write leaves
 * the previous file intact rather than a truncated one. Inlined locally
 * (rather than imported from @monoes/memory/atomic-file) per PKG-7 plan.
 */
function writeFileAtomicSync(filePath: string, content: string): void {
  const tmp = `${filePath}.tmp.${process.pid}`;
  writeFileSync(tmp, content);
  renameSync(tmp, filePath);
}

// ============================================================================
// Security Constants
// ============================================================================

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB limit
const MAX_ALERTS = 100;
const MAX_HISTORY = 1000;

// ============================================================================
// Internal Utilities
// ============================================================================

function safeJsonParse<T>(content: string): T {
  return JSON.parse(content, (key, value) => {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      return undefined;
    }
    return value;
  });
}

async function safeReadFile(filePath: string, maxSize = MAX_FILE_SIZE): Promise<string> {
  try {
    const stats = await fs.stat(filePath);
    if (stats.size > maxSize) {
      throw new Error(`File too large: ${stats.size} > ${maxSize}`);
    }
    return await fs.readFile(filePath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('File not found');
    }
    throw error;
  }
}

// ============================================================================
// WorkerManagerState
// ============================================================================

const PERSISTENCE_VERSION = '1.0.0';
const MAX_HISTORY_ENTRIES = 1000;

export class WorkerManagerState extends EventEmitter {
  protected metrics: Map<string, WorkerMetrics> = new Map();
  protected metricsDir!: string;
  protected persistPath!: string;
  protected statuslinePath!: string;

  // New features
  private alerts: WorkerAlert[] = [];
  private history: HistoricalMetric[] = [];
  private thresholds: Record<string, AlertThreshold[]> = { ...DEFAULT_THRESHOLDS };

  // =========================================================================
  // Persistence Methods (using JSON storage)
  // =========================================================================

  /**
   * Load persisted state from disk
   */
  async loadState(): Promise<boolean> {
    try {
      const content = await safeReadFile(this.persistPath, 1024 * 1024); // 1MB limit
      const state: PersistedWorkerState = safeJsonParse(content);

      if (state.version !== PERSISTENCE_VERSION) {
        this.emit('persistence:version-mismatch', {
          expected: PERSISTENCE_VERSION,
          got: state.version,
        });
        return false;
      }

      // Restore metrics
      for (const [name, data] of Object.entries(state.workers)) {
        const metrics = this.metrics.get(name);
        if (metrics) {
          metrics.runCount = data.runCount;
          metrics.errorCount = data.errorCount;
          metrics.avgDuration = data.avgDuration;
          metrics.lastResult = data.lastResult;
          if (data.lastRun) {
            metrics.lastRun = new Date(data.lastRun);
          }
        }
      }

      // Restore history (limit to max entries)
      this.history = state.history.slice(-MAX_HISTORY_ENTRIES);

      this.emit('persistence:loaded', { workers: Object.keys(state.workers).length });
      return true;
    } catch {
      // No persisted state or invalid - start fresh
      return false;
    }
  }

  /**
   * Save current state to disk
   */
  async saveState(): Promise<void> {
    try {
      await this.ensureMetricsDir();

      const state: PersistedWorkerState = {
        version: PERSISTENCE_VERSION,
        lastSaved: new Date().toISOString(),
        workers: {},
        history: this.history.slice(-MAX_HISTORY_ENTRIES),
      };

      for (const [name, metrics] of this.metrics.entries()) {
        state.workers[name] = {
          lastRun: metrics.lastRun?.toISOString(),
          lastResult: metrics.lastResult,
          runCount: metrics.runCount,
          errorCount: metrics.errorCount,
          avgDuration: metrics.avgDuration,
        };
      }

      // PKG-7: atomic write (tmp + rename) so a crash mid-write cannot leave
      // workers-state.json truncated/empty. The previous bare fs.writeFile
      // would zero the file on SIGKILL or power loss.
      writeFileAtomicSync(this.persistPath, JSON.stringify(state, null, 2));
      this.emit('persistence:saved');
    } catch (error) {
      this.emit('persistence:error', { error });
    }
  }

  // =========================================================================
  // Alert System
  // =========================================================================

  /**
   * Check result against thresholds and generate alerts
   */
  protected checkAlerts(workerName: string, result: WorkerResult): WorkerAlert[] {
    const alerts: WorkerAlert[] = [];
    const thresholds = this.thresholds[workerName];

    if (!thresholds || !result.data) return alerts;

    for (const threshold of thresholds) {
      const rawValue = this.getNestedValue(result.data, threshold.metric);
      if (rawValue === undefined || rawValue === null) continue;
      if (typeof rawValue !== 'number') continue;

      const value: number = rawValue;
      let severity: AlertSeverity | null = null;

      if (threshold.comparison === 'gt') {
        if (value >= threshold.critical) severity = AlertSeverity.Critical;
        else if (value >= threshold.warning) severity = AlertSeverity.Warning;
      } else if (threshold.comparison === 'lt') {
        if (value <= threshold.critical) severity = AlertSeverity.Critical;
        else if (value <= threshold.warning) severity = AlertSeverity.Warning;
      } else if (threshold.comparison === 'eq') {
        // Metrics compared here (pct/rate/count values) can be floating-point,
        // so use a small epsilon tolerance instead of strict === equality.
        const EPSILON = 1e-9;
        if (Math.abs(value - threshold.critical) <= EPSILON) severity = AlertSeverity.Critical;
        else if (Math.abs(value - threshold.warning) <= EPSILON) severity = AlertSeverity.Warning;
      }

      if (severity) {
        const alert: WorkerAlert = {
          worker: workerName,
          severity,
          message: `${threshold.metric} is ${value} (threshold: ${severity === AlertSeverity.Critical ? threshold.critical : threshold.warning})`,
          metric: threshold.metric,
          value: value as number,
          threshold: severity === AlertSeverity.Critical ? threshold.critical : threshold.warning,
          timestamp: new Date(),
        };
        alerts.push(alert);

        // Ring buffer: remove oldest first to avoid memory spikes
        if (this.alerts.length >= MAX_ALERTS) {
          this.alerts.shift();
        }
        this.alerts.push(alert);

        this.emit('alert', alert);
      }
    }

    return alerts;
  }

  private getNestedValue(obj: Record<string, unknown>, dotPath: string): unknown {
    return dotPath.split('.').reduce((acc: unknown, part) => {
      if (acc && typeof acc === 'object') {
        return (acc as Record<string, unknown>)[part];
      }
      return undefined;
    }, obj);
  }

  /**
   * Set custom alert thresholds
   */
  setThresholds(worker: string, thresholds: AlertThreshold[]): void {
    this.thresholds[worker] = thresholds;
  }

  /**
   * Get recent alerts
   */
  getAlerts(limit = 20): WorkerAlert[] {
    return this.alerts.slice(-limit);
  }

  /**
   * Clear alerts
   */
  clearAlerts(): void {
    this.alerts = [];
    this.emit('alerts:cleared');
  }

  // =========================================================================
  // Historical Metrics
  // =========================================================================

  /**
   * Record metrics to history
   */
  protected recordHistory(workerName: string, result: WorkerResult): void {
    if (!result.data) return;

    const metricsData: Record<string, number> = {};

    // Extract numeric values from result
    const extractNumbers = (obj: Record<string, unknown>, prefix = ''): void => {
      for (const [key, value] of Object.entries(obj)) {
        const fullKey = prefix ? `${prefix}.${key}` : key;
        if (typeof value === 'number') {
          metricsData[fullKey] = value;
        } else if (value && typeof value === 'object' && !Array.isArray(value)) {
          extractNumbers(value as Record<string, unknown>, fullKey);
        }
      }
    };

    extractNumbers(result.data);

    if (Object.keys(metricsData).length > 0) {
      // Ring buffer: remove oldest first to avoid memory spikes
      if (this.history.length >= MAX_HISTORY) {
        this.history.shift();
      }
      this.history.push({
        timestamp: new Date().toISOString(),
        worker: workerName,
        metrics: metricsData,
      });
    }
  }

  /**
   * Get historical metrics for a worker
   */
  getHistory(worker?: string, limit = 100): HistoricalMetric[] {
    let filtered = this.history;
    if (worker) {
      filtered = this.history.filter((h) => h.worker === worker);
    }
    return filtered.slice(-limit);
  }

  // =========================================================================
  // Statusline Integration
  // =========================================================================

  /**
   * Generate statusline data
   */
  getStatuslineData(): StatuslineData {
    const workers = Array.from(this.metrics.values());
    const activeWorkers = workers.filter((w) => w.status === 'running').length;
    const errorWorkers = workers.filter((w) => w.status === 'error').length;
    const totalWorkers = workers.filter((w) => w.status !== 'disabled').length;

    const healthResult = this.metrics.get('health')?.lastResult as
      | Record<string, unknown>
      | undefined;
    const securityResult = this.metrics.get('security')?.lastResult as
      | Record<string, unknown>
      | undefined;
    const dddResult = this.metrics.get('ddd')?.lastResult as Record<string, unknown> | undefined;

    return {
      workers: {
        active: activeWorkers,
        total: totalWorkers,
        errors: errorWorkers,
      },
      health: {
        status: (healthResult?.status as 'healthy' | 'warning' | 'critical') ?? 'healthy',
        memory: ((healthResult?.memory as Record<string, unknown>)?.usedPct as number) ?? 0,
        disk: ((healthResult?.disk as Record<string, unknown>)?.usedPct as number) ?? 0,
      },
      security: {
        status: toSecurityStatus(securityResult?.status),
        issues: (securityResult?.totalIssues as number) ?? 0,
      },
      ddd: {
        progress: (dddResult?.progress as number) ?? 0,
      },
      alerts: this.alerts.filter((a) => a.severity === AlertSeverity.Critical).slice(-5),
      lastUpdate: new Date().toISOString(),
    };
  }

  /**
   * Export statusline data to file (for shell consumption)
   */
  async exportStatusline(): Promise<void> {
    try {
      const data = this.getStatuslineData();
      await fs.writeFile(this.statuslinePath, JSON.stringify(data, null, 2));
      this.emit('statusline:exported');
    } catch {
      // Ignore export errors
    }
  }

  /**
   * Generate shell-compatible statusline string
   */
  getStatuslineString(): string {
    const data = this.getStatuslineData();
    const parts: string[] = [];

    // Workers status
    parts.push(`👷${data.workers.active}/${data.workers.total}`);

    // Health
    const healthIcon =
      data.health.status === 'critical' ? '🔴' : data.health.status === 'warning' ? '🟡' : '🟢';
    parts.push(`${healthIcon}${data.health.memory}%`);

    // Security. 'incomplete' gets its own icon: the shield reads as "all
    // clear", which is exactly the claim an unfinished scan cannot make.
    const secIcon =
      data.security.status === 'critical'
        ? '🚨'
        : data.security.status === 'warning'
          ? '⚠️'
          : data.security.status === 'incomplete'
            ? '❔'
            : '🛡️';
    parts.push(`${secIcon}${data.security.issues}`);

    // DDD Progress
    parts.push(`🏗️${data.ddd.progress}%`);

    return parts.join(' │ ');
  }

  async ensureMetricsDir(): Promise<void> {
    try {
      await fs.mkdir(this.metricsDir, { recursive: true });
    } catch (e) {
      if (process.env.DEBUG || process.env.MONOMIND_DEBUG)
        console.error('[ensureMetricsDir] failed to create metrics dir:', e);
    }
  }
}
