import { callMCPTool, MCPClientError } from '../mcp-client.js';
import { output } from '../output.js';
import type { Command, CommandContext, CommandResult } from '../types.js';
import { formatHealth } from './status-display.js';

// Tasks subcommand
export const tasksCommand: Command = {
  name: 'tasks',
  description: 'Show detailed task status',
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    try {
      const result = await callMCPTool<{
        tasks: Array<{
          taskId: string;
          type: string;
          status: string;
          priority: string;
          assignedTo?: string[];
          progress: number;
          createdAt: string;
        }>;
      }>('task_list', { status: 'all', limit: 50 });

      if (ctx.flags.format === 'json') {
        output.printJson(result);
        return { success: true, data: result };
      }

      output.writeln();
      output.writeln(output.bold('Task Status'));
      output.writeln();

      if (result.tasks.length === 0) {
        output.printInfo('No tasks');
        return { success: true, data: result };
      }

      output.printTable({
        columns: [
          { key: 'id', header: 'ID', width: 15 },
          { key: 'type', header: 'Type', width: 15 },
          { key: 'status', header: 'Status', width: 12 },
          { key: 'priority', header: 'Priority', width: 10 },
          { key: 'agent', header: 'Agent', width: 15 },
          { key: 'progress', header: 'Progress', width: 10 },
        ],
        data: result.tasks.map((t) => ({
          id: t.taskId,
          type: t.type,
          status: formatHealth(t.status),
          priority: t.priority,
          agent: t.assignedTo && t.assignedTo.length > 0 ? t.assignedTo.join(', ') : '-',
          progress: `${t.progress}%`,
        })),
      });

      return { success: true, data: result };
    } catch (error) {
      if (error instanceof MCPClientError) {
        output.printError(`Failed to get task status: ${error.message}`);
      } else {
        output.printError(`Unexpected error: ${String(error)}`);
      }
      return { success: false, exitCode: 1 };
    }
  },
};
