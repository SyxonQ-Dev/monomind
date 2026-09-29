import { callMCPTool, MCPClientError } from '../mcp-client.js';
import { output } from '../output.js';
import type { Command, CommandContext, CommandResult } from '../types.js';

// Transfer from project subcommand
export const transferFromProjectCommand: Command = {
  name: 'from-project',
  aliases: ['project'],
  description: 'Transfer patterns from another project',
  options: [
    {
      name: 'source',
      short: 's',
      description: 'Source project path',
      type: 'string',
      required: true,
    },
    {
      name: 'filter',
      short: 'f',
      description: 'Filter patterns by type',
      type: 'string',
    },
    {
      name: 'min-confidence',
      short: 'm',
      description: 'Minimum confidence threshold (0-1)',
      type: 'number',
      default: 0.7,
    },
  ],
  examples: [
    {
      command: 'monomind hooks transfer from-project -s ../old-project',
      description: 'Transfer all patterns',
    },
    {
      command: 'monomind hooks transfer from-project -s ../prod --filter security -m 0.9',
      description: 'Transfer high-confidence security patterns',
    },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const sourcePath = ctx.args[0] || (ctx.flags.source as string);
    const minConfidence = (ctx.flags['min-confidence'] as number) || 0.7;

    if (!sourcePath) {
      output.printError('Source project path is required. Use --source or -s flag.');
      return { success: false, exitCode: 1 };
    }

    output.printInfo(`Transferring patterns from: ${output.highlight(sourcePath)}`);

    const spinner = output.createSpinner({ text: 'Analyzing source patterns...', spinner: 'dots' });

    try {
      spinner.start();

      // Call MCP tool for transfer
      const result = await callMCPTool<{
        error?: string;
        message?: string;
        sourcePath: string;
        transferred: {
          total: number;
          byType: Record<string, number>;
        };
      }>('hooks_transfer', {
        sourcePath,
        filter: ctx.flags.filter,
        minConfidence,
        mergeStrategy: 'keep-highest-confidence',
      });

      if (result.error) {
        spinner.fail('Transfer failed');
        if (ctx.flags.format === 'json') output.printJson(result);
        else output.printError(result.error);
        return { success: false, exitCode: 1, data: result };
      }

      spinner.succeed(`Transferred ${result.transferred.total} patterns`);

      if (ctx.flags.format === 'json') {
        output.printJson(result);
        return { success: true, data: result };
      }

      if (result.message) {
        output.writeln(output.dim(result.message));
      }

      if (Object.keys(result.transferred.byType).length > 0) {
        output.writeln();
        output.writeln(output.bold('By Pattern Type'));
        output.printTable({
          columns: [
            { key: 'type', header: 'Type', width: 20 },
            { key: 'count', header: 'Count', width: 15, align: 'right' },
          ],
          data: Object.entries(result.transferred.byType).map(([type, count]) => ({ type, count })),
        });
      }

      return { success: true, data: result };
    } catch (error) {
      spinner.fail('Transfer failed');
      if (error instanceof MCPClientError) {
        output.printError(`Transfer error: ${error.message}`);
      } else {
        output.printError(`Unexpected error: ${String(error)}`);
      }
      return { success: false, exitCode: 1 };
    }
  },
};

// Parent transfer command combining all transfer methods
export const transferCommand: Command = {
  name: 'transfer',
  description: 'Copy recorded patterns from another local project',
  subcommands: [transferFromProjectCommand],
  examples: [
    {
      command: 'monomind hooks transfer from-project -s ../other-project',
      description: 'Transfer all patterns from another checkout',
    },
    {
      command: 'monomind hooks transfer from-project -s ../prod --filter security -m 0.9',
      description: 'Transfer only high-confidence security patterns',
    },
  ],
  action: async (): Promise<CommandResult> => {
    output.writeln();
    output.writeln(output.bold('Pattern Transfer'));
    output.writeln(output.dim('Copy learned patterns between local project checkouts'));
    output.writeln();
    output.writeln('Subcommands:');
    output.printList([
      `${output.highlight('from-project')} - Transfer patterns from another project directory`,
    ]);
    output.writeln();
    output.writeln('Run "monomind hooks transfer from-project --help" for options');
    return { success: true };
  },
};
