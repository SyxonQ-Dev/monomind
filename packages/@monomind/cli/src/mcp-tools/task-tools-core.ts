import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonStoreOrNull, writeJsonFileAtomic } from '../utils/json-file.js';
import { getMonomindDataRoot } from './types.js';

// Storage paths — relative to the git-safe data root
const TASK_DIR = 'tasks';
const TASK_FILE = 'store.json';

export interface TaskRecord {
  taskId: string;
  type: string;
  description: string;
  priority: 'low' | 'normal' | 'high' | 'critical';
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled';
  progress: number;
  assignedTo: string[];
  tags: string[];
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  result?: Record<string, unknown>;
}

interface TaskStore {
  tasks: Record<string, TaskRecord>;
  version: string;
}

function getTaskDir(): string {
  return join(getMonomindDataRoot(), TASK_DIR);
}

function getTaskPath(): string {
  return join(getTaskDir(), TASK_FILE);
}

function ensureTaskDir(): void {
  const dir = getTaskDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function loadTaskStoreOrNull(): TaskStore | null {
  return readJsonStoreOrNull<TaskStore>(
    getTaskPath(),
    { tasks: {}, version: '3.0.0' },
    'loadTaskStore',
  );
}

export function loadTaskStore(): TaskStore {
  return loadTaskStoreOrNull() ?? { tasks: {}, version: '3.0.0' };
}

export function saveTaskStore(store: TaskStore): void {
  ensureTaskDir();
  writeJsonFileAtomic(getTaskPath(), store);
}

export const FORBIDDEN_TASK_IDS = new Set(['__proto__', 'constructor', 'prototype']);
