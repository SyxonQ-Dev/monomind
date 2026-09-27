/**
 * CLI Status Command
 * System status display for Monomind
 */

import { output } from '../output.js';
import type { Command, CommandContext, CommandResult } from '../types.js';
import { agentsCommand } from './status-agents.js';
import { displayStatus } from './status-display.js';
import { performHealthCheck } from './status-health-check.js';
import { DEFAULT_WATCH_INTERVAL, isInitialized } from './status-helpers.js';
import { memoryCommand } from './status-memory.js';
import { getSystemStatus } from './status-system.js';
import { tasksCommand } from './status-tasks.js';
import { watchStatus } from './status-watch.js';

// Main status action
const statusAction = async (ctx: CommandContext): Promise<CommandResult> => {
  const watch = ctx.flags.watch as boolean;
  const rawInterval = (ctx.flags.interval as number) || DEFAULT_WATCH_INTERVAL / 1000;
  const interval = Number.isFinite(rawInterval)
    ? Math.max(1, Math.min(rawInterval, 3600))
    : DEFAULT_WATCH_INTERVAL / 1000;
  const healthCheck = ctx.flags['health-check'] as boolean;
  const cwd = ctx.cwd;

  // Check initialization
  if (!isInitialized(cwd)) {
    output.printError('MonoMind is not initialized in this directory');
    output.printInfo('Run "monomind init" to initialize');
    return { success: false, exitCode: 1 };
  }

  // Get status
  const status = await getSystemStatus(cwd);

  // Health check mode
  if (healthCheck) {
    return performHealthCheck(status);
  }

  // JSON output
  if (ctx.flags.json === true || ctx.flags.format === 'json') {
    output.printJson(status);
    return { success: true, data: status };
  }

  // Watch mode
  if (watch) {
    return watchStatus(interval, cwd);
  }

  // Single status display
  await displayStatus(status);

  return { success: true, data: status };
};

// Main status command
export const statusCommand: Command = {
  name: 'status',
  description: 'Show system status',
  subcommands: [agentsCommand, tasksCommand, memoryCommand],
  options: [
    {
      name: 'watch',
      short: 'w',
      description: 'Watch mode - continuously update status',
      type: 'boolean',
      default: false,
    },
    {
      name: 'interval',
      short: 'i',
      description: 'Watch mode update interval in seconds',
      type: 'number',
      default: 2,
    },
    {
      name: 'health-check',
      description: 'Perform health checks and exit',
      type: 'boolean',
      default: false,
    },
    {
      name: 'json',
      description: 'Output status as JSON (alias for --format json)',
      type: 'boolean',
      default: false,
    },
  ],
  examples: [
    { command: 'monomind status', description: 'Show current system status' },
    { command: 'monomind status --watch', description: 'Watch mode with live updates' },
    { command: 'monomind status --watch -i 5', description: 'Watch mode updating every 5 seconds' },
    { command: 'monomind status --health-check', description: 'Run health checks' },
    { command: 'monomind status --json', description: 'Output status as JSON' },
    { command: 'monomind status agents', description: 'Show detailed agent status' },
    { command: 'monomind status tasks', description: 'Show detailed task status' },
    { command: 'monomind status memory', description: 'Show detailed memory status' },
  ],
  action: statusAction,
};

export default statusCommand;
