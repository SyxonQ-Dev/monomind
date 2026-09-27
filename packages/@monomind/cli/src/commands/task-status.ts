import { callMCPTool, MCPClientError } from '../mcp-client.js';
import { output } from '../output.js';
import { input } from '../prompt.js';
import type { Command, CommandContext, CommandResult } from '../types.js';
import { formatPriority, formatStatus, MAX_TASK_ID_LEN } from './task-shared.js';

// Status subcommand (get task details)
export const statusCommand: Command = {
  name: 'status',
  aliases: ['info', 'get'],
  description: 'Get task status and details',
  options: [
    {
      name: 'id',
      description: 'Task ID',
      type: 'string',
    },
    {
      name: 'logs',
      description: 'Include execution logs',
      type: 'boolean',
      default: false,
    },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    let taskId = (ctx.args[0] || (ctx.flags.id as string) || '').slice(0, MAX_TASK_ID_LEN);

    if (!taskId && ctx.interactive) {
      taskId = await input({
        message: 'Enter task ID:',
        validate: (v) => v.length > 0 || 'Task ID is required',
      });
      taskId = taskId.slice(0, MAX_TASK_ID_LEN);
    }

    if (!taskId) {
      output.printError('Task ID is required');
      return { success: false, exitCode: 1 };
    }

    try {
      const result = await callMCPTool<{
        id: string;
        type: string;
        description: string;
        priority: string;
        status: string;
        progress: number;
        assignedTo?: string[];
        parentId?: string;
        dependencies: string[];
        dependents: string[];
        tags: string[];
        createdAt: string;
        startedAt?: string;
        completedAt?: string;
        result?: unknown;
        error?: string;
        logs?: Array<{ timestamp: string; level: string; message: string }>;
        metrics?: {
          executionTime: number;
          retries: number;
          tokensUsed: number;
        };
      }>('task_status', {
        taskId,
        includeLogs: ctx.flags.logs,
        includeMetrics: true,
      });

      if (ctx.flags.format === 'json') {
        output.printJson(result);
        return { success: true, data: result };
      }

      output.writeln();
      output.printBox(
        [
          `Type:        ${result.type}`,
          `Status:      ${formatStatus(result.status)}`,
          `Priority:    ${formatPriority(result.priority)}`,
          `Progress:    ${result.progress}%`,
          '',
          `Description: ${result.description}`,
        ].join('\n'),
        `Task: ${result.id}`,
      );

      // Assignment info
      output.writeln();
      output.writeln(output.bold('Assignment'));
      output.printTable({
        columns: [
          { key: 'property', header: 'Property', width: 15 },
          { key: 'value', header: 'Value', width: 40 },
        ],
        data: [
          { property: 'Assigned To', value: result.assignedTo?.join(', ') || 'Unassigned' },
          { property: 'Parent Task', value: result.parentId || 'None' },
          { property: 'Dependencies', value: result.dependencies.join(', ') || 'None' },
          { property: 'Dependents', value: result.dependents.join(', ') || 'None' },
          { property: 'Tags', value: result.tags.join(', ') || 'None' },
        ],
      });

      // Timeline
      output.writeln();
      output.writeln(output.bold('Timeline'));
      output.printTable({
        columns: [
          { key: 'event', header: 'Event', width: 15 },
          { key: 'time', header: 'Time', width: 30 },
        ],
        data: [
          { event: 'Created', time: new Date(result.createdAt).toLocaleString() },
          {
            event: 'Started',
            time: result.startedAt ? new Date(result.startedAt).toLocaleString() : '-',
          },
          {
            event: 'Completed',
            time: result.completedAt ? new Date(result.completedAt).toLocaleString() : '-',
          },
        ],
      });

      // Metrics
      if (result.metrics) {
        output.writeln();
        output.writeln(output.bold('Metrics'));
        output.printTable({
          columns: [
            { key: 'metric', header: 'Metric', width: 20 },
            { key: 'value', header: 'Value', width: 20, align: 'right' },
          ],
          data: [
            {
              metric: 'Execution Time',
              value: `${(result.metrics.executionTime / 1000).toFixed(2)}s`,
            },
            { metric: 'Retries', value: result.metrics.retries },
            { metric: 'Tokens Used', value: result.metrics.tokensUsed.toLocaleString() },
          ],
        });
      }

      // Error if failed
      if (result.status === 'failed' && result.error) {
        output.writeln();
        output.printError(`Error: ${result.error}`);
      }

      // Logs if requested
      if (ctx.flags.logs && result.logs && result.logs.length > 0) {
        output.writeln();
        output.writeln(output.bold('Execution Logs'));
        for (const log of result.logs.slice(-20)) {
          const time = new Date(log.timestamp).toLocaleTimeString();
          const level =
            log.level === 'error'
              ? output.error(`[${log.level}]`)
              : log.level === 'warn'
                ? output.warning(`[${log.level}]`)
                : output.dim(`[${log.level}]`);
          output.writeln(`  ${output.dim(time)} ${level} ${log.message}`);
        }
      }

      return { success: true, data: result };
    } catch (error) {
      if (error instanceof MCPClientError) {
        output.printError(`Failed to get task status: ${error.message}`);
      } else {
        output.printError(`Unexpected error: ${String(error)}`);
      }
      return { success: false, exitCode: 1 };
    }
  },
};
