import { callMCPTool, MCPClientError } from '../mcp-client.js';
import { output } from '../output.js';
import type { Command, CommandContext, CommandResult } from '../types.js';

// List subcommand
export const listCommand: Command = {
  name: 'list',
  aliases: ['ls'],
  description: 'List all registered hooks',
  options: [
    {
      name: 'enabled',
      short: 'e',
      description: 'Show only enabled hooks',
      type: 'boolean',
      default: false,
    },
    {
      name: 'type',
      short: 't',
      description: 'Filter by hook type',
      type: 'string',
    },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    try {
      // Call MCP tool for list
      const result = await callMCPTool<{
        // No priority / executionCount / lastExecuted: the registry behind
        // `hooks_list` has never carried any of the three, and nothing on disk
        // records them per hook. Columns for them printed blanks and a literal
        // "Never" on every row of every project.
        hooks: Array<{ name: string; type: string; enabled: boolean }>;
        total: number;
        claudeCode?: {
          configured: boolean;
          settingsPath: string;
          wired: number;
          events: string[];
          invocations: {
            metricsPath: string;
            recorded: boolean;
            handlers: Array<{ name: string; count: number; meanMs: number; maxMs: number }>;
          };
        };
      }>('hooks_list', {
        enabled: ctx.flags.enabled || undefined,
        type: ctx.flags.type || undefined,
      });

      if (ctx.flags.format === 'json') {
        output.printJson(result);
        return { success: true, data: result };
      }

      output.writeln();
      output.writeln(output.bold('Registered Hooks'));
      output.writeln(output.dim('monomind hook subcommands available in this install'));
      output.writeln();

      if (result.hooks.length === 0) {
        output.printInfo('No hooks found matching criteria');
        return { success: true, data: result };
      }

      output.printTable({
        columns: [
          { key: 'name', header: 'Name', width: 20 },
          { key: 'type', header: 'Type', width: 15 },
          {
            key: 'enabled',
            header: 'Enabled',
            width: 10,
            format: (v) => (v ? output.success('Yes') : output.dim('No')),
          },
        ],
        data: result.hooks,
      });

      output.writeln();
      output.printInfo(`Total: ${result.total} hooks`);

      // Claude Code's event wiring is a separate subsystem from the registry
      // above — `init` writes it into settings.json, keyed by event and
      // handler script rather than by the subcommand names listed here. It
      // used to be silently conflated with the table's Enabled column (#270).
      const wiring = result.claudeCode;
      if (wiring) {
        output.writeln();
        output.writeln(output.bold('Claude Code wiring'));
        if (wiring.configured) {
          output.writeln(
            output.dim(
              `  ${wiring.wired} hook command(s) across ${wiring.events.length} event(s): ${wiring.events.join(', ')}`,
            ),
          );
          output.writeln(output.dim(`  ${wiring.settingsPath}`));
        } else {
          output.writeln(output.dim(`  No monomind hooks wired in ${wiring.settingsPath}`));
          output.writeln(output.dim('  Run "monomind init hooks" to wire them up'));
        }

        // The only execution data anything records. It counts invocations of
        // the wired handlers above, whose names are a different name space
        // from the subcommand registry — so it belongs here, not in a column
        // on those rows. Nothing records a per-hook timestamp or priority.
        const { invocations } = wiring;
        if (invocations.recorded) {
          output.writeln();
          output.writeln(output.bold('Handler invocations'));
          output.printTable({
            columns: [
              { key: 'name', header: 'Handler', width: 20 },
              { key: 'count', header: 'Invocations', width: 12, align: 'right' },
              { key: 'meanMs', header: 'Mean (ms)', width: 11, align: 'right' },
              { key: 'maxMs', header: 'Max (ms)', width: 10, align: 'right' },
            ],
            data: invocations.handlers,
          });
          output.writeln(output.dim(`  ${invocations.metricsPath}`));
        }
      }

      return { success: true, data: result };
    } catch (error) {
      if (error instanceof MCPClientError) {
        output.printError(`Failed to list hooks: ${error.message}`);
      } else {
        output.printError(`Unexpected error: ${String(error)}`);
      }
      return { success: false, exitCode: 1 };
    }
  },
};
