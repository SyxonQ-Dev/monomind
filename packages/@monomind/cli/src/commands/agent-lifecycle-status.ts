import { callMCPTool, MCPClientError } from '../mcp-client.js';
import { output } from '../output.js';
import { input } from '../prompt.js';
import type { Command, CommandContext, CommandResult } from '../types.js';
import { formatStatus } from './agent-lifecycle-helpers.js';

// ─── status subcommand ───────────────────────────────────────────────────────

export const statusCommand: Command = {
  name: 'status',
  description: 'Show detailed status of an agent',
  options: [{ name: 'id', description: 'Agent ID', type: 'string' }],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    let agentId = ctx.args[0] || (ctx.flags.id as string);

    if (!agentId && ctx.interactive) {
      agentId = await input({
        message: 'Enter agent ID:',
        validate: (v) => v.length > 0 || 'Agent ID is required',
      });
    }

    if (!agentId) {
      output.printError('Agent ID is required');
      return { success: false, exitCode: 1 };
    }

    try {
      const status = await callMCPTool<{
        id: string;
        agentType: string;
        status: 'active' | 'idle' | 'terminated' | 'not_found';
        error?: string;
        createdAt: string;
        lastActivityAt?: string;
        config?: Record<string, unknown>;
        metrics?: {
          tasksCompleted: number;
          tasksInProgress: number;
          tasksFailed: number;
          averageExecutionTime: number;
          uptime: number;
        };
      }>('agent_status', { agentId, includeMetrics: true, includeHistory: false });

      // agent_status resolves (doesn't throw) with {status:'not_found', error}
      // for a nonexistent agent — callMCPTool only throws for registry/infra
      // errors, not a handler's own not-found response. Without this check
      // the CLI reported success:true for an agent that was never found.
      if (status.error) {
        output.printError(`Failed to get agent status: ${status.error}`);
        return { success: false, exitCode: 1 };
      }

      if (ctx.flags.format === 'json') {
        output.printJson(status);
        return { success: true, data: status };
      }

      output.writeln();
      output.printBox(
        [
          `Type: ${status.agentType}`,
          `Status: ${formatStatus(status.status)}`,
          `Created: ${new Date(status.createdAt).toLocaleString()}`,
          `Last Activity: ${status.lastActivityAt ? new Date(status.lastActivityAt).toLocaleString() : 'N/A'}`,
        ].join('\n'),
        `Agent: ${status.id}`,
      );

      if (status.metrics) {
        output.writeln();
        output.writeln(output.bold('Metrics'));
        const avgExecTime = status.metrics.averageExecutionTime ?? 0;
        const uptime = status.metrics.uptime ?? 0;
        output.printTable({
          columns: [
            { key: 'metric', header: 'Metric', width: 25 },
            { key: 'value', header: 'Value', width: 15, align: 'right' },
          ],
          data: [
            { metric: 'Tasks Completed', value: status.metrics.tasksCompleted ?? 0 },
            { metric: 'Tasks In Progress', value: status.metrics.tasksInProgress ?? 0 },
            { metric: 'Tasks Failed', value: status.metrics.tasksFailed ?? 0 },
            { metric: 'Avg Execution Time', value: `${avgExecTime.toFixed(2)}ms` },
            { metric: 'Uptime', value: `${(uptime / 1000 / 60).toFixed(1)}m` },
          ],
        });
      }

      return { success: true, data: status };
    } catch (error) {
      output.printError(
        error instanceof MCPClientError
          ? `Failed to get agent status: ${error.message}`
          : `Unexpected error: ${String(error)}`,
      );
      return { success: false, exitCode: 1 };
    }
  },
};
