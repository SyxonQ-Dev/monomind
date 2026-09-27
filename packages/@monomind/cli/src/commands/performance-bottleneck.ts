import { output } from '../output.js';
import type { Command, CommandContext, CommandResult } from '../types.js';

// Bottleneck subcommand
export const bottleneckCommand: Command = {
  name: 'bottleneck',
  description: 'Identify performance bottlenecks',
  options: [
    { name: 'component', short: 'c', type: 'string', description: 'Component to analyze' },
    {
      name: 'depth',
      short: 'd',
      type: 'string',
      description: 'Analysis depth: quick, full',
      default: 'quick',
    },
  ],
  examples: [
    { command: 'monomind performance bottleneck', description: 'Find bottlenecks' },
    {
      command: 'monomind performance bottleneck -c network',
      description: 'Only the Network component',
    },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    output.writeln();
    output.writeln(output.bold('Bottleneck Analysis'));
    output.writeln(output.dim('─'.repeat(50)));

    // Components this command actually knows how to inspect. Used both to
    // validate --component and to tell the user what they could have asked for.
    const ANALYZED_COMPONENTS = ['Runtime', 'Vector Search', 'Traces', 'Memory DB', 'Network'];

    // Only a single depth of analysis is implemented. Accepting `--depth full`
    // and quietly running the quick analysis discards the user's request with
    // no indication it was ignored, so say so instead.
    const depthRaw = (ctx.flags.depth as string) || 'quick';
    if (depthRaw !== 'quick') {
      output.writeln(
        output.warning(
          `--depth ${depthRaw} is not implemented — running the "quick" analysis. ` +
            `Only "quick" is supported today.`,
        ),
      );
    }

    const componentFilter = (ctx.flags.component as string)?.trim();

    const spinner = output.createSpinner({ text: 'Analyzing system...', spinner: 'dots' });
    spinner.start();

    const fs = await import('node:fs');
    const path = await import('node:path');
    const findings: {
      component: string;
      bottleneck: string;
      severity: string;
      solution: string;
    }[] = [];

    const mem = process.memoryUsage();
    const heapUsedMB = mem.heapUsed / 1024 / 1024;
    if (heapUsedMB > 200) {
      findings.push({
        component: 'Runtime',
        bottleneck: `Heap ${heapUsedMB.toFixed(0)}MB`,
        severity: output.error('High'),
        solution: 'Investigate memory leaks or increase --max-old-space-size',
      });
    }

    const configPath = 'monomind.config.json';
    let config: Record<string, unknown> = {};
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (e) {
      if (process.env.DEBUG || process.env.MONOMIND_DEBUG)
        console.error('[performance-bottleneck] failed to parse monomind.config.json:', e);
    }
    const perf = (config.performance ?? {}) as Record<string, unknown>;
    const hnsw = (perf.hnsw ?? {}) as Record<string, unknown>;
    if (!hnsw.quantization) {
      findings.push({
        component: 'Vector Search',
        bottleneck: 'No HNSW quantization',
        severity: output.error('High'),
        solution: 'Run: monomind hooks intelligence optimize --method quantize',
      });
    }

    const tracesDir = '.monomind/traces';
    if (fs.existsSync(tracesDir)) {
      try {
        const traceFiles = fs.readdirSync(tracesDir);
        if (traceFiles.length > 500) {
          findings.push({
            component: 'Traces',
            bottleneck: `${traceFiles.length} trace files`,
            severity: output.warning('Medium'),
            solution: 'Prune old traces: rm .monomind/traces/*.jsonl',
          });
        }
      } catch {
        /* ok */
      }
    }

    try {
      const { bridgeGetDbPath } = await import('../memory/memory-bridge.js');
      const dbFile = path.join(bridgeGetDbPath(), 'memory.db');
      const stat = fs.statSync(dbFile).size ?? 0;
      const sizeMB = stat / 1024 / 1024;
      if (sizeMB > 100) {
        findings.push({
          component: 'Memory DB',
          bottleneck: `SQLite ${sizeMB.toFixed(0)}MB`,
          severity: output.warning('Medium'),
          solution:
            'No automated SQLite compaction exists yet — prune stale entries with: monomind memory delete --key <key> --namespace <ns>',
        });
      }
    } catch {
      /* no memory.db yet */
    }

    const network = (perf.network ?? {}) as Record<string, unknown>;
    if (!network.batching) {
      findings.push({
        component: 'Network',
        bottleneck: 'No request batching',
        severity: output.info('Low'),
        solution:
          'No automated fix available — request batching requires a manual code change, not exposed via any CLI command yet',
      });
    }

    let results = findings;
    if (componentFilter) {
      const known =
        ANALYZED_COMPONENTS.find((c) => c.toLowerCase() === componentFilter.toLowerCase()) ??
        ANALYZED_COMPONENTS.find((c) => c.toLowerCase().includes(componentFilter.toLowerCase()));
      if (!known) {
        spinner.fail(`Unknown component "${componentFilter}"`);
        output.writeln(output.warning(`Analyzed components: ${ANALYZED_COMPONENTS.join(', ')}.`));
        return { success: false, message: `Unknown component: ${componentFilter}`, exitCode: 1 };
      }
      results = findings.filter((f) => f.component === known);
      if (results.length === 0) {
        results = [
          {
            component: known,
            bottleneck: 'No bottlenecks detected',
            severity: output.success('None'),
            solution: `${known} is performing well`,
          },
        ];
      }
    } else if (results.length === 0) {
      results = [
        {
          component: 'System',
          bottleneck: 'No bottlenecks detected',
          severity: output.success('None'),
          solution: 'System is performing well',
        },
      ];
    }

    spinner.succeed(`Analysis complete — ${results.length} finding(s)`);

    output.writeln();
    output.printTable({
      columns: [
        { key: 'component', header: 'Component', width: 20 },
        { key: 'bottleneck', header: 'Bottleneck', width: 25 },
        { key: 'severity', header: 'Severity', width: 12 },
        { key: 'solution', header: 'Solution', width: 50 },
      ],
      data: results,
    });

    return { success: true };
  },
};
