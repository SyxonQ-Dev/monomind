import { output } from '../output.js';
import type { Command, CommandContext, CommandResult } from '../types.js';
import { formatBytes } from './status-helpers.js';

// Memory subcommand
export const memoryCommand: Command = {
  name: 'memory',
  description: 'Show detailed memory status',
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    // memory_detailed-stats MCP tool is not registered; use memory bridge directly
    try {
      const { bridgeListEntries } = await import('../memory/memory-bridge.js');
      const listed = await bridgeListEntries({ limit: 10000 });
      const entries = listed?.success ? listed.entries : [];
      const totalBytes = entries.reduce((s: number, e: any) => s + (e.content || '').length, 0);

      const result = {
        backend: 'SQLite',
        entries: entries.length,
        size: totalBytes,
      };

      if (ctx.flags.format === 'json') {
        output.printJson(result);
        return { success: true, data: result };
      }

      output.writeln();
      output.writeln(output.bold('Memory Status'));
      output.writeln();

      output.printTable({
        columns: [
          { key: 'property', header: 'Property', width: 20 },
          { key: 'value', header: 'Value', width: 25 },
        ],
        data: [
          { property: 'Backend', value: result.backend },
          { property: 'Total Entries', value: result.entries.toLocaleString() },
          { property: 'Storage Size', value: formatBytes(result.size) },
        ],
      });

      return { success: true, data: result };
    } catch (error) {
      output.printError(
        `Failed to get memory status: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { success: false, exitCode: 1 };
    }
  },
};
