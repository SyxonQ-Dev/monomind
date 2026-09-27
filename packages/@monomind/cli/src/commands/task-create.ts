import { callMCPTool, MCPClientError } from '../mcp-client.js';
import { output } from '../output.js';
import { input, select } from '../prompt.js';
import type { Command, CommandContext, CommandResult } from '../types.js';
import {
  formatPriority,
  formatStatus,
  MAX_ASSIGN_LEN,
  MAX_DEP_LEN,
  MAX_DEPS,
  MAX_DESCRIPTION_LEN,
  MAX_TAG_LEN,
  MAX_TAGS,
  TASK_PRIORITIES,
  TASK_TYPES,
} from './task-shared.js';

// Create subcommand
export const createCommand: Command = {
  name: 'create',
  aliases: ['new', 'add'],
  description: 'Create a new task',
  options: [
    {
      name: 'type',
      short: 't',
      description: 'Task type',
      type: 'string',
      choices: TASK_TYPES.map((t) => t.value),
    },
    {
      name: 'description',
      short: 'd',
      description: 'Task description',
      type: 'string',
    },
    {
      name: 'priority',
      short: 'p',
      description: 'Task priority',
      type: 'string',
      choices: TASK_PRIORITIES.map((p) => p.value),
      default: 'normal',
    },
    {
      name: 'assign',
      short: 'a',
      description: 'Assign to agent(s)',
      type: 'string',
    },
    {
      name: 'tags',
      description: 'Comma-separated tags',
      type: 'string',
    },
    {
      name: 'parent',
      description: 'Parent task ID',
      type: 'string',
    },
    {
      name: 'dependencies',
      description: 'Comma-separated task IDs that must complete first',
      type: 'string',
    },
    {
      name: 'timeout',
      description: 'Task timeout in seconds',
      type: 'number',
      default: 300,
    },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    let taskType = ctx.flags.type as string;
    let description = ctx.flags.description as string;
    let priority = ctx.flags.priority as string;

    // Interactive mode
    if (!taskType && ctx.interactive) {
      taskType = await select({
        message: 'Select task type:',
        options: TASK_TYPES,
      });
    }

    if (!description && ctx.interactive) {
      description = await input({
        message: 'Task description:',
        validate: (v) => v.length > 0 || 'Description is required',
      });
    }

    if (!taskType || !description) {
      output.printError('Task type and description are required');
      output.printInfo('Use --type and --description flags, or run in interactive mode');
      return { success: false, exitCode: 1 };
    }

    // Cap description length
    description = description.slice(0, MAX_DESCRIPTION_LEN);

    if (!priority && ctx.interactive) {
      priority = await select({
        message: 'Select priority:',
        options: TASK_PRIORITIES,
        default: 'normal',
      });
    }

    // Parse and cap tags and dependencies
    const tags = ctx.flags.tags
      ? (ctx.flags.tags as string)
          .split(',')
          .map((t) => t.trim().slice(0, MAX_TAG_LEN))
          .filter(Boolean)
          .slice(0, MAX_TAGS)
      : [];
    const dependencies = ctx.flags.dependencies
      ? (ctx.flags.dependencies as string)
          .split(',')
          .map((d) => d.trim().slice(0, MAX_DEP_LEN))
          .filter(Boolean)
          .slice(0, MAX_DEPS)
      : [];

    output.writeln();
    output.printInfo(`Creating ${taskType} task...`);

    try {
      const result = await callMCPTool<{
        taskId: string;
        type: string;
        description: string;
        priority: string;
        status: string;
        createdAt: string;
        assignedTo?: string[];
        tags: string[];
      }>('task_create', {
        type: taskType,
        description,
        priority: priority || 'normal',
        assignedTo: ctx.flags.assign
          ? [(ctx.flags.assign as string).slice(0, MAX_ASSIGN_LEN)]
          : undefined,
        parentId: ctx.flags.parent,
        dependencies,
        tags,
        timeout: ctx.flags.timeout,
        metadata: {
          source: 'cli',
          createdBy: 'user',
        },
      });

      output.writeln();
      output.printSuccess(`Task created: ${result.taskId}`);
      output.writeln();

      output.printTable({
        columns: [
          { key: 'property', header: 'Property', width: 15 },
          { key: 'value', header: 'Value', width: 40 },
        ],
        data: [
          { property: 'ID', value: result.taskId },
          { property: 'Type', value: result.type },
          { property: 'Description', value: result.description },
          { property: 'Priority', value: formatPriority(result.priority) },
          { property: 'Status', value: formatStatus(result.status) },
          { property: 'Assigned To', value: result.assignedTo?.join(', ') || 'Unassigned' },
          { property: 'Tags', value: result.tags.join(', ') || 'None' },
          { property: 'Created', value: new Date(result.createdAt).toLocaleString() },
        ],
      });

      if (ctx.flags.format === 'json') {
        output.printJson(result);
      }

      return { success: true, data: result };
    } catch (error) {
      if (error instanceof MCPClientError) {
        output.printError(`Failed to create task: ${error.message}`);
      } else {
        output.printError(`Unexpected error: ${String(error)}`);
      }
      return { success: false, exitCode: 1 };
    }
  },
};
