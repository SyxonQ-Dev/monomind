/**
 * Performance MCP Tools — optimize and metrics.
 * Extracted from performance-tools.ts.
 */

import { readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { ensurePerfDir, getPerfDir, loadPerfStore } from './performance-tools-store.js';
import type { MCPTool } from './types.js';

export const performanceOptimizeTools: MCPTool[] = [
  {
    name: 'performance_optimize',
    description:
      'Rule-based recommendation engine over real system metrics; only GC collection and probe-file cleanup are actually applied automatically — everything else is a suggestion',
    category: 'performance',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          enum: ['memory', 'latency', 'throughput', 'all'],
          description: 'Optimization target',
        },
        aggressive: { type: 'boolean', description: 'Apply aggressive optimizations' },
      },
    },
    handler: async (input) => {
      // Validate target against enum — the value is echoed in the response and
      // stored to the perf store; an unvalidated string could inflate disk state.
      const VALID_OPT_TARGETS = new Set(['all', 'memory', 'latency', 'throughput']);
      const rawOptTarget = (input.target as string) || 'all';
      const target = VALID_OPT_TARGETS.has(rawOptTarget) ? rawOptTarget : 'all';
      const aggressive = input.aggressive === true;

      // Snapshot system state BEFORE optimizations
      const loadBefore = os.loadavg();
      const cpusBefore = os.cpus();
      const cpuPercentBefore = Math.min((loadBefore[0] / cpusBefore.length) * 100, 100);
      const memBefore = process.memoryUsage();
      const memMBBefore = Math.round((memBefore.heapUsed / 1024 / 1024) * 100) / 100;

      let diskLatencyBefore = -1;
      try {
        ensurePerfDir();
        const probe = join(getPerfDir(), '.opt-probe');
        const t0 = performance.now();
        writeFileSync(probe, Buffer.alloc(4096, 0x42));
        readFileSync(probe);
        diskLatencyBefore = Math.round((performance.now() - t0) * 100) / 100;
        try {
          unlinkSync(probe);
        } catch {
          /* ok */
        }
      } catch {
        /* ok */
      }

      const optimizations: Array<{
        action: string;
        applied: boolean;
        effect?: string;
        recommendation?: string;
      }> = [];
      const targets = target === 'all' ? ['memory', 'latency', 'throughput'] : [target];

      for (const t of targets) {
        if (t === 'memory') {
          if (aggressive && typeof global.gc === 'function') {
            const heapBefore = process.memoryUsage().heapUsed;
            global.gc();
            const heapAfter = process.memoryUsage().heapUsed;
            const freedMB = Math.round(((heapBefore - heapAfter) / 1024 / 1024) * 100) / 100;
            optimizations.push({
              action: 'gc-collect',
              applied: true,
              effect: `Freed ${freedMB}MB heap`,
            });
          } else if (aggressive) {
            optimizations.push({
              action: 'gc-collect',
              applied: false,
              recommendation: 'Run with --expose-gc to enable forced garbage collection',
            });
          }
          const memPercent = ((os.totalmem() - os.freemem()) / os.totalmem()) * 100;
          if (memPercent > 75) {
            optimizations.push({
              action: 'recommend-memory-cleanup',
              applied: false,
              recommendation: `Memory at ${Math.round(memPercent)}% - consider reducing in-memory caches or agent count`,
            });
          }
          optimizations.push({
            action: 'recommend-hnsw-rebuild',
            applied: false,
            recommendation: 'Rebuild HNSW index to reclaim fragmented memory',
          });
        }

        if (t === 'latency') {
          if (diskLatencyBefore > 20) {
            optimizations.push({
              action: 'recommend-ssd',
              applied: false,
              recommendation: `Disk I/O latency ${diskLatencyBefore}ms is high - ensure storage is SSD-backed`,
            });
          }
          optimizations.push({
            action: 'recommend-batch-io',
            applied: false,
            recommendation: 'Batch file operations to reduce syscall overhead',
          });
        }

        if (t === 'throughput') {
          const coreCount = cpusBefore.length;
          const batchSize = Math.max(2, Math.floor(coreCount / 2));
          optimizations.push({
            action: 'recommend-batch-size',
            applied: false,
            recommendation: `Use batch size ${batchSize} for ${coreCount} CPU cores`,
          });
          if (cpuPercentBefore > 70) {
            optimizations.push({
              action: 'recommend-throttle',
              applied: false,
              recommendation: `CPU at ${Math.round(cpuPercentBefore)}% - throttle concurrent agents to avoid contention`,
            });
          }
        }
      }

      // If aggressive, clear perf probe files
      if (aggressive) {
        try {
          const dir = getPerfDir();
          const probes = readdirSync(dir).filter((f: string) => f.startsWith('.'));
          probes.forEach((f: string) => {
            try {
              unlinkSync(join(dir, f));
            } catch {
              /* ok */
            }
          });
          if (probes.length > 0)
            optimizations.push({
              action: 'clear-probe-files',
              applied: true,
              effect: `Removed ${probes.length} probe file(s)`,
            });
        } catch {
          /* ok */
        }
      }

      // Snapshot AFTER
      const memAfter = process.memoryUsage();
      const loadAfter = os.loadavg();

      return {
        success: true,
        _real: true,
        _recommendationEngine:
          'rule-based (static thresholds on real cpu/memory/disk readings) — not ML-based',
        target,
        aggressive,
        before: {
          cpuPercent: Math.round(cpuPercentBefore * 10) / 10,
          memoryMB: memMBBefore,
          diskLatencyMs: diskLatencyBefore,
        },
        optimizations,
        after: {
          cpuPercent: Math.round(Math.min((loadAfter[0] / cpusBefore.length) * 100, 100) * 10) / 10,
          memoryMB: Math.round((memAfter.heapUsed / 1024 / 1024) * 100) / 100,
          diskLatencyMs: diskLatencyBefore, // same measurement window
        },
      };
    },
  },
  {
    name: 'performance_metrics',
    description: 'Get detailed performance metrics',
    category: 'performance',
    inputSchema: {
      type: 'object',
      properties: {
        metric: {
          type: 'string',
          enum: ['cpu', 'memory', 'latency', 'throughput', 'all'],
          description: 'Metric type',
        },
        aggregation: {
          type: 'string',
          enum: ['avg', 'min', 'max', 'p50', 'p95', 'p99'],
          description: 'Aggregation method',
        },
        timeRange: { type: 'string', description: 'Time range' },
      },
    },
    handler: async (input) => {
      // Validate metric and aggregation against their enums.  Both values are
      // later used as property index keys on plain objects — an attacker who
      // passes "__proto__" or "constructor" could cause prototype pollution.
      const VALID_METRICS = new Set(['cpu', 'memory', 'latency', 'throughput', 'all']);
      const VALID_AGGREGATIONS = new Set(['avg', 'min', 'max', 'p50', 'p95', 'p99']);
      const rawMetric = (input.metric as string) || 'all';
      const metric = VALID_METRICS.has(rawMetric) ? rawMetric : 'all';
      const rawAggregation = (input.aggregation as string) || 'avg';
      const aggregation = VALID_AGGREGATIONS.has(rawAggregation) ? rawAggregation : 'avg';

      // Get REAL system metrics
      const memUsage = process.memoryUsage();
      const loadAvg = os.loadavg();
      const cpus = os.cpus();
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const store = loadPerfStore();

      // Calculate real CPU percentage from load average
      const cpuPercent = Math.min((loadAvg[0] / cpus.length) * 100, 100);
      const memUsedMB = Math.round((totalMem - freeMem) / 1024 / 1024);
      const memTotalMB = Math.round(totalMem / 1024 / 1024);
      const heapMB = Math.round(memUsage.heapUsed / 1024 / 1024);

      // Calculate statistics from stored history
      const history = store.metrics.slice(-100);
      const cpuHistory = history.map((m) => m.cpu.usage);
      const memHistory = history.map((m) => m.memory.used);

      const calcStats = (arr: number[], current: number) => {
        if (arr.length === 0)
          return {
            current,
            avg: current,
            min: current,
            max: current,
            p50: current,
            p95: current,
            p99: current,
          };
        const sorted = [...arr].sort((a, b) => a - b);
        return {
          current,
          avg: arr.reduce((s, v) => s + v, 0) / arr.length,
          min: Math.min(...arr),
          max: Math.max(...arr),
          p50: sorted[Math.floor(sorted.length * 0.5)],
          p95: sorted[Math.floor(sorted.length * 0.95)],
          p99: sorted[Math.floor(sorted.length * 0.99)],
        };
      };

      const cpuStats = calcStats(cpuHistory, cpuPercent);
      const memStats = calcStats(memHistory, memUsedMB);

      const allMetrics = {
        cpu: {
          ...cpuStats,
          unit: '%',
          cores: cpus.length,
          model: cpus[0]?.model,
          loadAverage: loadAvg,
          _real: true,
        },
        memory: {
          ...memStats,
          total: memTotalMB,
          heap: heapMB,
          heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
          external: Math.round(memUsage.external / 1024 / 1024),
          unit: 'MB',
          _real: true,
        },
        latency: {
          _note:
            'No latency telemetry collected. Wire up real instrumentation to populate this section.',
          available: false,
        },
        throughput: {
          _note:
            'No throughput telemetry collected. Wire up real instrumentation to populate this section.',
          available: false,
        },
      };

      if (metric === 'all') {
        return {
          _real: true,
          metrics: allMetrics,
          aggregation,
          historySize: history.length,
          timestamp: new Date().toISOString(),
        };
      }

      // Use Object.hasOwn to prevent prototype chain traversal when indexing
      // by caller-supplied metric/aggregation strings.
      const selectedMetric = Object.hasOwn(allMetrics, metric)
        ? allMetrics[metric as keyof typeof allMetrics]
        : allMetrics.cpu;
      const aggValue = Object.hasOwn(selectedMetric, aggregation)
        ? selectedMetric[aggregation as keyof typeof selectedMetric]
        : undefined;
      return {
        _real: ['cpu', 'memory'].includes(metric),
        metric,
        value: aggValue,
        unit: 'unit' in selectedMetric ? selectedMetric.unit : undefined,
        details: selectedMetric,
        timestamp: new Date().toISOString(),
      };
    },
  },
];
