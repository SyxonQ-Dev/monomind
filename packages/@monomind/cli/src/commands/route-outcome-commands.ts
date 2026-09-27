/**
 * Route subcommands for outcome history: stats, feedback, reset, export, import.
 * Split from route.ts.
 *
 * @module @monomind/cli/commands/route-outcome-commands
 */

import { output } from '../output.js';
import type { Command, CommandContext, CommandResult } from '../types.js';
import { agentName, findAgent, getRouter, registryAgents } from './route-shared.js';

// ============================================================================
// Stats Subcommand
// ============================================================================

export const statsCommand: Command = {
  name: 'stats',
  description: 'Show keyword router statistics',
  options: [
    {
      name: 'json',
      short: 'j',
      description: 'Output in JSON format',
      type: 'boolean',
      default: false,
    },
  ],
  examples: [{ command: 'monomind route stats', description: 'Show routing statistics' }],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const jsonOutput = ctx.flags.json as boolean;

    try {
      const router = await getRouter();
      const stats = await router.getStats();

      if (jsonOutput) {
        output.printJson({ stats, backend: 'keyword-routing-js' });
      } else {
        output.writeln();
        output.writeln(output.bold('Route Outcome Statistics'));
        output.writeln();

        const fmt = (v: number | null) => (v === null ? 'n/a' : `${(v * 100).toFixed(1)}%`);

        output.printTable({
          columns: [
            { key: 'metric', header: 'Metric', width: 25 },
            { key: 'value', header: 'Value', width: 20, align: 'right' },
          ],
          data: [
            { metric: 'Outcomes Recorded', value: String(stats.outcomeCount) },
            { metric: 'Accuracy', value: fmt(stats.accuracy) },
            { metric: 'Adherence', value: fmt(stats.adherence) },
            {
              metric: 'Trend (recent-prior)',
              value:
                stats.trend === null
                  ? 'n/a'
                  : `${stats.trend > 0 ? '+' : ''}${(stats.trend * 100).toFixed(1)}%`,
            },
            { metric: 'Backend', value: 'keyword-routing (JS)' },
          ],
        });
      }

      return { success: true, data: { stats } };
    } catch (error) {
      output.printError(error instanceof Error ? error.message : String(error));
      return { success: false, exitCode: 1 };
    }
  },
};

// ============================================================================
// Feedback Subcommand
// ============================================================================

export const feedbackCommand: Command = {
  name: 'feedback',
  description: 'Provide feedback on a routing decision',
  options: [
    {
      name: 'task',
      short: 't',
      description: 'Task description (context for learning)',
      type: 'string',
      required: true,
    },
    {
      name: 'agent',
      short: 'a',
      description: 'Agent that was used',
      type: 'string',
      required: true,
    },
    {
      name: 'reward',
      short: 'r',
      description: 'Reward value (-1 to 1, where 1 is best)',
      type: 'number',
      default: 0.8,
    },
    {
      name: 'next-task',
      short: 'n',
      description: 'Next task description (for multi-step learning)',
      type: 'string',
    },
  ],
  examples: [
    {
      command: 'monomind route feedback -t "implement auth" -a coder -r 0.9',
      description: 'Positive feedback',
    },
    {
      command: 'monomind route feedback -t "write tests" -a tester -r -0.5',
      description: 'Negative feedback',
    },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const rawFeedbackTask = ctx.flags.task as string;
    const agentId = ctx.flags.agent as string;
    const reward = ctx.flags.reward as number;
    const rawNextTask = ctx.flags['next-task'] as string | undefined;

    if (!rawFeedbackTask || !agentId) {
      output.printError('Task description and agent are required');
      return { success: false, exitCode: 1 };
    }
    if (rawFeedbackTask.length > 4096) {
      output.printError('Task description too long (max 4096 characters)');
      return { success: false, exitCode: 1 };
    }
    if (agentId.length > 128) {
      output.printError('Agent ID too long (max 128 characters)');
      return { success: false, exitCode: 1 };
    }
    const taskDescription = rawFeedbackTask;
    const nextTask = rawNextTask && rawNextTask.length > 4096 ? undefined : rawNextTask;

    // Validate agent against the registry (skipped when no registry exists)
    const known = registryAgents();
    const found = findAgent(agentId);
    if (known.length > 0 && !found) {
      output.printError(`Unknown agent: ${agentId}`);
      output.writeln('Available agents:');
      output.printList(known.map(agentName));
      return { success: false, exitCode: 1 };
    }
    const agent = { name: found ? agentName(found) : agentId };

    try {
      const router = await getRouter();
      const clampedReward = Math.max(-1, Math.min(1, reward));
      await router.update(taskDescription, agent.name, clampedReward, nextTask);

      output.printSuccess(`Feedback recorded for agent "${agent.name}"`);
      output.writeln();
      output.printBox(
        [
          `Task: ${taskDescription}`,
          `Agent: ${agent.name}`,
          `Reward: ${clampedReward >= 0 ? output.success(clampedReward.toFixed(2)) : output.error(clampedReward.toFixed(2))}`,
          `Outcome: ${clampedReward > 0 ? 'success' : 'failure'} (persisted to route-outcomes.jsonl)`,
        ]
          .filter(Boolean)
          .join('\n'),
        'Feedback Recorded',
      );

      return { success: true };
    } catch (error) {
      output.printError(error instanceof Error ? error.message : String(error));
      return { success: false, exitCode: 1 };
    }
  },
};

