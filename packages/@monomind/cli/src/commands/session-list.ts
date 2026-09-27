import { callMCPTool, MCPClientError } from '../mcp-client.js';
import { output } from '../output.js';
import type { Command, CommandContext, CommandResult } from '../types.js';
import { formatDate } from './session-shared.js';

// List subcommand
export const listCommand: Command = {
  name: 'list',
  aliases: ['ls'],
  description: 'List all sessions',
  options: [
    {
      name: 'active',
      short: 'a',
      description: 'Show only active sessions',
      type: 'boolean',
      default: false,
    },
    {
      name: 'all',
      description: 'Include archived sessions',
      type: 'boolean',
      default: false,
    },
    {
      name: 'limit',
      short: 'l',
      description: 'Maximum sessions to show',
      type: 'number',
      default: 20,
    },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const activeOnly = ctx.flags.active as boolean;
    const includeArchived = ctx.flags.all as boolean;
    const rawLimit = ctx.flags.limit as number;
    // Cap limit to prevent unbounded MCP calls
    const limit =
      typeof rawLimit === 'number' && Number.isFinite(rawLimit)
        ? Math.max(1, Math.min(Math.floor(rawLimit), 200))
        : 20;

    try {
      const result = await callMCPTool<{
        sessions: Array<{
          sessionId: string;
          name?: string;
          description?: string;
          savedAt: string;
          stats?: {
            tasks: number;
            agents: number;
            memoryEntries: number;
            totalSize: number;
          };
        }>;
        total: number;
      }>('session_list', {
        status: activeOnly ? 'active' : includeArchived ? 'all' : 'active,saved',
        limit,
      });

      if (ctx.flags.format === 'json') {
        output.printJson(result);
        return { success: true, data: result };
      }

      output.writeln();
      output.writeln(output.bold('Sessions'));
      output.writeln();

      if (result.sessions.length === 0) {
        output.printInfo('No sessions found');
        output.printInfo('Run "monomind session save" to create a session');
        return { success: true, data: result };
      }

      output.printTable({
        columns: [
          { key: 'id', header: 'ID', width: 20 },
          { key: 'name', header: 'Name', width: 20 },
          { key: 'agents', header: 'Agents', width: 8, align: 'right' },
          { key: 'tasks', header: 'Tasks', width: 8, align: 'right' },
          { key: 'updated', header: 'Last Updated', width: 18 },
        ],
        data: result.sessions.map((s) => ({
          id: s.sessionId,
          name: s.name || '-',
          agents: s.stats?.agents ?? 0,
          tasks: s.stats?.tasks ?? 0,
          updated: formatDate(s.savedAt),
        })),
      });

      output.writeln();
      output.printInfo(`Showing ${result.sessions.length} of ${result.total} sessions`);

      return { success: true, data: result };
    } catch (error) {
      if (error instanceof MCPClientError) {
        output.printError(`Failed to list sessions: ${error.message}`);
      } else {
        output.printError(`Unexpected error: ${String(error)}`);
      }
      return { success: false, exitCode: 1 };
    }
  },
};
