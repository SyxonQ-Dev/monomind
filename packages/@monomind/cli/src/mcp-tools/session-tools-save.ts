/**
 * Session MCP Tools — session_save, session_restore.
 * Extracted from session-tools.ts.
 */

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  listSessions,
  loadRelatedStores,
  loadSession,
  type SessionRecord,
  saveSession,
} from './session-tools-store.js';
import { getMonomindDataRoot, type MCPTool } from './types.js';

export const sessionSaveTools: MCPTool[] = [
  {
    name: 'session_save',
    description: 'Save current session state',
    category: 'session',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Session name' },
        description: { type: 'string', description: 'Session description' },
        includeMemory: { type: 'boolean', description: 'Include memory in session' },
        includeTasks: { type: 'boolean', description: 'Include tasks in session' },
        includeAgents: { type: 'boolean', description: 'Include agents in session' },
      },
      required: ['name'],
    },
    handler: async (input) => {
      const sessionId = `session-${Date.now()}-${randomBytes(6).toString('hex')}`;

      // Cap name and description: both are persisted verbatim to the session
      // JSON file on disk.  Without a cap, an attacker can inflate the session
      // store by supplying a very long name or description.
      const MAX_SESSION_NAME_LEN = 256;
      const MAX_SESSION_DESC_LEN = 4 * 1024;
      const rawSessionName = input.name as string;
      const sessionName =
        typeof rawSessionName === 'string' && rawSessionName.length > MAX_SESSION_NAME_LEN
          ? rawSessionName.slice(0, MAX_SESSION_NAME_LEN)
          : rawSessionName;
      const rawSessionDesc = input.description as string;
      const sessionDesc =
        typeof rawSessionDesc === 'string' && rawSessionDesc.length > MAX_SESSION_DESC_LEN
          ? rawSessionDesc.slice(0, MAX_SESSION_DESC_LEN)
          : rawSessionDesc;

      // Load related data based on options
      const data = loadRelatedStores({
        includeMemory: input.includeMemory as boolean,
        includeTasks: input.includeTasks as boolean,
        includeAgents: input.includeAgents as boolean,
      });

      // Calculate stats
      const stats = {
        tasks: data.tasks ? Object.keys((data.tasks as { tasks?: object }).tasks || {}).length : 0,
        agents: data.agents
          ? Object.keys((data.agents as { agents?: object }).agents || {}).length
          : 0,
        memoryEntries: data.memory
          ? Object.keys((data.memory as { entries?: object }).entries || {}).length
          : 0,
        totalSize: 0,
      };

      const session: SessionRecord = {
        sessionId,
        name: sessionName,
        description: sessionDesc,
        savedAt: new Date().toISOString(),
        stats,
        data: Object.keys(data).length > 0 ? data : undefined,
      };

      // Calculate size
      const sessionJson = JSON.stringify(session);
      session.stats.totalSize = Buffer.byteLength(sessionJson, 'utf-8');

      saveSession(session);

      return {
        sessionId,
        name: session.name,
        savedAt: session.savedAt,
        stats: session.stats,
      };
    },
  },
  {
    name: 'session_restore',
    description: 'Restore a saved session',
    category: 'session',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Session ID to restore' },
        name: { type: 'string', description: 'Session name to restore' },
      },
    },
    handler: async (input) => {
      let session: SessionRecord | null = null;

      // Try to find by sessionId first
      if (input.sessionId) {
        session = loadSession(input.sessionId as string);
      }

      // Try to find by name if sessionId not found
      if (!session && input.name) {
        const sessions = listSessions();
        session = sessions.find((s) => s.name === input.name) || null;
      }

      // Try to find latest if no params
      if (!session && !input.sessionId && !input.name) {
        const sessions = listSessions();
        if (sessions.length > 0) {
          sessions.sort((a, b) => new Date(b.savedAt).getTime() - new Date(a.savedAt).getTime());
          session = sessions[0];
        }
      }

      if (session) {
        // Restore data to respective stores (legacy JSON for backward compat)
        if (session.data?.memory) {
          const memoryDir = join(getMonomindDataRoot(), 'memory');
          if (!existsSync(memoryDir)) mkdirSync(memoryDir, { recursive: true });
          const memoryStorePath = join(memoryDir, 'store.json');
          {
            const tmp = `${memoryStorePath}.${process.pid}.${Date.now()}.tmp`;
            writeFileSync(tmp, JSON.stringify(session.data.memory, null, 2), 'utf-8');
            renameSync(tmp, memoryStorePath);
          }

          // Also populate active sql.js SQLite database so memory-tools can find entries
          try {
            const { storeEntry } = await import('../memory/memory-initializer.js');
            const memoryData = session.data.memory as {
              entries?: Record<
                string,
                { key?: string; id?: string; value?: string; content?: string; namespace?: string }
              >;
            };
            if (memoryData.entries) {
              // Cap individual key and value lengths before writing to the DB.
              // A malicious or corrupted session file could contain arbitrarily
              // long strings; without caps these flow straight into the HNSW
              // embedder and SQL layer, causing OOM or DoS.
              const MAX_RESTORE_KEY = 1_000;
              const MAX_RESTORE_VALUE = 100_000;
              const MAX_RESTORE_NS = 200;
              for (const entry of Object.values(memoryData.entries)) {
                let key = entry.key || entry.id || '';
                let value = entry.value || entry.content || '';
                if (!key || !value) continue;
                if (key.length > MAX_RESTORE_KEY) key = key.slice(0, MAX_RESTORE_KEY);
                if (value.length > MAX_RESTORE_VALUE) value = value.slice(0, MAX_RESTORE_VALUE);
                const rawNs = entry.namespace || 'restored';
                const namespace =
                  rawNs.length > MAX_RESTORE_NS ? rawNs.slice(0, MAX_RESTORE_NS) : rawNs;
                await storeEntry({ key, value, namespace, upsert: true });
              }
            }
          } catch {
            // Legacy JSON restore is the fallback -- sql.js import may not be available
          }
        }
        if (session.data?.tasks) {
          const taskDir = join(getMonomindDataRoot(), 'tasks');
          if (!existsSync(taskDir)) mkdirSync(taskDir, { recursive: true });
          const taskStorePath = join(taskDir, 'store.json');
          {
            const tmp = `${taskStorePath}.${process.pid}.${Date.now()}.tmp`;
            writeFileSync(tmp, JSON.stringify(session.data.tasks, null, 2), 'utf-8');
            renameSync(tmp, taskStorePath);
          }
        }
        if (session.data?.agents) {
          const agentDir = join(getMonomindDataRoot(), 'agents');
          if (!existsSync(agentDir)) mkdirSync(agentDir, { recursive: true });
          const agentStorePath = join(agentDir, 'store.json');
          {
            const tmp = `${agentStorePath}.${process.pid}.${Date.now()}.tmp`;
            writeFileSync(tmp, JSON.stringify(session.data.agents, null, 2), 'utf-8');
            renameSync(tmp, agentStorePath);
          }
        }

        return {
          sessionId: session.sessionId,
          name: session.name,
          restored: true,
          restoredAt: new Date().toISOString(),
          stats: session.stats,
        };
      }

      return {
        sessionId: input.sessionId || input.name || 'latest',
        restored: false,
        error: 'Session not found',
      };
    },
  },
];
