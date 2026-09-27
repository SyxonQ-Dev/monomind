import { callMCPTool, MCPClientError } from '../mcp-client.js';
import { output } from '../output.js';
import type { Command, CommandContext, CommandResult } from '../types.js';

// Explain subcommand
export const explainCommand: Command = {
  name: 'explain',
  description: 'Explain routing decision with transparency',
  options: [
    {
      name: 'task',
      short: 't',
      description: 'Task description',
      type: 'string',
      required: true,
    },
    {
      name: 'agent',
      short: 'a',
      description: 'Agent type to explain',
      type: 'string',
    },
    {
      name: 'verbose',
      short: 'v',
      description: 'Verbose explanation',
      type: 'boolean',
      default: false,
    },
  ],
  examples: [
    {
      command: 'monomind hooks explain -t "Fix authentication bug"',
      description: 'Explain routing decision',
    },
    {
      command: 'monomind hooks explain -t "Optimize queries" -a coder --verbose',
      description: 'Verbose explanation for specific agent',
    },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const task = ctx.args[0] || (ctx.flags.task as string);

    if (!task) {
      output.printError('Task description is required. Use --task or -t flag.');
      return { success: false, exitCode: 1 };
    }

    output.printInfo(`Explaining routing for: ${output.highlight(task)}`);

    try {
      // Call MCP tool for explanation
      const result = await callMCPTool<{
        task: string;
        explanation: string;
        factors: Array<{
          factor: string;
          weight: number;
          // null when the tool has no measurement for the factor.
          value: number | null;
          impact: string;
        }>;
        patterns: Array<{
          pattern: string;
          matchScore: number;
          examples: string[];
        }>;
        decision: {
          agent: string;
          confidence: number;
          reasoning: string[];
        };
      }>('hooks_explain', {
        task,
        agent: ctx.flags.agent,
        verbose: ctx.flags.verbose || false,
      });

      if (ctx.flags.format === 'json') {
        output.printJson(result);
        return { success: true, data: result };
      }

      output.writeln();
      output.writeln(output.bold('Decision Explanation'));
      output.writeln();
      output.writeln(result.explanation);

      output.writeln();
      output.printBox(
        [
          `Agent: ${output.highlight(result.decision.agent)}`,
          `Confidence: ${(result.decision.confidence * 100).toFixed(1)}%`,
        ].join('\n'),
        'Final Decision',
      );

      if (result.decision.reasoning.length > 0) {
        output.writeln();
        output.writeln(output.bold('Reasoning Steps'));
        output.printList(result.decision.reasoning.map((r, i) => `${i + 1}. ${r}`));
      }

      if (result.factors.length > 0) {
        output.writeln();
        output.writeln(output.bold('Decision Factors'));
        output.printTable({
          columns: [
            { key: 'factor', header: 'Factor', width: 20 },
            {
              key: 'weight',
              header: 'Weight',
              width: 10,
              align: 'right',
              format: (v) => `${(Number(v) * 100).toFixed(0)}%`,
            },
            {
              key: 'value',
              header: 'Value',
              width: 10,
              align: 'right',
              format: (v) => (v === null ? 'N/A' : Number(v).toFixed(2)),
            },
            { key: 'impact', header: 'Impact', width: 25 },
          ],
          data: result.factors,
        });
      }

      if (result.patterns.length > 0 && ctx.flags.verbose) {
        output.writeln();
        output.writeln(output.bold('Matched Patterns'));
        result.patterns.forEach((p, i) => {
          output.writeln();
          output.writeln(
            `${i + 1}. ${output.highlight(p.pattern)} (${(p.matchScore * 100).toFixed(1)}% match)`,
          );
          if (p.examples.length > 0) {
            output.printList(p.examples.slice(0, 3).map((e) => output.dim(`  ${e}`)));
          }
        });
      }

      return { success: true, data: result };
    } catch (error) {
      if (error instanceof MCPClientError) {
        output.printError(`Explanation failed: ${error.message}`);
      } else {
        output.printError(`Unexpected error: ${String(error)}`);
      }
      return { success: false, exitCode: 1 };
    }
  },
};
