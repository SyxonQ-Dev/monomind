import { callMCPTool, MCPClientError } from '../mcp-client.js';
import { output } from '../output.js';
import type { Command, CommandContext, CommandResult } from '../types.js';
import { formatPriority, formatStatus, MAX_LIMIT } from './task-shared.js';

// List subcommand
export const listCommand: Command = {
  name: 'list',
  aliases: ['ls'],
  description: 'List tasks',
  options: [
    {
      name: 'status',
      short: 's',
      description: 'Filter by status',
      type: 'string',
      choices: ['pending', 'running', 'completed', 'failed', 'cancelled', 'all'],
    },
    {
      name: 'type',
      short: 't',
      description: 'Filter by task type',
      type: 'string',
    },
    {
      name: 'priority',
      short: 'p',
      description: 'Filter by priority',
      type: 'string',
    },
    {
      name: 'agent',
      short: 'a',
      description: 'Filter by assigned agent',
      type: 'string',
    },
    {
      name: 'limit',
      short: 'l',
      description: 'Maximum number of tasks to show',
      type: 'number',
      default: 20,
    },
    {
      name: 'all',
      description: 'Show all tasks including completed',
      type: 'boolean',
      default: false,
    },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const status = ctx.flags.all ? 'all' : (ctx.flags.status as string) || 'pending,running';
    const limit = Math.min(Math.max(1, (ctx.flags.limit as number) || 20), MAX_LIMIT);

    try {
      const result = await callMCPTool<{
        tasks: Array<{
          taskId: string;
          type: string;
          description: string;
          priority: string;
          status: string;
          assignedTo?: string[];
          progress: number;
          createdAt: string;
        }>;
        total: number;
      }>('task_list', {
        status,
        type: ctx.flags.type,
        priority: ctx.flags.priority,
        agentId: ctx.flags.agent,
        limit,
        offset: 0,
      });

      if (ctx.flags.format === 'json') {
        output.printJson(result);
        return { success: true, data: result };
      }

      output.writeln();
      output.writeln(output.bold('Tasks'));
      output.writeln();

      if (result.tasks.length === 0) {
        output.printInfo('No tasks found matching criteria');
        return { success: true, data: result };
      }

      output.printTable({
        columns: [
          { key: 'id', header: 'ID', width: 15 },
          { key: 'type', header: 'Type', width: 15 },
          { key: 'description', header: 'Description', width: 30 },
          { key: 'priority', header: 'Priority', width: 10 },
          { key: 'status', header: 'Status', width: 12 },
          { key: 'progress', header: 'Progress', width: 10 },
        ],
        data: result.tasks.map((t) => ({
          id: t.taskId,
          type: t.type,
          description:
            t.description.length > 27 ? `${t.description.slice(0, 27)}...` : t.description,
          priority: formatPriority(t.priority),
          status: formatStatus(t.status),
          progress: `${t.progress}%`,
        })),
      });

      output.writeln();
      output.printInfo(`Showing ${result.tasks.length} of ${result.total} tasks`);

      return { success: true, data: result };
    } catch (error) {
      if (error instanceof MCPClientError) {
        output.printError(`Failed to list tasks: ${error.message}`);
      } else {
        output.printError(`Unexpected error: ${String(error)}`);
      }
      return { success: false, exitCode: 1 };
    }
  },
};
