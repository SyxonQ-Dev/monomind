import { callMCPTool, MCPClientError } from '../mcp-client.js';
import { output } from '../output.js';
import { multiSelect } from '../prompt.js';
import type { Command, CommandContext, CommandResult } from '../types.js';
import { MAX_ASSIGN_LEN, MAX_TASK_ID_LEN } from './task-shared.js';

// Assign subcommand
export const assignCommand: Command = {
  name: 'assign',
  description: 'Assign a task to agent(s)',
  options: [
    {
      name: 'agent',
      short: 'a',
      description: 'Agent ID(s) to assign (comma-separated)',
      type: 'string',
    },
    {
      name: 'unassign',
      description: 'Remove current assignment',
      type: 'boolean',
      default: false,
    },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const taskId = (ctx.args[0] || '').slice(0, MAX_TASK_ID_LEN);
    const agentIds = ctx.flags.agent as string;
    const unassign = ctx.flags.unassign as boolean;

    if (!taskId) {
      output.printError('Task ID is required');
      return { success: false, exitCode: 1 };
    }

    if (!agentIds && !unassign) {
      // Interactive agent selection
      if (ctx.interactive) {
        try {
          const agents = await callMCPTool<{
            agents: Array<{ id: string; type: string; status: string }>;
          }>('agent_list', { status: 'active,idle' });

          if (agents.agents.length === 0) {
            output.printWarning('No available agents');
            return { success: false, exitCode: 1 };
          }

          const selectedAgents = await multiSelect({
            message: 'Select agent(s) to assign:',
            options: agents.agents.map((a) => ({
              value: a.id,
              label: a.id,
              hint: `${a.type} - ${a.status}`,
            })),
            required: true,
          });

          if (selectedAgents.length === 0) {
            output.printInfo('No agents selected');
            return { success: true };
          }

          // Continue with assignment
          const result = await callMCPTool<{
            taskId: string;
            assignedTo: string[];
            previouslyAssigned: string[];
          }>('task_assign', {
            taskId,
            agentIds: selectedAgents,
          });

          output.writeln();
          output.printSuccess(`Task ${taskId} assigned to ${result.assignedTo.join(', ')}`);

          return { success: true, data: result };
        } catch (error) {
          if (error instanceof Error && error.message === 'User cancelled') {
            output.printInfo('Operation cancelled');
            return { success: true };
          }
          throw error;
        }
      }

      output.printError('Agent ID is required. Use --agent flag or run in interactive mode');
      return { success: false, exitCode: 1 };
    }

    try {
      const result = await callMCPTool<{
        taskId: string;
        assignedTo: string[];
        previouslyAssigned: string[];
      }>('task_assign', {
        taskId,
        agentIds: unassign
          ? []
          : agentIds
              .split(',')
              .map((id) => id.trim().slice(0, MAX_ASSIGN_LEN))
              .filter(Boolean)
              .slice(0, 20),
        unassign,
      });

      output.writeln();
      if (unassign) {
        output.printSuccess(`Task ${taskId} unassigned`);
      } else {
        output.printSuccess(`Task ${taskId} assigned to ${result.assignedTo.join(', ')}`);
      }

      if (ctx.flags.format === 'json') {
        output.printJson(result);
      }

      return { success: true, data: result };
    } catch (error) {
      if (error instanceof MCPClientError) {
        output.printError(`Failed to assign task: ${error.message}`);
      } else {
        output.printError(`Unexpected error: ${String(error)}`);
      }
      return { success: false, exitCode: 1 };
    }
  },
};
