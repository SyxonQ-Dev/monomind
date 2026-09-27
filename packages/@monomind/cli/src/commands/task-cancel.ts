import { callMCPTool, MCPClientError } from '../mcp-client.js';
import { output } from '../output.js';
import { confirm } from '../prompt.js';
import type { Command, CommandContext, CommandResult } from '../types.js';
import { MAX_REASON_LEN, MAX_TASK_ID_LEN } from './task-shared.js';

// Cancel subcommand
export const cancelCommand: Command = {
  name: 'cancel',
  aliases: ['abort', 'stop'],
  description: 'Cancel a running task',
  options: [
    {
      name: 'force',
      short: 'f',
      description: 'Force cancel without confirmation',
      type: 'boolean',
      default: false,
    },
    {
      name: 'reason',
      short: 'r',
      description: 'Cancellation reason',
      type: 'string',
    },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const taskId = (ctx.args[0] || '').slice(0, MAX_TASK_ID_LEN);
    const force = ctx.flags.force as boolean;
    const reason =
      typeof ctx.flags.reason === 'string' ? ctx.flags.reason.slice(0, MAX_REASON_LEN) : undefined;

    if (!taskId) {
      output.printError('Task ID is required');
      return { success: false, exitCode: 1 };
    }

    if (!force && ctx.interactive) {
      const confirmed = await confirm({
        message: `Are you sure you want to cancel task ${taskId}?`,
        default: false,
      });

      if (!confirmed) {
        output.printInfo('Operation cancelled');
        return { success: true };
      }
    }

    try {
      const result = await callMCPTool<{
        taskId: string;
        cancelled: boolean;
        previousStatus: string;
        cancelledAt: string;
      }>('task_cancel', {
        taskId,
        reason: reason || 'Cancelled by user via CLI',
      });

      output.writeln();
      output.printSuccess(`Task ${taskId} cancelled`);
      output.printInfo(`Previous status: ${result.previousStatus}`);

      if (ctx.flags.format === 'json') {
        output.printJson(result);
      }

      return { success: true, data: result };
    } catch (error) {
      if (error instanceof MCPClientError) {
        output.printError(`Failed to cancel task: ${error.message}`);
      } else {
        output.printError(`Unexpected error: ${String(error)}`);
      }
      return { success: false, exitCode: 1 };
    }
  },
};
