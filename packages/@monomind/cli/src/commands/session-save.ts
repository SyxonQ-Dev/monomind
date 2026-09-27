import { callMCPTool, MCPClientError } from '../mcp-client.js';
import { output } from '../output.js';
import { input } from '../prompt.js';
import type { Command, CommandContext, CommandResult } from '../types.js';
import { formatSize } from './session-shared.js';

// Save subcommand
export const saveCommand: Command = {
  name: 'save',
  aliases: ['create', 'checkpoint'],
  description: 'Save current session state',
  options: [
    {
      name: 'name',
      short: 'n',
      description: 'Session name',
      type: 'string',
    },
    {
      name: 'description',
      short: 'd',
      description: 'Session description',
      type: 'string',
    },
    {
      name: 'include-memory',
      description: 'Include memory state in session',
      type: 'boolean',
      default: true,
    },
    {
      name: 'include-agents',
      description: 'Include agent state in session',
      type: 'boolean',
      default: true,
    },
    {
      name: 'include-tasks',
      description: 'Include task state in session',
      type: 'boolean',
      default: true,
    },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    let sessionName = ctx.flags.name as string;
    let description = ctx.flags.description as string;

    // Interactive mode
    if (!sessionName && ctx.interactive) {
      sessionName = await input({
        message: 'Session name:',
        default: `session-${Date.now().toString(36)}`,
        validate: (v) => v.length > 0 || 'Name is required',
      });
    }

    if (!description && ctx.interactive) {
      description = await input({
        message: 'Session description (optional):',
        default: '',
      });
    }

    // Cap name and description lengths to prevent DoS / oversized storage
    if (typeof sessionName === 'string' && sessionName.length > 200) {
      sessionName = sessionName.slice(0, 200);
    }
    if (typeof description === 'string' && description.length > 2000) {
      description = description.slice(0, 2000);
    }

    const spinner = output.createSpinner({ text: 'Saving session...' });
    spinner.start();

    try {
      const result = await callMCPTool<{
        sessionId: string;
        name: string;
        description?: string;
        savedAt: string;
        includes: {
          memory: boolean;
          agents: boolean;
          tasks: boolean;
        };
        stats: {
          agentCount: number;
          taskCount: number;
          memoryEntries: number;
          totalSize: number;
        };
      }>('session_save', {
        name: sessionName,
        description,
        includeMemory: ctx.flags['include-memory'] !== false,
        includeAgents: ctx.flags['include-agents'] !== false,
        includeTasks: ctx.flags['include-tasks'] !== false,
      });

      spinner.succeed('Session saved');
      output.writeln();

      output.printTable({
        columns: [
          { key: 'property', header: 'Property', width: 18 },
          { key: 'value', header: 'Value', width: 35 },
        ],
        data: [
          { property: 'Session ID', value: result.sessionId },
          { property: 'Name', value: result.name },
          { property: 'Description', value: result.description || '-' },
          { property: 'Saved At', value: new Date(result.savedAt).toLocaleString() },
          { property: 'Agents', value: result.stats.agentCount },
          { property: 'Tasks', value: result.stats.taskCount },
          { property: 'Memory Entries', value: result.stats.memoryEntries },
          { property: 'Total Size', value: formatSize(result.stats.totalSize) },
        ],
      });

      output.writeln();
      output.printSuccess(`Session saved: ${result.sessionId}`);
      output.printInfo(`Restore with: monomind session restore ${result.sessionId}`);

      if (ctx.flags.format === 'json') {
        output.printJson(result);
      }

      return { success: true, data: result };
    } catch (error) {
      spinner.fail('Failed to save session');
      if (error instanceof MCPClientError) {
        output.printError(`Error: ${error.message}`);
      } else {
        output.printError(`Unexpected error: ${String(error)}`);
      }
      return { success: false, exitCode: 1 };
    }
  },
};
