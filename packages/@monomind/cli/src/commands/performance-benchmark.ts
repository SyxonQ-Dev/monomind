import { output } from '../output.js';
import type { Command, CommandContext, CommandResult } from '../types.js';

// Benchmark subcommand - REAL measurements
export const benchmarkCommand: Command = {
  name: 'benchmark',
  description: 'Run performance benchmarks',
  options: [
    {
      name: 'suite',
      short: 's',
      type: 'string',
      description: 'Benchmark suite: all, wasm, neural, memory, search',
      default: 'all',
    },
    {
      name: 'iterations',
      short: 'i',
      type: 'number',
      description: 'Number of iterations',
      default: '100',
    },
    { name: 'warmup', short: 'w', type: 'number', description: 'Warmup iterations', default: '10' },
    {
      name: 'output',
      short: 'o',
      type: 'string',
      description: 'Output format: text, json',
      default: 'text',
    },
  ],
  examples: [
    {
      command: 'monomind performance benchmark -s neural',
      description: 'Benchmark neural operations',
    },
    { command: 'monomind performance benchmark -i 1000', description: 'Run with 1000 iterations' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const suiteRaw = (ctx.flags.suite as string) || 'all';
    const VALID_SUITES = new Set(['all', 'wasm', 'neural', 'memory', 'search']);
    const suite = VALID_SUITES.has(suiteRaw) ? suiteRaw : 'all';
    // Falling back is fine; doing it silently is not. `--suite quick` used to
    // print "Running all benchmarks" and produce a full run, so the user's
    // explicit choice was discarded with no indication it had been ignored.
    if (suiteRaw !== suite) {
      output.writeln(
        output.warning(
          `Unknown benchmark suite "${suiteRaw}" — running "all" instead. ` +
            `Valid suites: ${[...VALID_SUITES].join(', ')}.`,
        ),
      );
    }
    const MAX_ITERATIONS = 10_000;
    const MAX_WARMUP = 500;
    const iterationsRaw = parseInt((ctx.flags.iterations as string) || '100', 10);
    const warmupRaw = parseInt((ctx.flags.warmup as string) || '10', 10);
    const iterations = Number.isFinite(iterationsRaw)
      ? Math.min(Math.max(1, iterationsRaw), MAX_ITERATIONS)
      : 100;
    const warmup = Number.isFinite(warmupRaw) ? Math.min(Math.max(0, warmupRaw), MAX_WARMUP) : 10;
    const outputFormatRaw = (ctx.flags.output as string) || 'text';
    const VALID_OUTPUT_FORMATS = new Set(['text', 'json']);
    const outputFormat = VALID_OUTPUT_FORMATS.has(outputFormatRaw) ? outputFormatRaw : 'text';
    if (outputFormatRaw === 'csv') {
      output.writeln(output.warning('csv output is not implemented — printing text'));
    }

    output.writeln();
    output.writeln(output.bold('Performance Benchmark (Real Measurements)'));
    output.writeln(output.dim('─'.repeat(60)));

    const spinner = output.createSpinner({
      text: `Running ${suite} benchmarks...`,
      spinner: 'dots',
    });
    spinner.start();

    // Import real implementations
    const {
      generateEmbedding,
      batchCosineSim,
      flashAttentionSearch,
      getHNSWStatus,
      storeEntry,
      searchEntries,
    } = await import('../memory/memory-initializer.js');
    const { benchmarkAdaptation, initializeIntelligence } = await import(
      '../memory/intelligence.js'
    );

    // `hasTarget: false` marks entries that only report a measured latency,
    // with no baseline to compare against — they're excluded from the
    // "all targets met" rollup instead of being scored against an invented
    // baseline constant.
    const results: {
      operation: string;
      mean: string;
      p95: string;
      p99: string;
      improvement: string;
      targetMet: boolean;
      hasTarget?: boolean;
    }[] = [];
    const startTotal = Date.now();

    // Helper to compute percentiles
    const percentile = (arr: number[], p: number) => {
      const sorted = [...arr].sort((a, b) => a - b);
      const idx = Math.ceil((p / 100) * sorted.length) - 1;
      return sorted[Math.max(0, idx)];
    };

    // 1. Embedding Generation Benchmark
    if (suite === 'all' || suite === 'neural' || suite === 'memory') {
      spinner.setText('Benchmarking embedding generation...');
      const embedTimes: number[] = [];

      // Warmup
      for (let i = 0; i < warmup; i++) {
        await generateEmbedding(`warmup text ${i}`);
      }

      // Actual measurement
      for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        await generateEmbedding(`benchmark text number ${i} with some varied content`);
        embedTimes.push(performance.now() - start);
      }

      const mean = embedTimes.reduce((a, b) => a + b, 0) / embedTimes.length;
      const embedTargetMet = mean < 10;
      results.push({
        operation: 'Embedding Gen',
        mean: `${mean.toFixed(2)}ms`,
        p95: `${percentile(embedTimes, 95).toFixed(2)}ms`,
        p99: `${percentile(embedTimes, 99).toFixed(2)}ms`,
        improvement: embedTargetMet ? output.success('Target met') : output.warning('Below target'),
        targetMet: embedTargetMet,
      });
    }

    // 2. Batch Vector Operations
    if (suite === 'all' || suite === 'wasm') {
      spinner.setText('Benchmarking batch vector ops...');
      const flashTimes: number[] = [];

      // Generate test vectors
      const testVectors: Float32Array[] = Array.from(
        { length: 100 },
        () => new Float32Array(Array.from({ length: 384 }, () => Math.random())),
      );
      const queryVector = new Float32Array(Array.from({ length: 384 }, () => Math.random()));

      // Warmup
      for (let i = 0; i < warmup; i++) {
        batchCosineSim(queryVector, testVectors);
      }

      // Actual measurement
      for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        flashAttentionSearch(queryVector, testVectors, { k: 10 });
        flashTimes.push(performance.now() - start);
      }

      const mean = flashTimes.reduce((a, b) => a + b, 0) / flashTimes.length;
      // No independent baseline implementation exists to compare against —
      // flashAttentionSearch is a thin wrapper around batchCosineSim, so
      // there's nothing slower to measure a real speedup off of. Report the
      // measured latency only, without a fabricated speedup ratio.
      results.push({
        operation: 'Batch Vector Ops',
        mean: `${mean.toFixed(3)}ms`,
        p95: `${percentile(flashTimes, 95).toFixed(3)}ms`,
        p99: `${percentile(flashTimes, 99).toFixed(3)}ms`,
        improvement: output.dim('measured (no baseline)'),
        targetMet: true,
        hasTarget: false,
      });
    }

    // 3. HNSW Search Benchmark
    if (suite === 'all' || suite === 'search') {
      spinner.setText('Benchmarking HNSW search...');
      const hnswStatus = await getHNSWStatus();

      if (hnswStatus?.available && hnswStatus.entryCount > 0) {
        const searchTimes: number[] = [];
        const testQueries = [
          'error handling patterns',
          'authentication flow',
          'database optimization',
          'API design patterns',
          'test coverage strategies',
        ];

        // Warmup
        for (const q of testQueries.slice(0, 2)) {
          await searchEntries({ query: q, limit: 10 });
        }

        // Actual measurement
        for (let i = 0; i < Math.min(iterations, 50); i++) {
          const query = testQueries[i % testQueries.length];
          const start = performance.now();
          await searchEntries({ query, limit: 10 });
          searchTimes.push(performance.now() - start);
        }

        const mean = searchTimes.reduce((a, b) => a + b, 0) / searchTimes.length;
        // No brute-force baseline is measured over the actual stored entries
        // here, so we report the measured latency only rather than a
        // speedup ratio computed against an invented per-comparison cost.
        results.push({
          operation: `HNSW Search (n=${hnswStatus.entryCount})`,
          mean: `${mean.toFixed(2)}ms`,
          p95: `${percentile(searchTimes, 95).toFixed(2)}ms`,
          p99: `${percentile(searchTimes, 99).toFixed(2)}ms`,
          improvement: output.dim('measured (no baseline)'),
          targetMet: true,
          hasTarget: false,
        });
      } else {
        results.push({
          operation: 'HNSW Search',
          mean: 'N/A',
          p95: 'N/A',
          p99: 'N/A',
          improvement: output.warning('No index'),
          targetMet: false,
        });
      }
    }

    // 4. Pattern Adaptation Benchmark (JS)
    if (suite === 'all' || suite === 'neural') {
      spinner.setText('Benchmarking pattern adaptation...');
      await initializeIntelligence();
      const sonaResult = benchmarkAdaptation(iterations);

      results.push({
        operation: 'Pattern Adaptation',
        mean: `${(sonaResult.avgMs * 1000).toFixed(2)}μs`,
        p95: `${(sonaResult.maxMs * 1000).toFixed(2)}μs`,
        p99: `${(sonaResult.maxMs * 1000).toFixed(2)}μs`,
        improvement: sonaResult.targetMet
          ? output.success('<0.05ms ✓')
          : output.warning('Above target'),
        targetMet: sonaResult.targetMet,
      });
    }

    // 5. Memory Store/Retrieve
    if (suite === 'all' || suite === 'memory') {
      spinner.setText('Benchmarking memory operations...');
      const storeTimes: number[] = [];

      // Use in-memory operations for benchmark (don't persist)
      for (let i = 0; i < Math.min(iterations, 20); i++) {
        const start = performance.now();
        await storeEntry({
          key: `bench_${Date.now()}_${i}`,
          value: `Benchmark test entry ${i} with some content for testing storage performance`,
          namespace: 'benchmark',
          generateEmbeddingFlag: true,
        });
        storeTimes.push(performance.now() - start);
      }

      const mean = storeTimes.reduce((a, b) => a + b, 0) / storeTimes.length;
      const storeTargetMet = mean < 50;
      results.push({
        operation: 'Memory Store+Embed',
        mean: `${mean.toFixed(1)}ms`,
        p95: `${percentile(storeTimes, 95).toFixed(1)}ms`,
        p99: `${percentile(storeTimes, 99).toFixed(1)}ms`,
        improvement: storeTargetMet ? output.success('Target met') : output.warning('Slow'),
        targetMet: storeTargetMet,
      });
    }

    const totalTime = ((Date.now() - startTotal) / 1000).toFixed(2);
    spinner.succeed(`Completed ${iterations} iterations in ${totalTime}s`);

    // Output results
    if (outputFormat === 'json') {
      output.printJson({ suite, iterations, totalTime: `${totalTime}s`, results });
    } else {
      output.writeln();
      output.printTable({
        columns: [
          { key: 'operation', header: 'Operation', width: 22 },
          { key: 'mean', header: 'Mean', width: 12 },
          { key: 'p95', header: 'P95', width: 12 },
          { key: 'p99', header: 'P99', width: 12 },
          { key: 'improvement', header: 'Status', width: 15 },
        ],
        data: results,
      });

      output.writeln();
      const allTargetsMet = results.filter((r) => r.hasTarget !== false).every((r) => r.targetMet);
      output.printBox(
        [
          `Suite: ${suite}`,
          `Iterations: ${iterations}`,
          `Total Time: ${totalTime}s`,
          ``,
          `Overall: ${allTargetsMet ? output.success('All targets met') : output.warning('Some targets missed')}`,
        ].join('\n'),
        'Benchmark Summary',
      );
    }

    return { success: true, data: { results, totalTime } };
  },
};
