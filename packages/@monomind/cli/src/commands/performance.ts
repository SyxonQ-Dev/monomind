/**
 * CLI Performance Command
 * Performance profiling, benchmarking, optimization, metrics
 *
 * github.com/monoes/monomind
 */

import { output } from '../output.js';
import type { Command, CommandResult } from '../types.js';
import { benchmarkCommand } from './performance-benchmark.js';
import { bottleneckCommand } from './performance-bottleneck.js';
import { metricsCommand } from './performance-metrics.js';
import { profileCommand } from './performance-profile.js';

export { benchmarkCommand } from './performance-benchmark.js';
export { bottleneckCommand } from './performance-bottleneck.js';
export { metricsCommand } from './performance-metrics.js';
export { profileCommand } from './performance-profile.js';

// Main performance command
export const performanceCommand: Command = {
  name: 'performance',
  description: 'Performance profiling, benchmarking, optimization, metrics',
  aliases: ['perf'],
  subcommands: [benchmarkCommand, profileCommand, metricsCommand, bottleneckCommand],
  examples: [
    { command: 'monomind performance benchmark', description: 'Run benchmarks' },
    { command: 'monomind performance profile', description: 'Profile application' },
    { command: 'monomind perf metrics', description: 'View metrics (alias)' },
  ],
  action: async (): Promise<CommandResult> => {
    output.writeln();
    output.writeln(output.bold('MonoMind Performance Suite'));
    output.writeln(output.dim('Advanced performance profiling and optimization'));
    output.writeln();
    output.writeln('Subcommands:');
    output.printList([
      'benchmark  - Run performance benchmarks (WASM, neural, search)',
      'profile    - Profile CPU, memory, I/O usage',
      'metrics    - View and export performance metrics',
      'bottleneck - Identify performance bottlenecks',
    ]);
    output.writeln();
    output.writeln('Performance Targets:');
    output.printList([
      'HNSW Search: O(log n) vs O(n) brute force (pure-JS)',
      'Memory: 50-75% reduction with quantization',
    ]);
    output.writeln();
    output.writeln(output.dim('github.com/monoes/monomind'));
    return { success: true };
  },
};

export default performanceCommand;
