import { join } from 'node:path';
import { readJsonStoreOrNull, writeJsonFileAtomic } from '../utils/json-file.js';
import { FORBIDDEN_TASK_IDS, loadTaskStoreOrNull, saveTaskStore } from './task-tools-core.js';
import { getMonomindDataRoot, type MCPTool } from './types.js';

export const taskAssignTool: MCPTool = {
  name: 'task_assign',
  description: 'Assign a task to one or more agents',
  category: 'task',
  inputSchema: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: 'Task ID to assign' },
      agentIds: { type: 'array', items: { type: 'string' }, description: 'Agent IDs to assign' },
      unassign: { type: 'boolean', description: 'Unassign all agents from task' },
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
    if (FORBIDDEN_TASK_IDS.has(taskId)) return { taskId, error: 'Task not found' };
    const task = store.tasks[taskId];

    if (!task) {
      return { taskId, error: 'Task not found' };
    }

    const previouslyAssigned = [...task.assignedTo];

    // Load agent store to sync worker state. Distinguish "file doesn't
    // exist yet" (safe to proceed with an empty store) from "file exists
    const agentStorePath = join(getMonomindDataRoot(), 'agents', 'store.json');
    const agentStore = readJsonStoreOrNull<{ agents: Record<string, Record<string, unknown>> }>(
      agentStorePath,
      { agents: {} },
      'task_assign/agent-sync',
    );
    const agentStoreReadFailed = agentStore === null;

    const FORBIDDEN_AGENT_IDS = new Set(['__proto__', 'constructor', 'prototype']);
    const isValidAgentId = (id: unknown): id is string =>
      typeof id === 'string' && id.length > 0 && id.length <= 128 && !FORBIDDEN_AGENT_IDS.has(id);

    if (!agentStoreReadFailed) {
      if (input.unassign) {
        for (const agentId of previouslyAssigned) {
          if (isValidAgentId(agentId) && Object.hasOwn(agentStore.agents, agentId)) {
            agentStore.agents[agentId].status = 'idle';
            agentStore.agents[agentId].currentTask = null;
          }
        }
        task.assignedTo = [];
      } else {
        const rawIds = (input.agentIds as string[]) || [];
        const agentIds = rawIds.filter(isValidAgentId);
        for (const agentId of previouslyAssigned) {
          if (
            isValidAgentId(agentId) &&
            !agentIds.includes(agentId) &&
            Object.hasOwn(agentStore.agents, agentId)
          ) {
            agentStore.agents[agentId].status = 'idle';
            agentStore.agents[agentId].currentTask = null;
          }
        }
        for (const agentId of agentIds) {
          if (Object.hasOwn(agentStore.agents, agentId)) {
            agentStore.agents[agentId].status = 'busy';
            agentStore.agents[agentId].currentTask = taskId;
          }
        }
        task.assignedTo = agentIds;
        if (task.status === 'pending' && agentIds.length > 0) {
          task.status = 'in_progress';
          if (!task.startedAt) {
            task.startedAt = new Date().toISOString();
          }
        }
      }
    } else {
      // Agent store corrupt — still update task assignments from input
      if (input.unassign) {
        task.assignedTo = [];
      } else {
        task.assignedTo = ((input.agentIds as string[]) || []).filter(isValidAgentId);
        if (task.status === 'pending' && task.assignedTo.length > 0) {
          task.status = 'in_progress';
          if (!task.startedAt) task.startedAt = new Date().toISOString();
        }
      }
    }

    saveTaskStore(store);
    if (!agentStoreReadFailed) {
      writeJsonFileAtomic(agentStorePath, agentStore);
    }

    return {
      taskId: task.taskId,
      assignedTo: task.assignedTo,
      previouslyAssigned,
      status: task.status,
      ...(agentStoreReadFailed ? { agentStoreSyncSkipped: true } : {}),
    };
  },
};

export const taskCancelTool: MCPTool = {
  name: 'task_cancel',
  description: 'Cancel a task',
  category: 'task',
  inputSchema: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: 'Task ID' },
      reason: { type: 'string', description: 'Cancellation reason' },
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
      task.status = 'cancelled';
      task.completedAt = new Date().toISOString();
      // Cap reason: persisted verbatim to the task store on disk.
      // Without a cap an attacker can inflate the store with an arbitrarily
      // large cancellation reason string.
      const MAX_CANCEL_REASON_LEN = 1024;
      const rawReason = input.reason as string | undefined;
      const cancelReason =
        typeof rawReason === 'string' && rawReason.length > MAX_CANCEL_REASON_LEN
          ? rawReason.slice(0, MAX_CANCEL_REASON_LEN)
          : rawReason || 'Cancelled by user';
      task.result = { cancelReason };
      saveTaskStore(store);

      return {
        success: true,
        taskId: task.taskId,
        status: task.status,
        cancelledAt: task.completedAt,
      };
    }

    return {
      success: false,
      taskId,
      error: 'Task not found',
    };
  },
};
