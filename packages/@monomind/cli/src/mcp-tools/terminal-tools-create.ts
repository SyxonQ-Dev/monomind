import { randomBytes } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import {
  loadTerminalStoreOrNull,
  saveTerminalStore,
  type TerminalSession,
} from './terminal-tools-core.js';
import type { MCPTool } from './types.js';
import { getProjectCwd } from './types.js';

export const terminalCreateTool: MCPTool = {
  name: 'terminal_create',
  description: 'Create a new terminal session',
  category: 'terminal',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Session name' },
      workingDir: { type: 'string', description: 'Working directory' },
      env: { type: 'object', description: 'Environment variables' },
    },
  },
  handler: async (input: Record<string, unknown>) => {
    const store = loadTerminalStoreOrNull();
    if (!store) {
      return {
        success: false,
        error:
          'Terminal store is unreadable/corrupt — refusing to create a session to avoid overwriting real session data.',
      };
    }
    const MAX_SESSIONS = 1000;
    if (Object.keys(store.sessions).length >= MAX_SESSIONS) {
      return { success: false, error: 'Session limit reached' };
    }
    const FORBIDDEN_ENV_KEYS = new Set([
      'PATH',
      'LD_PRELOAD',
      'LD_LIBRARY_PATH',
      'NODE_OPTIONS',
      'NODE_PATH',
      'DYLD_INSERT_LIBRARIES',
      'DYLD_LIBRARY_PATH',
    ]);
    const rawEnv = (input.env as Record<string, unknown>) || {};
    const safeEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawEnv)) {
      if (!FORBIDDEN_ENV_KEYS.has(k) && /^[A-Z_][A-Z0-9_]*$/i.test(k)) {
        safeEnv[k] = String(v);
      }
    }
    // Validate workingDir: must exist, be a directory, and not escape to
    // system-sensitive paths. Fall back to project cwd if invalid.
    let resolvedWorkingDir = getProjectCwd();
    if (input.workingDir && typeof input.workingDir === 'string') {
      const candidate = resolve(input.workingDir);
      const projectCwd = getProjectCwd();
      const home = homedir();
      // Allow paths under project cwd or user home directory only.
      const isUnderProject =
        candidate === projectCwd ||
        candidate.startsWith(`${projectCwd}/`) ||
        candidate.startsWith(`${projectCwd}\\`);
      const isUnderHome =
        candidate === home || candidate.startsWith(`${home}/`) || candidate.startsWith(`${home}\\`);
      if ((isUnderProject || isUnderHome) && existsSync(candidate)) {
        try {
          if (statSync(candidate).isDirectory()) {
            resolvedWorkingDir = candidate;
          }
        } catch {
          // Leave resolvedWorkingDir as default
        }
      }
    }
    const id = `term-${Date.now()}-${randomBytes(4).toString('hex')}`;
    // Cap session name: stored in terminal JSON store on disk.
    const MAX_TERMINAL_NAME_LEN = 256;
    const rawTerminalName =
      (input.name as string) || `Terminal ${Object.keys(store.sessions).length + 1}`;
    const terminalName =
      typeof rawTerminalName === 'string' && rawTerminalName.length > MAX_TERMINAL_NAME_LEN
        ? rawTerminalName.slice(0, MAX_TERMINAL_NAME_LEN)
        : rawTerminalName;
    const session: TerminalSession = {
      id,
      name: terminalName,
      status: 'active',
      createdAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
      workingDir: resolvedWorkingDir,
      history: [],
      env: safeEnv,
    };
    store.sessions[id] = session;
    saveTerminalStore(store);
    return {
      success: true,
      sessionId: id,
      name: session.name,
      status: session.status,
      workingDir: session.workingDir,
      createdAt: session.createdAt,
    };
  },
};
