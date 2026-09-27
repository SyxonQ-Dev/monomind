/**
 * CLI Route Command
 * Task-to-agent routing through the central picker (`monomind pick`'s ranking)
 * with outcome tracking.
 */

import { output } from '../output.js';
import type { Command, CommandContext, CommandResult } from '../types.js';
import { coverageRouteCommand } from './route-coverage.js';
import {
  exportCommand,
  feedbackCommand,
  importCommand,
  resetCommand,
  statsCommand,
} from './route-outcome-commands.js';
import {
  listAgentsCommand,
  routeTaskCommand,
  semanticRouteCommand,
} from './route-task-commands.js';

// ============================================================================
// Main Route Command
// ============================================================================

export const routeCommand: Command = {
  name: 'route',
  description: 'Task-to-agent routing through the central picker, with outcome tracking',
  subcommands: [
    routeTaskCommand,
    semanticRouteCommand,
    listAgentsCommand,
    statsCommand,
    feedbackCommand,
    resetCommand,
    exportCommand,
    importCommand,
    coverageRouteCommand,
  ],
  options: [
    {
      name: 'keyword',
      short: 'k',
      description: 'Accepted for compatibility; routing always uses the central picker',
      type: 'boolean',
      default: true,
    },
    {
      name: 'agent',
      short: 'a',
      description: 'Force specific agent',
      type: 'string',
    },
  ],
  examples: [
    { command: 'monomind route "implement feature"', description: 'Route task to best agent' },
    { command: 'monomind route "write tests"', description: 'Route test task to tester agent' },
    { command: 'monomind route --agent coder "fix bug"', description: 'Force specific agent' },
    { command: 'monomind route list-agents', description: 'List available agents' },
    { command: 'monomind route stats', description: 'Show routing statistics' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    // If task description provided directly, route it
    if (ctx.args.length > 0 && routeTaskCommand.action) {
      const result = await routeTaskCommand.action(ctx);
      if (result) return result;
      return { success: true };
    }

    // Show help
    output.writeln();
    output.writeln(output.bold('Agent Router'));
    output.writeln(output.dim('Task-to-agent routing with outcome tracking'));
    output.writeln();

    output.writeln('Usage: monomind route <task> [options]');
    output.writeln('       monomind route <subcommand>');
    output.writeln();

    output.writeln(output.bold('Subcommands:'));
    output.printList([
      `${output.highlight('task')}         - Route a task to optimal agent`,
      `${output.highlight('list-agents')}  - List available agent types`,
      `${output.highlight('stats')}        - Show routing accuracy and adherence`,
      `${output.highlight('feedback')}     - Record routing outcome`,
      `${output.highlight('reset')}        - Clear outcome history`,
      `${output.highlight('export')}       - Export route outcomes`,
      `${output.highlight('import')}       - Import route outcomes`,
    ]);
    output.writeln();

    output.writeln(output.bold('How It Works:'));
    output.printList([
      'Routes tasks to registry agents with the same ranking as `monomind pick`',
      'Records outcomes in route-outcomes.jsonl',
      'Tracks accuracy and adherence over time',
      'Provides confidence scores and alternatives',
    ]);
    output.writeln();

    output.writeln(output.bold('Backend Status:'));
    output.printList([
      `Routing: ${output.success('central picker (Jev when configured, keyword fallback)')}`,
      `Learning: trajectory recording + outcome correlation`,
    ]);
    output.writeln();

    output.writeln(output.dim('Run "monomind route <subcommand> --help" for more info'));

    return { success: true };
  },
};

export default routeCommand;
