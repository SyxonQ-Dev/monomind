import { callMCPTool, MCPClientError } from '../mcp-client.js';
import { output } from '../output.js';
import type { Command, CommandContext, CommandResult } from '../types.js';

// Metrics subcommand
export const metricsCommand: Command = {
  name: 'metrics',
  description: 'View recorded routing/outcome metrics',
  options: [
    {
      name: 'period',
      short: 'p',
      description: 'Time period (1h, 24h, 7d, 30d, all)',
      type: 'string',
      default: '24h',
    },
    {
      name: 'v1-dashboard',
      description: 'Show v1 performance dashboard',
      type: 'boolean',
      default: false,
    },
    {
      name: 'category',
      short: 'c',
      description: 'Metric category (patterns, agents, commands, performance)',
      type: 'string',
    },
  ],
  examples: [
    { command: 'monomind hooks metrics', description: 'View 24h metrics' },
    {
      command: 'monomind hooks metrics --period 7d --v1-dashboard',
      description: 'v1 metrics for 7 days',
    },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const period = (ctx.flags.period as string) || '24h';
    const v1Dashboard = ctx.flags.v1Dashboard as boolean;

    output.writeln();
    output.writeln(output.bold(`Learning Metrics Dashboard (${period})`));
    output.writeln();

    try {
      // Call MCP tool for metrics. The real handler (hooks-metrics-list.ts) only
      // returns a subset of these fields depending on whether any memory
      // entries exist yet — patterns/agents/commands/performance are all
      // Partial, not fully populated objects. Fields that aren't tracked yet
      // are genuinely absent (not present as null), each with a `_note`
      // string explaining what would populate them.
      const result = await callMCPTool<{
        period: string;
        _note?: string;
        patterns: Partial<{
          total: number;
          successful: number;
          failed: number;
          avgConfidence: number | null;
          _note: string;
        }>;
        agents: Partial<{
          routingAccuracy: number | null;
          totalRoutes: number;
          topAgent: string | null;
          _note: string;
        }>;
        commands: Partial<{
          totalExecuted: number;
          successRate: number | null;
          avgRiskScore: number | null;
          _note: string;
        }>;
        performance?: {
          memoryReduction: string;
          searchImprovement: string;
          tokenReduction: string;
        };
      }>('hooks_metrics', {
        period,
        includev1: v1Dashboard,
        category: ctx.flags.category,
      });

      if (ctx.flags.format === 'json') {
        output.printJson(result);
        return { success: true, data: result };
      }

      const pct = (v: number | null | undefined) =>
        typeof v === 'number' ? `${(v * 100).toFixed(1)}%` : 'N/A';

      if (result._note) {
        output.writeln(output.dim(result._note));
        output.writeln();
      }

      // Patterns section
      output.writeln(output.bold('📊 Recorded Patterns'));
      output.printTable({
        columns: [
          { key: 'metric', header: 'Metric', width: 25 },
          { key: 'value', header: 'Value', width: 20, align: 'right' },
        ],
        data: [
          { metric: 'Total Patterns', value: result.patterns.total ?? 0 },
          {
            metric: 'Successful',
            value:
              typeof result.patterns.successful === 'number'
                ? output.success(String(result.patterns.successful))
                : 'N/A',
          },
          {
            metric: 'Failed',
            value:
              typeof result.patterns.failed === 'number'
                ? output.error(String(result.patterns.failed))
                : 'N/A',
          },
          { metric: 'Avg Confidence', value: pct(result.patterns.avgConfidence) },
        ],
      });
      if (result.patterns._note) output.writeln(output.dim(`  ${result.patterns._note}`));

      output.writeln();

      // Agent routing section
      output.writeln(output.bold('🤖 Agent Routing'));
      output.printTable({
        columns: [
          { key: 'metric', header: 'Metric', width: 25 },
          { key: 'value', header: 'Value', width: 20, align: 'right' },
        ],
        data: [
          { metric: 'Routing Accuracy', value: pct(result.agents.routingAccuracy) },
          { metric: 'Total Routes', value: result.agents.totalRoutes ?? 0 },
          {
            metric: 'Top Agent',
            value: result.agents.topAgent ? output.highlight(result.agents.topAgent) : 'N/A',
          },
        ],
      });
      if (result.agents._note) output.writeln(output.dim(`  ${result.agents._note}`));

      output.writeln();

      // Command execution section
      output.writeln(output.bold('⚡ Command Execution'));
      output.printTable({
        columns: [
          { key: 'metric', header: 'Metric', width: 25 },
          { key: 'value', header: 'Value', width: 20, align: 'right' },
        ],
        data: [
          { metric: 'Total Executed', value: result.commands.totalExecuted ?? 0 },
          { metric: 'Success Rate', value: pct(result.commands.successRate) },
          {
            metric: 'Avg Risk Score',
            value:
              typeof result.commands.avgRiskScore === 'number'
                ? result.commands.avgRiskScore.toFixed(2)
                : 'N/A',
          },
        ],
      });
      if (result.commands._note) output.writeln(output.dim(`  ${result.commands._note}`));

      return { success: true, data: result };
    } catch (error) {
      if (error instanceof MCPClientError) {
        output.printError(`Metrics error: ${error.message}`);
      } else {
        output.printError(`Unexpected error: ${String(error)}`);
      }
      return { success: false, exitCode: 1 };
    }
  },
};
