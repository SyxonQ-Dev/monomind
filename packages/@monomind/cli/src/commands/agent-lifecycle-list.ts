import { callMCPTool, MCPClientError } from '../mcp-client.js';
import { output } from '../output.js';
import type { Command, CommandContext, CommandResult } from '../types.js';
import { formatStatus } from './agent-lifecycle-helpers.js';

// ─── list subcommand ─────────────────────────────────────────────────────────

export const listCommand: Command = {
  name: 'list',
  aliases: ['ls'],
  description: 'List all active agents',
  options: [
    {
      name: 'all',
      short: 'a',
      description: 'Include inactive agents',
      type: 'boolean',
      default: false,
    },
    { name: 'type', short: 't', description: 'Filter by agent type', type: 'string' },
    { name: 'status', short: 's', description: 'Filter by status', type: 'string' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    try {
      // agent_list emits `agentId` (agent-tools.ts), not `id` — reading `id`
      // here rendered a blank ID column for every agent. `id` is kept as a
      // fallback because agent_pool/agent_health project the same records
      // under that key.
      const result = await callMCPTool<{
        agents: Array<{
          agentId?: string;
          id?: string;
          agentType: string;
          status: 'active' | 'idle' | 'terminated';
          createdAt: string;
          lastActivityAt?: string;
        }>;
        total: number;
      }>('agent_list', {
        status: ctx.flags.all ? 'all' : ctx.flags.status || undefined,
        agentType: ctx.flags.type || undefined,
        limit: 100,
      });

      if (ctx.flags.format === 'json') {
        output.printJson(result);
        return { success: true, data: result };
      }

      output.writeln();
      output.writeln(output.bold('Active Agents'));
      output.writeln();

      if (result.agents.length === 0) {
        output.printInfo('No agents found matching criteria');
        return { success: true, data: result };
      }

      const displayAgents = result.agents.map((agent) => ({
        id: agent.agentId ?? agent.id ?? '',
        type: agent.agentType,
        status: agent.status,
        created: new Date(agent.createdAt).toLocaleTimeString(),
        lastActivity: agent.lastActivityAt
          ? new Date(agent.lastActivityAt).toLocaleTimeString()
          : 'N/A',
      }));

      output.printTable({
        columns: [
          { key: 'id', header: 'ID', width: 20 },
          { key: 'type', header: 'Type', width: 15 },
          { key: 'status', header: 'Status', width: 12, format: formatStatus },
          { key: 'created', header: 'Created', width: 12 },
          { key: 'lastActivity', header: 'Last Activity', width: 12 },
        ],
        data: displayAgents,
      });

      output.writeln();
      output.printInfo(`Total: ${result.total} agents`);
      return { success: true, data: result };
    } catch (error) {
      output.printError(
        error instanceof MCPClientError
          ? `Failed to list agents: ${error.message}`
          : `Unexpected error: ${String(error)}`,
      );
      return { success: false, exitCode: 1 };
    }
  },
};
