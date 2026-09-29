import { callMCPTool, MCPClientError } from '../mcp-client.js';
import { output } from '../output.js';
import type { Command, CommandContext, CommandResult } from '../types.js';

// Pre-task subcommand
export const preTaskCommand: Command = {
  name: 'pre-task',
  description: 'Record task start and get agent suggestions',
  options: [
    {
      name: 'task-id',
      short: 'i',
      description: 'Unique task identifier (auto-generated if omitted)',
      type: 'string',
    },
    {
      name: 'description',
      short: 'd',
      description: 'Task description',
      type: 'string',
      required: true,
    },
    {
      name: 'auto-spawn',
      short: 'a',
      description: 'Auto-spawn suggested agents',
      type: 'boolean',
      default: false,
    },
  ],
  examples: [
    {
      command: 'monomind hooks pre-task -i task-123 -d "Fix auth bug"',
      description: 'Record task start',
    },
    {
      command: 'monomind hooks pre-task -i task-456 -d "Implement feature" --auto-spawn',
      description: 'With auto-spawn',
    },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const taskId = (ctx.flags['task-id'] as string) || `task-${Date.now().toString(36)}`;
    const description = ctx.args[0] || (ctx.flags.description as string);

    if (!description) {
      output.printError('Description is required: --description "your task"');
      return { success: false, exitCode: 1 };
    }

    output.printInfo(`Starting task: ${output.highlight(taskId)}`);

    try {
      const result = await callMCPTool<{
        taskId: string;
        description: string;
        suggestedAgents: Array<{
          type: string;
          confidence: number;
          reason: string;
        }>;
        complexity: 'low' | 'medium' | 'high';
        estimatedDuration: string;
        risks: string[];
        recommendations: string[];
      }>('hooks_pre-task', {
        taskId,
        description,
        autoSpawn: ctx.flags['auto-spawn'] || false,
        timestamp: Date.now(),
      });

      if (ctx.flags.format === 'json') {
        output.printJson(result);
        return { success: true, data: result };
      }

      output.writeln();
      output.printBox(
        [
          `Task ID: ${result.taskId}`,
          `Description: ${result.description}`,
          `Complexity: ${result.complexity.toUpperCase()}`,
          `Est. Duration: ${result.estimatedDuration}`,
        ].join('\n'),
        'Task Registered',
      );

      if (result.suggestedAgents.length > 0) {
        output.writeln();
        output.writeln(output.bold('Suggested Agents'));
        output.printTable({
          columns: [
            { key: 'type', header: 'Agent Type', width: 20 },
            {
              key: 'confidence',
              header: 'Confidence',
              width: 12,
              align: 'right',
              format: (v) => `${(Number(v) * 100).toFixed(1)}%`,
            },
            { key: 'reason', header: 'Reason', width: 35 },
          ],
          data: result.suggestedAgents,
        });
      }

      if (result.risks.length > 0) {
        output.writeln();
        output.writeln(output.bold(output.error('Potential Risks')));
        output.printList(result.risks.map((r) => output.warning(r)));
      }

      if (result.recommendations.length > 0) {
        output.writeln();
        output.writeln(output.bold('Recommendations'));
        output.printList(result.recommendations);
      }

      return { success: true, data: result };
    } catch (error) {
      if (error instanceof MCPClientError) {
        output.printError(`Pre-task hook failed: ${error.message}`);
      } else {
        output.printError(`Unexpected error: ${String(error)}`);
      }
      return { success: false, exitCode: 1 };
    }
  },
};

// Post-task subcommand
export const postTaskCommand: Command = {
  name: 'post-task',
  description: 'Record a task outcome against its routed agent',
  options: [
    {
      name: 'task-id',
      short: 'i',
      description: 'Task identifier',
      type: 'string',
      required: true,
    },
    {
      name: 'success',
      short: 's',
      description: 'Whether the task succeeded',
      type: 'boolean',
      required: false,
    },
    {
      name: 'duration',
      short: 'd',
      description: 'Task duration in milliseconds',
      type: 'number',
    },
    {
      name: 'outcome',
      short: 'o',
      description: 'Outcome description',
      type: 'string',
    },
    {
      name: 'route-id',
      short: 'r',
      description: 'Route ID from a prior hooks route call (joins recommendation to outcome)',
      type: 'string',
    },
  ],
  examples: [
    {
      command: 'monomind hooks post-task -i task-123 --success true',
      description: 'Record successful task',
    },
    {
      command: 'monomind hooks post-task -i task-456 --success false -o "Build failed"',
      description: 'Record failed task',
    },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const taskId = ctx.args[0] || (ctx.flags['task-id'] as string);
    // Default success to true for backward compatibility
    const success = ctx.flags.success !== undefined ? (ctx.flags.success as boolean) : true;

    if (!taskId) {
      output.printError('Task ID is required. Use --task-id or -i flag.');
      return { success: false, exitCode: 1 };
    }

    output.printInfo(`Recording task completion: ${output.highlight(taskId)}`);

    try {
      const result = await callMCPTool<{
        taskId: string;
        success: boolean;
        learningUpdates?: {
          controller: string;
          outcomePersisted: boolean;
        };
        feedback?: { recorded: boolean };
        nextRecommendations?: string[];
      }>('hooks_post-task', {
        taskId,
        success,
        duration: ctx.flags.duration,
        outcome: ctx.flags.outcome,
        routeId: ctx.flags['route-id'],
        timestamp: Date.now(),
      });

      if (ctx.flags.format === 'json') {
        output.printJson(result);
        return { success: true, data: result };
      }

      output.writeln();
      output.printSuccess(`Task ${taskId} recorded as ${success ? 'successful' : 'failed'}`);

      if (result.learningUpdates) {
        output.writeln();
        output.writeln(
          output.dim(
            `Learning feedback: ${result.feedback?.recorded ? `recorded (${result.learningUpdates.controller})` : 'not recorded'}`,
          ),
        );
        output.writeln(
          output.dim(
            `Routing outcome: ${result.learningUpdates.outcomePersisted ? 'saved' : 'not saved'}`,
          ),
        );
      }

      if (result.nextRecommendations && result.nextRecommendations.length > 0) {
        output.writeln();
        output.writeln(output.bold('Recommendations for Next Task'));
        output.printList(result.nextRecommendations);
      }

      return { success: true, data: result };
    } catch (error) {
      if (error instanceof MCPClientError) {
        output.printError(`Post-task hook failed: ${error.message}`);
      } else {
        output.printError(`Unexpected error: ${String(error)}`);
      }
      return { success: false, exitCode: 1 };
    }
  },
};
