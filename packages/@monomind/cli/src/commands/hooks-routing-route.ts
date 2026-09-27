import { callMCPTool, MCPClientError } from '../mcp-client.js';
import { output } from '../output.js';
import type { Command, CommandContext, CommandResult } from '../types.js';

// Route subcommand
export const routeCommand: Command = {
  name: 'route',
  description: 'Route task to optimal agent using learned patterns',
  options: [
    {
      name: 'task',
      short: 't',
      description: 'Task description',
      type: 'string',
      required: true,
    },
    {
      name: 'context',
      short: 'c',
      description: 'Additional context',
      type: 'string',
    },
    {
      name: 'top-k',
      short: 'K',
      description: 'Number of top agent suggestions',
      type: 'number',
      default: 3,
    },
  ],
  examples: [
    {
      command: 'monomind hooks route -t "Fix authentication bug"',
      description: 'Route task to optimal agent',
    },
    {
      command: 'monomind hooks route -t "Optimize database queries" -K 5',
      description: 'Get top 5 suggestions',
    },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const task = ctx.args[0] || (ctx.flags.task as string);
    const topK = (ctx.flags['top-k'] as number) || 3;

    if (!task) {
      output.printError('Task description is required. Use --task or -t flag.');
      return { success: false, exitCode: 1 };
    }

    output.printInfo(`Routing task: ${output.highlight(task)}`);

    try {
      // Call MCP tool for routing
      const result = await callMCPTool<{
        task: string;
        routing?: {
          method: string;
          backend?: string;
        };
        primaryAgent: {
          type: string;
          confidence: number;
          reason: string;
        };
        alternativeAgents: Array<{
          type: string;
          confidence: number;
          reason: string;
        }>;
      }>('hooks_route', {
        task,
        topK,
        context: ctx.flags.context,
        includeReasoning: true,
      });

      if (ctx.flags.format === 'json') {
        output.printJson(result);
        return { success: true, data: result };
      }

      output.writeln();
      output.printBox(
        [
          `Task: ${result.task}`,
          `Top Agent: ${output.highlight(result.primaryAgent.type)}`,
          `Confidence: ${(result.primaryAgent.confidence * 100).toFixed(1)}%`,
          `Method: ${result.routing?.method ?? 'keyword'}`,
        ].join('\n'),
        'Routing Decision',
      );

      const recommendations = [result.primaryAgent, ...(result.alternativeAgents || [])];
      if (recommendations.length > 0) {
        output.writeln();
        output.writeln(output.bold('Agent Recommendations'));
        output.printTable({
          columns: [
            { key: 'type', header: 'Agent', width: 32 },
            {
              key: 'confidence',
              header: 'Confidence',
              width: 12,
              align: 'right',
              format: (v) => `${(Number(v) * 100).toFixed(1)}%`,
            },
            { key: 'reason', header: 'Reason', width: 35 },
          ],
          data: recommendations.slice(0, topK),
        });
      }

      return { success: true, data: result };
    } catch (error) {
      if (error instanceof MCPClientError) {
        output.printError(`Routing failed: ${error.message}`);
      } else {
        output.printError(`Unexpected error: ${String(error)}`);
      }
      return { success: false, exitCode: 1 };
    }
  },
};
