import { join } from 'node:path';
import { readJsonStoreOrNull, writeJsonFileAtomic } from '../utils/json-file.js';
import {
  FORBIDDEN_TASK_IDS,
  loadTaskStoreOrNull,
  saveTaskStore,
  type TaskRecord,
} from './task-tools-core.js';
import { getMonomindDataRoot, type MCPTool } from './types.js';

export const taskCompleteTool: MCPTool = {
  name: 'task_complete',
  description: 'Mark task as complete',
  category: 'task',
  inputSchema: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: 'Task ID' },
      result: { type: 'object', description: 'Task result data' },
    },
    required: ['taskId'],
  },
  handler: async (input) => {
    const store = loadTaskStoreOrNull();
    if (!store)
      return {
        success: false,
        error: 'Task store is corrupt or unreadable — refusing to overwrite',
      };
    const taskId = input.taskId as string;
    if (FORBIDDEN_TASK_IDS.has(taskId))
      return { taskId, status: 'not_found', error: 'Task not found' };
    const task = store.tasks[taskId];

    if (task) {
      task.status = 'completed';
      task.progress = 100;
      task.completedAt = new Date().toISOString();
      task.result = (input.result as Record<string, unknown>) || {};
      saveTaskStore(store);

      // Sync assigned agents back to idle and increment taskCount
      if (task.assignedTo.length > 0) {
        const agentStorePath = join(getMonomindDataRoot(), 'agents', 'store.json');
        try {
          const agentStore = readJsonStoreOrNull<{
            agents: Record<string, Record<string, unknown>>;
          }>(agentStorePath, { agents: {} }, 'task_complete/agent-sync');
          if (agentStore) {
            const FORBIDDEN_AGENT_IDS_TC = new Set(['__proto__', 'constructor', 'prototype']);
            for (const agentId of task.assignedTo) {
              if (
                typeof agentId === 'string' &&
                agentId.length > 0 &&
                agentId.length <= 128 &&
                !FORBIDDEN_AGENT_IDS_TC.has(agentId) &&
                Object.hasOwn(agentStore.agents, agentId)
              ) {
                agentStore.agents[agentId].status = 'idle';
                agentStore.agents[agentId].currentTask = null;
                agentStore.agents[agentId].taskCount =
                  ((agentStore.agents[agentId].taskCount as number) || 0) + 1;
              }
            }
            writeJsonFileAtomic(agentStorePath, agentStore);
          }
        } catch (e) {
          if (process.env.DEBUG || process.env.MONOMIND_DEBUG)
            console.error('[task_complete] agent store sync failed:', e);
        }
      }

      return {
        taskId: task.taskId,
        status: task.status,
        completedAt: task.completedAt,
        result: task.result,
      };
    }

    return {
      taskId,
      status: 'not_found',
      error: 'Task not found',
    };
  },
};

export const taskUpdateTool: MCPTool = {
  name: 'task_update',
  description: 'Update task status or progress',
  category: 'task',
  inputSchema: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: 'Task ID' },
      status: { type: 'string', description: 'New status' },
      progress: { type: 'number', description: 'Progress percentage (0-100)' },
      assignTo: { type: 'array', items: { type: 'string' }, description: 'Agent IDs to assign' },
    },
    required: ['taskId'],
  },
  handler: async (input) => {
    const store = loadTaskStoreOrNull();
    if (!store)
      return {
        success: false,
        error: 'Task store is corrupt or unreadable — refusing to overwrite',
      };
    const taskId = input.taskId as string;
    if (FORBIDDEN_TASK_IDS.has(taskId)) return { success: false, taskId, error: 'Task not found' };
    const task = store.tasks[taskId];

    if (task) {
      if (input.status) {
        const newStatus = input.status as TaskRecord['status'];
        task.status = newStatus;
        if (newStatus === 'in_progress' && !task.startedAt) {
          task.startedAt = new Date().toISOString();
        }
      }
      if (typeof input.progress === 'number') {
        task.progress = Math.min(100, Math.max(0, input.progress as number));
      }
      if (input.assignTo) {
        // Cap array and element lengths — task_create already does this;
        // task_update must apply the same guards so the on-disk store
        // cannot be inflated via the update path.
        const MAX_TASK_ASSIGNEE_LEN = 256;
        const MAX_TASK_ASSIGNEES = 100;
        const rawAssignTo = input.assignTo as string[];
        task.assignedTo = Array.isArray(rawAssignTo)
          ? rawAssignTo
              .slice(0, MAX_TASK_ASSIGNEES)
              .map((a) =>
                typeof a === 'string' && a.length > MAX_TASK_ASSIGNEE_LEN
                  ? a.slice(0, MAX_TASK_ASSIGNEE_LEN)
                  : a,
              )
          : task.assignedTo;
      }
      saveTaskStore(store);

      return {
        success: true,
        taskId: task.taskId,
        status: task.status,
        progress: task.progress,
        assignedTo: task.assignedTo,
      };
    }

    return {
      success: false,
      taskId,
      error: 'Task not found',
    };
  },
};
