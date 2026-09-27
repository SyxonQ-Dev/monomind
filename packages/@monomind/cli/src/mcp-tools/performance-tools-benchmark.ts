/**
 * Performance MCP Tools — benchmark and profile.
 * Extracted from performance-tools.ts.
 */

import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type Benchmark,
  ensurePerfDir,
  getPerfDir,
  loadPerfStore,
  savePerfStore,
} from './performance-tools-store.js';
import type { MCPTool } from './types.js';

export const performanceBenchmarkTools: MCPTool[] = [
  {
    name: 'performance_benchmark',
    description: 'Run performance benchmarks',
    category: 'performance',
    inputSchema: {
      type: 'object',
      properties: {
        suite: {
          type: 'string',
          enum: ['all', 'memory', 'neural', 'monoswarm', 'io'],
          description: 'Benchmark suite',
        },
        iterations: { type: 'number', description: 'Number of iterations' },
        warmup: { type: 'boolean', description: 'Include warmup phase' },
      },
    },
    handler: async (input) => {
      const store = loadPerfStore();
      // Validate suite against enum to prevent uncapped string from being stored
      // as a benchmark key on disk.
      const VALID_SUITES = new Set(['all', 'memory', 'neural', 'monoswarm', 'io']);
      const rawSuite = (input.suite as string) || 'all';
      const suite = VALID_SUITES.has(rawSuite) ? rawSuite : 'all';
      // Cap iterations to prevent event-loop blocking DoS.  The `neural`
      // suite runs an O(n³) 64×64 matrix multiply per iteration; at 10 000
      // iterations it already completes in milliseconds.  Uncapped, a caller
      // could pass iterations=9_999_999 and block the process for minutes.
      const MAX_BENCHMARK_ITERATIONS = 10_000;
      const rawIterations = typeof input.iterations === 'number' ? input.iterations : 100;
      const iterations =
        Number.isFinite(rawIterations) && rawIterations > 0
          ? Math.min(Math.floor(rawIterations), MAX_BENCHMARK_ITERATIONS)
          : 100;
      const warmup = input.warmup !== false;

      // REAL benchmark functions
      const benchmarkFunctions: Record<string, () => void> = {
        memory: () => {
          // Real memory allocation benchmark
          const arr = new Array(1000).fill(0).map(() => Math.random());
          arr.sort();
        },
        neural: () => {
          // Real computation benchmark (matrix-like operations)
          const size = 64;
          const a = Array.from({ length: size }, () =>
            Array.from({ length: size }, () => Math.random()),
          );
          const b = Array.from({ length: size }, () =>
            Array.from({ length: size }, () => Math.random()),
          );
          // Simple matrix multiplication
          for (let i = 0; i < size; i++) {
            for (let j = 0; j < size; j++) {
              let _sum = 0;
              for (let k = 0; k < size; k++) _sum += a[i][k] * b[k][j];
            }
          }
        },
        monoswarm: () => {
          // Real object creation and manipulation
          const agents = Array.from({ length: 10 }, (_, i) => ({
            id: i,
            status: 'active',
            tasks: [] as number[],
          }));
          agents.forEach((a) => {
            for (let i = 0; i < 100; i++) a.tasks.push(i);
          });
          agents.sort((a, b) => a.tasks.length - b.tasks.length);
        },
        io: () => {
          // Real JSON serialization benchmark
          const data = {
            agents: Array.from({ length: 50 }, (_, i) => ({ id: i, name: `agent-${i}` })),
          };
          const json = JSON.stringify(data);
          JSON.parse(json);
        },
      };

      const results: Array<{
        name: string;
        opsPerSec: number;
        avgLatency: string;
        memoryUsage: string;
        _real: boolean;
      }> = [];
      const suitesToRun = suite === 'all' ? Object.keys(benchmarkFunctions) : [suite];

      // Warmup phase
      if (warmup) {
        for (const suiteName of suitesToRun) {
          const fn = benchmarkFunctions[suiteName];
          if (fn) for (let i = 0; i < 10; i++) fn();
        }
      }

      // Real benchmarks with actual timing
      for (const suiteName of suitesToRun) {
        const fn = benchmarkFunctions[suiteName];
        if (fn) {
          const memBefore = process.memoryUsage().heapUsed;
          const startTime = performance.now();

          for (let i = 0; i < iterations; i++) fn();

          const endTime = performance.now();
          const memAfter = process.memoryUsage().heapUsed;

          const durationMs = endTime - startTime;
          const opsPerSec = Math.round((iterations / durationMs) * 1000);
          const avgLatencyMs = durationMs / iterations;
          const memoryDelta = Math.round((memAfter - memBefore) / 1024);

          const id = `bench-${suiteName}-${Date.now()}`;
          const result: Benchmark = {
            id,
            name: suiteName,
            type: 'performance',
            results: {
              duration: durationMs / 1000,
              iterations,
              opsPerSecond: opsPerSec,
              memory: Math.max(0, memoryDelta),
            },
            createdAt: new Date().toISOString(),
          };

          store.benchmarks[id] = result;

          // Evict oldest entries if over limit
          const MAX_BENCHMARKS = 200;
          const benchEntries = Object.entries(store.benchmarks).sort(([, a], [, b]) =>
            a.createdAt < b.createdAt ? -1 : 1,
          );
          if (benchEntries.length > MAX_BENCHMARKS) {
            store.benchmarks = Object.fromEntries(
              benchEntries.slice(-MAX_BENCHMARKS),
            ) as typeof store.benchmarks;
          }

          results.push({
            name: suiteName,
            opsPerSec,
            avgLatency: `${avgLatencyMs.toFixed(3)}ms`,
            memoryUsage: `${Math.abs(memoryDelta)}KB`,
            _real: true,
          });
        }
      }

      savePerfStore(store);

      // Calculate comparison vs previous benchmarks
      const runStart = new Date().toISOString();
      const allBenchmarks = Object.values(store.benchmarks);
      const previousBenchmarks = allBenchmarks
        .filter((b) => suitesToRun.includes(b.name) && b.createdAt < runStart)
        .slice(-suitesToRun.length);

      const comparison =
        previousBenchmarks.length > 0
          ? {
              vsPrevious: `${results.reduce((sum, r) => sum + r.opsPerSec, 0) > previousBenchmarks.reduce((sum, b) => sum + b.results.opsPerSecond, 0) ? '+' : ''}${Math.round((results.reduce((sum, r) => sum + r.opsPerSec, 0) / previousBenchmarks.reduce((sum, b) => sum + b.results.opsPerSecond, 0) - 1) * 100)}% vs previous`,
              totalBenchmarks: allBenchmarks.length,
            }
          : {
              note: 'First benchmark run - no comparison available',
              totalBenchmarks: allBenchmarks.length,
            };

      return {
        _real: true,
        suite,
        iterations,
        warmup,
        results,
        comparison,
        timestamp: new Date().toISOString(),
      };
    },
  },
  {
    name: 'performance_profile',
    description: 'Profile specific component or operation',
    category: 'performance',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Component to profile' },
        duration: { type: 'number', description: 'Profile duration in seconds' },
        sampleRate: { type: 'number', description: 'Sampling rate' },
      },
    },
    handler: async (input) => {
      // Validate target against enum to prevent arbitrary string from being
      // stored in the perf store and echoed in the response.
      const VALID_PROFILE_TARGETS = new Set(['all', 'memory', 'io', 'cpu']);
      const rawTarget = (input.target as string) || 'all';
      const target = VALID_PROFILE_TARGETS.has(rawTarget) ? rawTarget : 'all';
      const durationSec = Math.min((input.duration as number) || 1, 10);
      const durationMs = durationSec * 1000;

      const cpuBefore = process.cpuUsage();
      const memBefore = process.memoryUsage();
      const wallStart = performance.now();

      // Profile operations keyed by name
      const ops: Record<string, { totalMs: number; count: number }> = {};
      const runOp = (name: string, fn: () => void) => {
        const t0 = performance.now();
        fn();
        const elapsed = performance.now() - t0;
        if (!ops[name]) ops[name] = { totalMs: 0, count: 0 };
        ops[name].totalMs += elapsed;
        ops[name].count += 1;
      };

      const targets = target === 'all' ? ['memory', 'io', 'cpu'] : [target];
      const deadline = wallStart + durationMs;
      // Cap I/O operations to prevent the io target from saturating disk/event loop
      const MAX_IO_OPS = 1000;
      let ioOps = 0;

      while (performance.now() < deadline) {
        for (const t of targets) {
          if (performance.now() >= deadline) break;
          if (t === 'memory') {
            runOp('json-serialize', () => {
              const d = Array.from({ length: 200 }, (_, i) => ({ id: i, v: Math.random() }));
              JSON.stringify(d);
            });
            runOp('json-parse', () => {
              JSON.parse(JSON.stringify({ a: 1, b: [2, 3], c: { d: 4 } }));
            });
            runOp('array-sort', () => {
              const a = Array.from({ length: 500 }, () => Math.random());
              a.sort();
            });
          } else if (t === 'io') {
            if (ioOps >= MAX_IO_OPS) continue;
            runOp('file-write', () => {
              ensurePerfDir();
              writeFileSync(join(getPerfDir(), '.profile-probe'), 'x'.repeat(1024));
            });
            runOp('file-read', () => {
              try {
                readFileSync(join(getPerfDir(), '.profile-probe'));
              } catch {
                /* ok */
              }
            });
            ioOps += 2;
          } else if (t === 'cpu') {
            runOp('matrix-mult', () => {
              const s = 32;
              const a = Array.from({ length: s }, () =>
                Array.from({ length: s }, () => Math.random()),
              );
              for (let i = 0; i < s; i++)
                for (let j = 0; j < s; j++) {
                  let _sum = 0;
                  for (let k = 0; k < s; k++) _sum += a[i][k] * a[k][j];
                }
            });
            runOp('hash-compute', () => {
              let h = 0;
              for (let i = 0; i < 10000; i++) h = ((h << 5) - h + i) | 0;
            });
          }
        }
      }

      const wallEnd = performance.now();
      const cpuAfter = process.cpuUsage(cpuBefore);
      const memAfter = process.memoryUsage();
      const actualDuration = Math.round((wallEnd - wallStart) * 100) / 100;
      const totalOpMs = Object.values(ops).reduce((s, o) => s + o.totalMs, 0);

      const hotspots = Object.entries(ops)
        .map(([operation, data]) => ({
          operation,
          avgLatencyMs: Math.round((data.totalMs / data.count) * 1000) / 1000,
          opsCount: data.count,
          percentOfTotal: Math.round((data.totalMs / (totalOpMs || 1)) * 10000) / 100,
        }))
        .sort((a, b) => b.percentOfTotal - a.percentOfTotal);

      // Cleanup probe file
      try {
        unlinkSync(join(getPerfDir(), '.profile-probe'));
      } catch {
        /* ok */
      }

      return {
        success: true,
        _real: true,
        target,
        duration: actualDuration,
        cpu: {
          userMs: Math.round(cpuAfter.user / 1000),
          systemMs: Math.round(cpuAfter.system / 1000),
          percentUtilization:
            Math.round(((cpuAfter.user + cpuAfter.system) / 1000 / actualDuration) * 10000) / 100,
        },
        memory: {
          heapDeltaMB:
            Math.round(((memAfter.heapUsed - memBefore.heapUsed) / 1024 / 1024) * 100) / 100,
          externalDeltaMB:
            Math.round(((memAfter.external - memBefore.external) / 1024 / 1024) * 100) / 100,
        },
        hotspots,
      };
    },
  },
];
