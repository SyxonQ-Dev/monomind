/**
 * Hooks Worker Command
 * Background worker management (@monoes/hooks workers). Extracted from
 * hooks-workers.ts to reduce file size.
 */

import { output } from '../output.js';
import type { Command, CommandContext, CommandResult } from '../types.js';

// =============================================================================
// Worker Commands (@monoes/hooks WorkerManager)
// =============================================================================
// The old worker subcommands (dispatch/status/detect/cancel) dispatched to a
// simulated in-memory tracker that fronted the deleted worker daemon. The
// surviving commands run the real @monoes/hooks workers in-process.

const workerListCommand: Command = {
  name: 'list',
  description: 'List all @monoes/hooks background workers',
  options: [],
  examples: [{ command: 'monomind hooks worker list', description: 'List all workers' }],
  action: async (): Promise<CommandResult> => {
    try {
      const hooks = await import('@monoes/hooks');
      const workers = Object.values(hooks.WORKER_CONFIGS).map((w) => ({
        name: w.name,
        description: w.description,
        priority: hooks.WorkerPriority[w.priority],
        enabled: w.enabled ? 'yes' : 'no',
      }));

      output.writeln();
      output.writeln(output.bold(`Background Workers (${workers.length} Total)`));
      output.writeln();
      output.printTable({
        columns: [
          { key: 'name', header: 'Worker', width: 14 },
          { key: 'priority', header: 'Priority', width: 12 },
          { key: 'enabled', header: 'Enabled', width: 8 },
          { key: 'description', header: 'Description', width: 60 },
        ],
        data: workers,
      });
      output.writeln();
      output.writeln(output.dim('Run a worker: monomind hooks worker run <name>'));

      return { success: true, data: { workers, total: workers.length } };
    } catch (error) {
      output.printError(
        `Failed to load workers: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { success: false, exitCode: 1 };
    }
  },
};

const workerRunCommand: Command = {
  name: 'run',
  description: 'Run a background worker once, in-process',
  options: [
    {
      name: 'name',
      short: 'n',
      type: 'string',
      description: 'Worker name (see: hooks worker list)',
    },
  ],
  examples: [
    {
      command: 'monomind hooks worker run map',
      description: 'Refresh .monomind/metrics/codebase-map.json',
    },
    {
      command: 'monomind hooks worker run audit',
      description: 'Refresh .monomind/metrics/security-audit.json',
    },
    {
      command: 'monomind hooks worker run ddd',
      description: 'Refresh .monomind/metrics/ddd-progress.json',
    },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const name = ctx.args[0] || (ctx.flags.name as string);

    if (!name) {
      output.printError('Worker name is required: monomind hooks worker run <name>');
      output.writeln('See available workers: monomind hooks worker list');
      return { success: false, exitCode: 1 };
    }

    const spinner = output.createSpinner({ text: `Running ${name} worker...`, spinner: 'dots' });
    spinner.start();

    try {
      const hooks = await import('@monoes/hooks');
      if (!hooks.WORKER_CONFIGS[name]) {
        spinner.fail(`Unknown worker: ${name}`);
        output.writeln(`Available workers: ${Object.keys(hooks.WORKER_CONFIGS).join(', ')}`);
        return { success: false, exitCode: 1 };
      }

      const manager = hooks.createWorkerManager(process.cwd());
      // `run` invokes a single worker standalone, outside the normal
      // session-start path — runWorker() itself does not create
      // .monomind/metrics/, so on a fresh project with no prior
      // session-start hook run, workers that write metrics files fail with
      // ENOENT. ensureMetricsDir() is the minimal piece of the manager's
      // initialize() step this command actually needs (no state load/timers).
      await manager.ensureMetricsDir();
      const result = await manager.runWorker(name);

      if (!result.success) {
        spinner.fail(`Worker ${name} failed: ${result.error || 'unknown error'}`);
        return { success: false, exitCode: 1, data: result };
      }

      spinner.succeed(`Worker ${name} completed in ${result.duration}ms`);
      if (ctx.flags.format === 'json') {
        output.printJson(result);
      } else if (result.data) {
        output.writeln(output.dim(JSON.stringify(result.data, null, 2)));
      }

      return { success: true, data: result };
    } catch (error) {
      spinner.fail('Worker run failed');
      output.printError(error instanceof Error ? error.message : String(error));
      return { success: false, exitCode: 1 };
    }
  },
};

// Worker parent command
export const workerCommand: Command = {
  name: 'worker',
  description: 'Background worker management (@monoes/hooks workers, run in-process)',
  subcommands: [workerListCommand, workerRunCommand],
  options: [],
  examples: [
    { command: 'monomind hooks worker list', description: 'List all workers' },
    { command: 'monomind hooks worker run map', description: 'Run the codebase map worker' },
  ],
  action: async (): Promise<CommandResult> => {
    output.writeln();
    output.writeln(output.bold('Background Worker System (@monoes/hooks)'));
    output.writeln();
    output.writeln('Workers run in-process and write their results to .monomind/metrics/.');
    output.writeln('The metrics-producing workers (ddd, map, audit, consolidate)');
    output.writeln('also refresh automatically at session start when their output is stale.');
    output.writeln();
    output.writeln('Subcommands:');
    output.printList([
      `${output.highlight('list')} - List all workers`,
      `${output.highlight('run')}  - Run a worker once (e.g. hooks worker run map)`,
    ]);
    output.writeln();
    output.writeln('Run "monomind hooks worker <subcommand> --help" for details');

    return { success: true };
  },
};
