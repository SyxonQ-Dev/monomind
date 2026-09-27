/**
 * Session MCP Tools — session_list, session_delete, session_info.
 * Extracted from session-tools.ts.
 */

import { existsSync, statSync, unlinkSync } from 'node:fs';
import { getSessionPath, listSessions, loadSession } from './session-tools-store.js';
import type { MCPTool } from './types.js';

export const sessionQueryTools: MCPTool[] = [
  {
    name: 'session_list',
    description: 'List saved sessions',
    category: 'session',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Maximum sessions to return' },
        sortBy: { type: 'string', description: 'Sort field (date, name, size)' },
      },
    },
    handler: async (input) => {
      let sessions = listSessions();

      // Sort
      const sortBy = (input.sortBy as string) || 'date';
      if (sortBy === 'date') {
        sessions.sort((a, b) => new Date(b.savedAt).getTime() - new Date(a.savedAt).getTime());
      } else if (sortBy === 'name') {
        sessions.sort((a, b) => a.name.localeCompare(b.name));
      } else if (sortBy === 'size') {
        sessions.sort((a, b) => b.stats.totalSize - a.stats.totalSize);
      }

      // Apply limit — clamp to [1, 200] to prevent negative-slice and OOM
      const rawLimit = typeof input.limit === 'number' ? input.limit : 10;
      const limit = Math.max(1, Math.min(rawLimit, 200));
      const totalCount = sessions.length;
      sessions = sessions.slice(0, limit);

      return {
        sessions: sessions.map((s) => ({
          sessionId: s.sessionId,
          name: s.name,
          description: s.description,
          savedAt: s.savedAt,
          stats: s.stats,
        })),
        total: totalCount,
        limit,
      };
    },
  },
  {
    name: 'session_delete',
    description: 'Delete a saved session',
    category: 'session',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Session ID to delete' },
      },
      required: ['sessionId'],
    },
    handler: async (input) => {
      const sessionId = input.sessionId as string;
      const path = getSessionPath(sessionId);

      if (existsSync(path)) {
        unlinkSync(path);
        return {
          sessionId,
          deleted: true,
          deletedAt: new Date().toISOString(),
        };
      }

      return {
        sessionId,
        deleted: false,
        error: 'Session not found',
      };
    },
  },
  {
    name: 'session_info',
    description: 'Get detailed session information',
    category: 'session',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: 'Session ID (defaults to the most recently saved session)',
        },
        includeStats: {
          type: 'boolean',
          description: 'Include per-session statistics in the response',
        },
      },
      // `sessionId` is deliberately NOT required — it defaults to the most
      // recent session, which is what the `session current` CLI subcommand
      // asks for. It used to be declared required while the CLI called this
      // tool with no id at all; nothing enforced the declaration, so instead
      // of an error the undefined id reached getSessionPath(), threw a
      // TypeError on `.replace`, and was swallowed by loadSession()'s catch.
      // The net effect was that `session current` could never succeed — it
      // always reported "Session not found".
    },
    handler: async (input) => {
      const sessionId =
        (input.sessionId as string | undefined) ??
        listSessions().sort(
          (a, b) => new Date(b.savedAt).getTime() - new Date(a.savedAt).getTime(),
        )[0]?.sessionId;

      if (!sessionId) {
        return { sessionId: null, error: 'No saved sessions found' };
      }

      const session = loadSession(sessionId);

      if (session) {
        const path = getSessionPath(sessionId);
        // Guard against TOCTOU: the file could be deleted between loadSession()
        // and statSync().  Catch ENOENT (and any other fs error) so the MCP
        // handler never throws an unhandled exception; callers get a clean
        // response instead of a server-side crash.
        let fileSize = 0;
        try {
          fileSize = statSync(path).size;
        } catch {
          // File deleted or inaccessible after loadSession succeeded
        }

        return {
          sessionId: session.sessionId,
          name: session.name,
          description: session.description,
          savedAt: session.savedAt,
          stats: session.stats,
          fileSize,
          hasData: {
            memory: !!session.data?.memory,
            tasks: !!session.data?.tasks,
            agents: !!session.data?.agents,
          },
        };
      }

      return {
        sessionId,
        error: 'Session not found',
      };
    },
  },
];