// ============================================================================
// Reset Subcommand
// ============================================================================

export const resetCommand: Command = {
  name: 'reset',
  description: 'Reset the keyword router state',
  options: [
    {
      name: 'force',
      short: 'f',
      description: 'Force reset without confirmation',
      type: 'boolean',
      default: false,
    },
  ],
  examples: [
    { command: 'monomind route reset', description: 'Reset router state' },
    { command: 'monomind route reset --force', description: 'Force reset' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const force = ctx.flags.force as boolean;

    if (!force && ctx.interactive) {
      output.printWarning('This will clear all route outcome history.');
      output.writeln(output.dim('Use --force to skip this confirmation.'));
      return { success: false, exitCode: 1 };
    }

    try {
      const router = await getRouter();
      await router.reset();
      output.printSuccess('Route outcome history cleared');
      return { success: true };
    } catch (error) {
      output.printError(error instanceof Error ? error.message : String(error));
      return { success: false, exitCode: 1 };
    }
  },
};

// ============================================================================
// Export/Import Subcommands
// ============================================================================

export const exportCommand: Command = {
  name: 'export',
  description: 'Export route outcome history',
  options: [
    {
      name: 'file',
      short: 'f',
      description: 'Output file path (outputs to stdout if not specified)',
      type: 'string',
    },
  ],
  examples: [
    { command: 'monomind route export', description: 'Export outcomes to stdout' },
    { command: 'monomind route export -f outcomes.json', description: 'Export to file' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const filePath = ctx.flags.file as string | undefined;

    try {
      const router = await getRouter();
      const data = await router.export();

      if (filePath) {
        const path = await import('node:path');
        const projectRoot = path.resolve(process.cwd());
        const fullPath = path.resolve(process.cwd(), filePath);
        if (!fullPath.startsWith(projectRoot + path.sep) && fullPath !== projectRoot) {
          output.printError(`File path must resolve within the project directory: ${projectRoot}`);
          return { success: false, exitCode: 1 };
        }
        if (!/\.json$/i.test(fullPath)) {
          output.printError('File must end in .json');
          return { success: false, exitCode: 1 };
        }
        const fs = await import('node:fs/promises');
        await fs.writeFile(fullPath, JSON.stringify(data, null, 2));
        output.printSuccess(`Route outcomes exported to ${fullPath} (${data.length} records)`);
      } else {
        output.printJson(data);
      }

      return { success: true, data };
    } catch (error) {
      output.printError(error instanceof Error ? error.message : String(error));
      return { success: false, exitCode: 1 };
    }
  },
};

export const importCommand: Command = {
  name: 'import',
  description: 'Import route outcome history from file',
  options: [
    {
      name: 'file',
      short: 'f',
      description: 'Input file path',
      type: 'string',
      required: true,
    },
  ],
  examples: [
    {
      command: 'monomind route import -f outcomes.json',
      description: 'Import route outcomes from file',
    },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const filePath = ctx.flags.file as string;

    if (!filePath) {
      output.printError('File path is required');
      return { success: false, exitCode: 1 };
    }

    try {
      // Containment + extension whitelist + size cap. Without these,
      // --file /proc/self/environ leaks process env into the import,
      // and a planted multi-GB JSON OOM-kills the process on readFile.
      const path = await import('node:path');
      const projectRoot = path.resolve(process.cwd());
      const fullPath = path.resolve(process.cwd(), filePath);
      if (!fullPath.startsWith(projectRoot + path.sep) && fullPath !== projectRoot) {
        output.printError(`File path must resolve within the project directory: ${projectRoot}`);
        return { success: false, exitCode: 1 };
      }
      if (!/\.json$/i.test(fullPath)) {
        output.printError('File must end in .json');
        return { success: false, exitCode: 1 };
      }
      const fs = await import('node:fs/promises');
      const stat = await fs.stat(fullPath);
      if (stat.size > 50 * 1024 * 1024) {
        output.printError(`File too large: ${stat.size} bytes (max 50MB)`);
        return { success: false, exitCode: 1 };
      }
      const content = await fs.readFile(fullPath, 'utf-8');
      const data = JSON.parse(content);

      const router = await getRouter();
      await router.import(data);

      output.printSuccess(`Route outcomes imported from ${fullPath}`);
      output.writeln(output.dim(`Loaded ${Array.isArray(data) ? data.length : 0} records`));

      return { success: true };
    } catch (error) {
      output.printError(error instanceof Error ? error.message : String(error));
      return { success: false, exitCode: 1 };
    }
  },
};
