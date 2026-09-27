import { callMCPTool, MCPClientError } from '../mcp-client.js';
import { output } from '../output.js';
import type { Command, CommandContext, CommandResult } from '../types.js';
import { formatHealth } from './status-display.js';

// Agents subcommand
export const agentsCommand: Command = {
  name: 'agents',
  description: 'Show detailed agent status',
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    try {
      // agent_list (mcp-tools/agent-tools.ts) returns agentId/agentType/status/
      // health/taskCount/createdAt/domain — it never returns `id`, `type`,
      // `task`, `uptime`, or a `metrics.successRate` object. Reading
      // `a.metrics.successRate` on the real shape threw a TypeError
      // ("Cannot read properties of undefined") for every agent in the store.
      const result = await callMCPTool<{
        agents: Array<{
          agentId: string;
          agentType: string;
          status: string;
          health: number;
          taskCount: number;
          createdAt: string;
          domain?: string;
        }>;
      }>('agent_list', { includeMetrics: true, status: 'all' });

      if (ctx.flags.format === 'json') {
        output.printJson(result);
        return { success: true, data: result };
      }

      output.writeln();
      output.writeln(output.bold('Agent Status'));
      output.writeln();

      if (result.agents.length === 0) {
        output.printInfo('No agents running');
        return { success: true, data: result };
      }

      output.printTable({
        columns: [
          { key: 'id', header: 'ID', width: 20 },
          { key: 'type', header: 'Type', width: 12 },
          { key: 'status', header: 'Status', width: 10 },
          { key: 'tasks', header: 'Tasks', width: 8 },
          { key: 'created', header: 'Created', width: 22 },
          { key: 'health', header: 'Health', width: 8 },
        ],
        data: result.agents.map((a) => ({
          id: a.agentId ?? 'N/A',
          type: a.agentType ?? 'N/A',
          status: a.status ? formatHealth(a.status) : 'N/A',
          tasks: a.taskCount ?? 'N/A',
          created: a.createdAt ?? 'N/A',
          health: typeof a.health === 'number' ? a.health.toFixed(2) : 'N/A',
        })),
      });

      return { success: true, data: result };
    } catch (error) {
      if (error instanceof MCPClientError) {
        output.printError(`Failed to get agent status: ${error.message}`);
      } else {
        output.printError(`Unexpected error: ${String(error)}`);
      }
      return { success: false, exitCode: 1 };
    }
  },
};
