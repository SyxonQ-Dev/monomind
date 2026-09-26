/**
 * Memory Bridge — session lifecycle rows (start, end, latest) in the
 * `sessions` namespace. Split out of memory-bridge.ts, which re-exports the
 * public symbols.
 */

import { flushBackend, getBackend } from './memory-bridge-backend.js';
import { logBridgeError } from './memory-bridge-core.js';
import { bridgeStoreEntry } from './memory-bridge-store.js';

// ===== Session lifecycle =====

export async function bridgeSessionStart(options: {
  sessionId: string;
  agentId?: string;
  metadata?: Record<string, unknown>;
  dbPath?: string;
}): Promise<{ success: boolean; id: string; error?: string } | null> {
  return bridgeStoreEntry({
    key: `session_${options.sessionId}`,
    value: JSON.stringify({
      sessionId: options.sessionId,
      agentId: options.agentId,
      startedAt: Date.now(),
      status: 'active',
      metadata: options.metadata ?? {},
    }),
    namespace: 'sessions',
    tags: ['session', 'active'],
    generateEmbeddingFlag: false,
    dbPath: options.dbPath,
    upsert: true,
  });
}

export async function bridgeSessionEnd(options: {
  sessionId: string;
  summary?: string;
  metrics?: Record<string, unknown>;
  dbPath?: string;
}): Promise<{ success: boolean; error?: string } | null> {
  const backend = await getBackend(options.dbPath);
  if (!backend) return null;

  try {
    const existing = await backend.getByKey('sessions', `session_${options.sessionId}`);
    // Nothing is written for a session that was never started — do not report
    // that as a recorded session end.
    if (!existing) return { success: false, error: `no session ${options.sessionId} to end` };
    let data: any = {};
    try {
      data = JSON.parse(existing.content);
    } catch (e) {
      if (process.env.DEBUG || process.env.MONOMIND_DEBUG)
        console.error(
          '[memory-bridge] session content failed to parse — ending session with empty prior state:',
          e,
        );
    }
    const updated = await backend.update(existing.id, {
      content: JSON.stringify({
        ...data,
        status: 'ended',
        endedAt: Date.now(),
        summary: options.summary,
        metrics: options.metrics ?? {},
      }),
      tags: ['session', 'ended'],
    });
    if (!updated) return { success: false, error: `session ${options.sessionId} vanished` };
    await flushBackend(backend);
    return { success: true };
  } catch (e) {
    logBridgeError('bridgeSessionEnd', e);
    return { success: false };
  }
}

/** The most recently started session recorded by bridgeSessionStart, read
 *  back from its row — or null when there is none (or no backend). */
export async function bridgeLatestSession(options: {
  excludeSessionId?: string;
  dbPath?: string;
}): Promise<{
  sessionId: string;
  status: string;
  startedAt: string;
  endedAt?: string;
  summary?: string;
  metrics?: Record<string, unknown>;
} | null> {
  const backend = await getBackend(options.dbPath);
  if (!backend) return null;

  try {
    // Newest two rows: one of them may be the excluded (current) session.
    const rows = await backend.query({
      type: 'exact' as any,
      namespace: 'sessions',
      keyPrefix: 'session_',
      sortField: 'createdAt',
      sortDirection: 'desc',
      limit: 2,
    });
    for (const row of rows) {
      let data: any;
      try {
        data = JSON.parse(row.content);
      } catch {
        continue;
      }
      if (typeof data?.sessionId !== 'string' || data.sessionId === options.excludeSessionId)
        continue;
      return {
        sessionId: data.sessionId,
        status: typeof data.status === 'string' ? data.status : 'unknown',
        startedAt: new Date(data.startedAt ?? row.createdAt).toISOString(),
        ...(typeof data.endedAt === 'number'
          ? { endedAt: new Date(data.endedAt).toISOString() }
          : {}),
        ...(typeof data.summary === 'string' ? { summary: data.summary } : {}),
        ...(data.metrics && typeof data.metrics === 'object' ? { metrics: data.metrics } : {}),
      };
    }
    return null;
  } catch (e) {
    logBridgeError('bridgeLatestSession', e);
    return null;
  }
}
