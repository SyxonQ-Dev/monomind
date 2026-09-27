import { randomBytes } from 'node:crypto';
import {
  FORBIDDEN_TASK_IDS,
  loadTaskStore,
  loadTaskStoreOrNull,
  saveTaskStore,
  type TaskRecord,
} from './task-tools-core.js';
import type { MCPTool } from './types.js';

export const taskCreateTool: MCPTool = {
  name: 'task_create',
  description: 'Create a new task',
  category: 'task',
  inputSchema: {
    type: 'object',
    properties: {
      type: { type: 'string', description: 'Task type (feature, bugfix, research, refactor)' },
      description: { type: 'string', description: 'Task description' },
      priority: { type: 'string', description: 'Task priority (low, normal, high, critical)' },
      assignTo: { type: 'array', items: { type: 'string' }, description: 'Agent IDs to assign' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Task tags' },
    },
    required: ['type', 'description'],
  },
  handler: async (input) => {
    const store = loadTaskStoreOrNull();
    if (!store)
      return {
        success: false,
        error: 'Task store is corrupt or unreadable — refusing to overwrite',
      };
    const taskId = `task-${Date.now()}-${randomBytes(4).toString('hex')}`;

    // Cap all string fields: they are persisted verbatim to the task JSON store.
    const MAX_TASK_TYPE_LEN = 128;
    const MAX_TASK_DESC_LEN = 64 * 1024; // 64 KB — realistic task descriptions
    const MAX_TASK_ASSIGNEE_LEN = 256;
    const MAX_TASK_ASSIGNEES = 100;
    const MAX_TASK_TAG_LEN = 128;
    const MAX_TASK_TAGS = 50;
    const rawTaskType = input.type as string;
    const taskType =
      typeof rawTaskType === 'string' && rawTaskType.length > MAX_TASK_TYPE_LEN
        ? rawTaskType.slice(0, MAX_TASK_TYPE_LEN)
        : rawTaskType;
    const rawTaskDesc = input.description as string;
    const taskDesc =
      typeof rawTaskDesc === 'string' && rawTaskDesc.length > MAX_TASK_DESC_LEN
        ? rawTaskDesc.slice(0, MAX_TASK_DESC_LEN)
        : rawTaskDesc;
    const rawAssignTo = (input.assignTo as string[]) || [];
    const assignedTo = Array.isArray(rawAssignTo)
      ? rawAssignTo
          .slice(0, MAX_TASK_ASSIGNEES)
          .map((a) =>
            typeof a === 'string' && a.length > MAX_TASK_ASSIGNEE_LEN
              ? a.slice(0, MAX_TASK_ASSIGNEE_LEN)
              : a,
          )
      : [];
    const rawTags = (input.tags as string[]) || [];
    const tags = Array.isArray(rawTags)
      ? rawTags
          .slice(0, MAX_TASK_TAGS)
          .map((t) =>
            typeof t === 'string' && t.length > MAX_TASK_TAG_LEN ? t.slice(0, MAX_TASK_TAG_LEN) : t,
          )
      : [];

    const task: TaskRecord = {
      taskId,
      type: taskType,
      description: taskDesc,
      priority: (input.priority as TaskRecord['priority']) || 'normal',
      status: 'pending',
      progress: 0,
      assignedTo,
      tags,
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
    };

    store.tasks[taskId] = task;
    saveTaskStore(store);

    return {
      taskId,
      type: task.type,
      description: task.description,
      priority: task.priority,
      status: task.status,
      createdAt: task.createdAt,
      assignedTo: task.assignedTo,
      tags: task.tags,
    };
  },
};

export const taskStatusTool: MCPTool = {
  name: 'task_status',
  description: 'Get task status',
  category: 'task',
  inputSchema: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: 'Task ID' },
    },
    required: ['taskId'],
  },
  handler: async (input) => {
    const store = loadTaskStore();
    const taskId = input.taskId as string;
    if (FORBIDDEN_TASK_IDS.has(taskId))
      return { taskId, status: 'not_found', error: 'Task not found' };
    const task = store.tasks[taskId];

    if (task) {
      return {
        taskId: task.taskId,
        type: task.type,
        description: task.description,
        status: task.status,
        progress: task.progress,
        priority: task.priority,
        assignedTo: task.assignedTo,
        tags: task.tags,
        createdAt: task.createdAt,
        startedAt: task.startedAt,
        completedAt: task.completedAt,
        result: task.result || null,
      };
    }

    return {
      taskId,
      status: 'not_found',
      error: 'Task not found',
    };
  },
};

export const taskListTool: MCPTool = {
  name: 'task_list',
  description: 'List all tasks',
  category: 'task',
  inputSchema: {
    type: 'object',
    properties: {
      status: { type: 'string', description: 'Filter by status' },
      type: { type: 'string', description: 'Filter by type' },
      assignedTo: { type: 'string', description: 'Filter by assigned agent' },
      priority: { type: 'string', description: 'Filter by priority' },
      limit: { type: 'number', description: 'Max tasks to return' },
    },
  },
  handler: async (input) => {
    const store = loadTaskStore();
    let tasks = Object.values(store.tasks);

    // Apply filters
    // 'all' is a sentinel meaning "do not filter", not a status any task has.
    // Without this, `task list --all` and `monomind status tasks` — both of
    // which pass status:'all' — matched nothing and reported an empty store
    // while tasks existed on disk.
    if (input.status && input.status !== 'all') {
      // Support comma-separated status values
      const statuses = (input.status as string)
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== 'all');
      if (statuses.length > 0) tasks = tasks.filter((t) => statuses.includes(t.status));
    }
    if (input.type) {
      tasks = tasks.filter((t) => t.type === input.type);
    }
    if (input.assignedTo) {
      tasks = tasks.filter((t) => t.assignedTo.includes(input.assignedTo as string));
    }
    if (input.priority) {
      tasks = tasks.filter((t) => t.priority === input.priority);
    }

    // Sort by creation date (newest first)
    tasks.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    // Apply limit — cap to 1 000 to prevent returning the entire task store
    // in one response, which could cause OOM on large deployments.
    const MAX_TASK_LIMIT = 1_000;
    const rawLimit = typeof input.limit === 'number' ? input.limit : 50;
    const limit =
      Number.isFinite(rawLimit) && rawLimit > 0
        ? Math.min(Math.floor(rawLimit), MAX_TASK_LIMIT)
        : 50;
    tasks = tasks.slice(0, limit);

    return {
      tasks: tasks.map((t) => ({
        taskId: t.taskId,
        type: t.type,
        description: t.description,
        status: t.status,
        progress: t.progress,
        priority: t.priority,
        assignedTo: t.assignedTo,
        createdAt: t.createdAt,
      })),
      total: tasks.length,
      filters: {
        status: input.status,
        type: input.type,
        assignedTo: input.assignedTo,
        priority: input.priority,
      },
    };
  },
};
