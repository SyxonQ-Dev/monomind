/**
 * Session MCP Tools — persistent store and related-data loaders.
 * Extracted from session-tools.ts.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { getMonomindDataRoot } from './types.js';

// Storage paths — SESSION_DIR is relative to the git-safe data root
const SESSION_DIR = 'sessions';

export interface SessionRecord {
  sessionId: string;
  name: string;
  description?: string;
  savedAt: string;
  stats: {
    tasks: number;
    agents: number;
    memoryEntries: number;
    totalSize: number;
  };
  data?: {
    memory?: Record<string, unknown>;
    tasks?: Record<string, unknown>;
    agents?: Record<string, unknown>;
  };
}

function getSessionDir(): string {
  return join(getMonomindDataRoot(), SESSION_DIR);
}

export function getSessionPath(sessionId: string): string {
  // Sanitize sessionId to prevent path traversal
  const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(getSessionDir(), `${safeId}.json`);
}

function ensureSessionDir(): void {
  const dir = getSessionDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export const MAX_SESSION_BYTES = 50 * 1024 * 1024;

export function loadSession(sessionId: string): SessionRecord | null {
  try {
    const path = getSessionPath(sessionId);
    if (existsSync(path)) {
      if (statSync(path).size > MAX_SESSION_BYTES) return null;
      const data = readFileSync(path, 'utf-8');
      return JSON.parse(data);
    }
  } catch (e) {
    if (process.env.DEBUG || process.env.MONOMIND_DEBUG)
      console.error('[session-tools] loadSession failed:', e);
  }
  return null;
}

export function saveSession(session: SessionRecord): void {
  ensureSessionDir();
  const sessionPath = getSessionPath(session.sessionId);
  // Unique tmp filename so concurrent session_save calls cannot collide on
  // the same .tmp path (which would corrupt the rename target).
  const tmpPath = `${sessionPath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(session, null, 2), 'utf-8');
  renameSync(tmpPath, sessionPath);
}

export function listSessions(limit = 200): SessionRecord[] {
  ensureSessionDir();
  const dir = getSessionDir();
  // Sort by mtime DESC, then bound reads to `limit` files to prevent DoS
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        const stat = statSync(join(dir, f));
        return { name: f, mtimeMs: stat.mtimeMs };
      } catch {
        return { name: f, mtimeMs: 0 };
      }
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, Math.max(1, Math.min(limit, 1000)));

  const sessions: SessionRecord[] = [];
  for (const file of files) {
    try {
      const filePath = join(dir, file.name);
      if (statSync(filePath).size > MAX_SESSION_BYTES) continue;
      const data = readFileSync(filePath, 'utf-8');
      sessions.push(JSON.parse(data));
    } catch {
      // Skip invalid files
    }
  }

  return sessions;
}

// Load related stores for session data
export function loadRelatedStores(options: {
  includeMemory?: boolean;
  includeTasks?: boolean;
  includeAgents?: boolean;
}) {
  const data: SessionRecord['data'] = {};

  if (options.includeMemory) {
    try {
      const memoryPath = join(getMonomindDataRoot(), 'memory', 'store.json');
      if (existsSync(memoryPath) && statSync(memoryPath).size <= MAX_SESSION_BYTES) {
        data.memory = JSON.parse(readFileSync(memoryPath, 'utf-8'));
      }
    } catch (e) {
      if (process.env.DEBUG || process.env.MONOMIND_DEBUG)
        console.error('[session-tools] failed to load memory store:', e);
    }
  }

  if (options.includeTasks) {
    try {
      const taskPath = join(getMonomindDataRoot(), 'tasks', 'store.json');
      if (existsSync(taskPath) && statSync(taskPath).size <= MAX_SESSION_BYTES) {
        data.tasks = JSON.parse(readFileSync(taskPath, 'utf-8'));
      }
    } catch (e) {
      if (process.env.DEBUG || process.env.MONOMIND_DEBUG)
        console.error('[session-tools] failed to load task store:', e);
    }
  }

  if (options.includeAgents) {
    try {
      const agentPath = join(getMonomindDataRoot(), 'agents', 'store.json');
      if (existsSync(agentPath) && statSync(agentPath).size <= MAX_SESSION_BYTES) {
        data.agents = JSON.parse(readFileSync(agentPath, 'utf-8'));
      }
    } catch (e) {
      if (process.env.DEBUG || process.env.MONOMIND_DEBUG)
        console.error('[session-tools] failed to load agent store:', e);
    }
  }

  return data;
}
