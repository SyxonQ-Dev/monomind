import {
  loadTerminalStore,
  loadTerminalStoreOrNull,
  saveTerminalStore,
} from './terminal-tools-core.js';
import type { MCPTool } from './types.js';

export const terminalListTool: MCPTool = {
  name: 'terminal_list',
  description: 'List all terminal sessions',
  category: 'terminal',
  inputSchema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['all', 'active', 'idle', 'closed'],
        description: 'Filter by status',
      },
      includeHistory: { type: 'boolean', description: 'Include command history' },
    },
  },
  handler: async (input: Record<string, unknown>) => {
    const store = loadTerminalStore();
    let sessions = Object.values(store.sessions);
    const status = input.status as string | undefined;
    if (status && status !== 'all') {
      sessions = sessions.filter((s) => s.status === status);
    }
    return {
      sessions: sessions.map((s) => ({
        id: s.id,
        name: s.name,
        status: s.status,
        workingDir: s.workingDir,
        createdAt: s.createdAt,
        lastActivity: s.lastActivity,
        historyLength: s.history.length,
        ...(input.includeHistory ? { history: s.history.slice(-10) } : {}),
      })),
      total: sessions.length,
      active: sessions.filter((s) => s.status === 'active').length,
    };
  },
};

export const terminalCloseTool: MCPTool = {
  name: 'terminal_close',
  description: 'Close a terminal session',
  category: 'terminal',
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: { type: 'string', description: 'Session ID to close' },
      force: { type: 'boolean', description: 'Force close' },
    },
    required: ['sessionId'],
  },
  handler: async (input: Record<string, unknown>) => {
    const store = loadTerminalStoreOrNull();
    if (!store) {
      return {
        success: false,
        error:
          'Terminal store is unreadable/corrupt — refusing to close a session to avoid overwriting real session data.',
      };
    }
    const sessionId = input.sessionId as string | undefined;
    const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
    if (!sessionId || FORBIDDEN_KEYS.has(sessionId)) {
      return { success: false, error: 'Invalid sessionId' };
    }
    const session = Object.hasOwn(store.sessions, sessionId)
      ? store.sessions[sessionId]
      : undefined;
    if (!session) {
      return { success: false, error: 'Session not found' };
    }
    session.status = 'closed';
    saveTerminalStore(store);
    return {
      success: true,
      sessionId,
      closedAt: new Date().toISOString(),
    };
  },
};

export const terminalHistoryTool: MCPTool = {
  name: 'terminal_history',
  description: 'Get command history for a terminal session',
  category: 'terminal',
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: { type: 'string', description: 'Session ID' },
      limit: { type: 'number', description: 'Number of entries to return' },
      offset: { type: 'number', description: 'Offset from latest' },
    },
  },
  handler: async (input: Record<string, unknown>) => {
    const store = loadTerminalStore();
    const sessionId = input.sessionId as string | undefined;
    const limit = (input.limit as number) || 50;
    const offset = (input.offset as number) || 0;
    const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
    if (sessionId) {
      if (
        typeof sessionId !== 'string' ||
        FORBIDDEN_KEYS.has(sessionId) ||
        !Object.hasOwn(store.sessions, sessionId)
      ) {
        return { success: false, error: 'Invalid sessionId' };
      }
      const session = store.sessions[sessionId];
      if (!session) {
        return { success: false, error: 'Session not found' };
      }
      const history = session.history.slice(-(limit + offset), offset ? -offset : undefined);
      return {
        sessionId,
        history,
        total: session.history.length,
      };
    }
    // Return combined history from all sessions
    const allHistory = Object.values(store.sessions)
      .flatMap((s) => s.history.map((h) => ({ ...h, sessionId: s.id })))
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(offset, offset + limit);
    return {
      history: allHistory,
      total: allHistory.length,
    };
  },
};
