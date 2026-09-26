/**
 * Memory Bridge — Routes CLI memory operations through SQLite
 *
 * Uses SQLiteBackend (better-sqlite3, sql.js WASM fallback) from @monoes/memory.
 * LanceDB was replaced by this SQLite engine 2026-07; the on-disk data
 * directory is still named `lancedb` for legacy/back-compat path resolution
 * (see getDbPath below) but no longer holds LanceDB data.
 * All exported function signatures are unchanged.
 *
 * @module v1/cli/memory-bridge
 */

import { _embedder, flushBackend, getBackend } from './memory-bridge-backend.js';
import {
  BRIDGE_EMBEDDING_DIMS,
  BRIDGE_EMBEDDING_MODEL,
  capResultContent,
  entryWeights,
  FEEDBACK_EWMA_ALPHA,
  generateId,
  logBridgeError,
} from './memory-bridge-core.js';
import { bridgeSearchEntries } from './memory-bridge-search.js';
import type { SkippedEntry } from './memory-bridge-store.js';
import { bridgeStoreEntry, recordUsageOnBackend } from './memory-bridge-store.js';

export {
  BRIDGE_RERANKER_MODEL,
  disableLocalModels,
  downloadEmbeddingModel,
  isBridgeAvailable,
  loadReranker,
  localEmbeddingsDisabled,
  rerankerDisabled,
  rerankerKind,
  rerankerModelsDir,
  shutdownBridge,
} from './memory-bridge-backend.js';
export {
  BRIDGE_EMBEDDING_DIMS,
  BRIDGE_EMBEDDING_MODEL,
  safeParseEmbedding,
} from './memory-bridge-core.js';
export type { ProjectRootResolution } from './memory-bridge-paths.js';
export {
  bridgeGetDbPath,
  GLOBAL_BRAIN,
  getGlobalBrainDir,
  getProjectRoot,
  getProjectRootResolution,
} from './memory-bridge-paths.js';
export { bridgeSearchEntries } from './memory-bridge-search.js';
export { bridgeStoreEntry } from './memory-bridge-store.js';

export async function bridgeListEntries(options: {
  namespace?: string;
  limit?: number;
  offset?: number;
  dbPath?: string;
}): Promise<{
  success: boolean;
  entries: {
    id: string;
    key: string;
    namespace: string;
    content: string;
    accessCount: number;
    createdAt: string;
    updatedAt: string;
    hasEmbedding: boolean;
    tags: string[];
    metadata: Record<string, unknown>;
  }[];
  total: number;
  error?: string;
} | null> {
  const backend = await getBackend(options.dbPath);
  if (!backend) return null;

  try {
    const entries = await backend.query({
      type: 'exact' as any,
      // No namespace means "all namespaces" — the query builder (sql-backend.ts)
      // already skips its filter clause on a falsy namespace. Defaulting to the
      // literal string 'default' here (as this used to) overrode that legitimate
      // "no filter" signal and silently scoped every unfiltered list/search to a
      // namespace that's usually near-empty in practice.
      namespace: options.namespace,
      limit: options.limit ?? 100,
      offset: options.offset,
    });

    return {
      success: true,
      entries: entries.map((e: any) => ({
        id: e.id,
        key: e.key,
        namespace: e.namespace,
        content: e.content,
        accessCount: e.accessCount ?? 0,
        createdAt: new Date(e.createdAt).toISOString(),
        updatedAt: new Date(e.updatedAt).toISOString(),
        hasEmbedding: !!(e.embedding && (e.embedding as any).length > 0),
        tags: e.tags ?? [],
        metadata: e.metadata ?? {},
      })),
      total: entries.length,
    };
  } catch (e) {
    logBridgeError('bridgeListEntries', e);
    return null;
  }
}

/** A real database count for one namespace — `SELECT COUNT(*) WHERE
 *  namespace = ?` against the existing `idx_namespace` index — as opposed to
 *  `bridgeListEntries.total`, which is only the returned page's length (K7:
 *  "bridgeListEntries.total is the returned page length, not a database
 *  count"). Every row in a KG namespace (`kg:nodes`, `kg:edges`, `rules`) is
 *  exactly one node/edge/rule — the name/adjacency index namespaces are
 *  separate — so this count needs no per-row filtering to be exact, and costs
 *  one indexed query instead of paging the whole namespace.
 *
 *  @returns null when the backend is unavailable, or when the loaded backend
 *  predates `count()` — callers fall back to the paginated scan they already
 *  had rather than fail. */
export async function bridgeCountEntries(
  namespace: string,
  dbPath?: string,
): Promise<number | null> {
  const backend = await getBackend(dbPath);
  if (!backend || typeof backend.count !== 'function') return null;
  try {
    return await backend.count(namespace);
  } catch (e) {
    logBridgeError('bridgeCountEntries', e);
    return null;
  }
}

export async function bridgeGetEntry(options: {
  key: string;
  namespace?: string;
  dbPath?: string;
  agentId?: string;
}): Promise<{
  success: boolean;
  found: boolean;
  entry?: {
    id: string;
    key: string;
    namespace: string;
    content: string;
    accessCount: number;
    createdAt: string;
    updatedAt: string;
    hasEmbedding: boolean;
    tags: string[];
    metadata: Record<string, unknown>;
    /** The row's own revision counter (bumped on every store()/upsert),
     *  distinct from any KG-level metadata.version. A caller doing a
     *  read-merge-write passes this straight back as `bridgeStoreEntry`'s
     *  `ifVersion` to detect a concurrent writer instead of silently
     *  overwriting it (K5). Absent only when the underlying entry predates
     *  version tracking. */
    version?: number;
  };
  cacheHit?: boolean;
  error?: string;
} | null> {
  const backend = await getBackend(options.dbPath);
  if (!backend) return null;

  try {
    const { key, namespace = 'default' } = options;
    const entry = await backend.getByKey(namespace, key);

    if (!entry) return { success: true, found: false };

    return {
      success: true,
      found: true,
      entry: {
        id: entry.id,
        key: entry.key,
        namespace: entry.namespace,
        content: entry.content,
        accessCount: entry.accessCount ?? 0,
        createdAt: new Date(entry.createdAt).toISOString(),
        updatedAt: new Date(entry.updatedAt).toISOString(),
        hasEmbedding: !!(entry.embedding && (entry.embedding as any).length > 0),
        tags: entry.tags ?? [],
        metadata: entry.metadata ?? {},
        ...(typeof entry.version === 'number' ? { version: entry.version } : {}),
      },
    };
  } catch (e) {
    logBridgeError('bridgeGetEntry', e);
    return null;
  }
}

export async function bridgeDeleteEntry(options: {
  key?: string;
  id?: string;
  namespace?: string;
  dbPath?: string;
}): Promise<{
  success: boolean;
  deleted: boolean;
  error?: string;
} | null> {
  const backend = await getBackend(options.dbPath);
  if (!backend) return null;

  try {
    const namespace = options.namespace ?? 'default';
    let deleted = false;

    if (options.id) {
      deleted = await backend.delete(options.id);
    } else if (options.key) {
      const entry = await backend.getByKey(namespace, options.key);
      if (entry) deleted = await backend.delete(entry.id);
    }
    if (deleted) await flushBackend(backend);

    return { success: true, deleted };
  } catch (e) {
    logBridgeError('bridgeDeleteEntry', e);
    return { success: false, deleted: false };
  }
}

// ===== Embeddings =====

export async function bridgeGenerateEmbedding(
  text: string,
  dbPath?: string,
): Promise<{ embedding: number[]; dimensions: number; model: string } | null> {
  await getBackend(dbPath); // ensure embedder is initialized
  if (!_embedder) return null;

  try {
    const emb = await _embedder(text);
    return { embedding: Array.from(emb), dimensions: emb.length, model: BRIDGE_EMBEDDING_MODEL };
  } catch (e) {
    logBridgeError('bridgeEmbedText', e);
    return null;
  }
}

export async function bridgeLoadEmbeddingModel(dbPath?: string): Promise<{
  success: boolean;
  dimensions: number;
  modelName: string;
  loadTime?: number;
} | null> {
  const startTime = Date.now();
  await getBackend(dbPath);

  if (!_embedder) return null;

  try {
    const test = await _embedder('test');
    if (!test) return null;
    return {
      success: true,
      dimensions: test.length,
      modelName: BRIDGE_EMBEDDING_MODEL,
      loadTime: Date.now() - startTime,
    };
  } catch (e) {
    logBridgeError('bridgeLoadEmbeddingModel', e);
    return null;
  }
}

export async function bridgeGetBackendStats(dbPath?: string): Promise<{
  totalEntries: number;
  entriesByNamespace: Record<string, number>;
  memoryUsage: number;
} | null> {
  const backend = await getBackend(dbPath);
  if (!backend) return null;
  try {
    const stats = await backend.getStats();
    return {
      totalEntries: stats?.totalEntries ?? 0,
      entriesByNamespace: stats?.entriesByNamespace ?? {},
      memoryUsage: stats?.memoryUsage ?? 0,
    };
  } catch (e) {
    logBridgeError('bridgeGetBackendStats', e);
    return null;
  }
}

// ===== HNSW (real ANN status/build; search itself runs inside SqlBackend.search()) =====

export async function bridgeAddToHNSW(options: {
  id: string;
  embedding: number[];
  namespace?: string;
  dbPath?: string;
}): Promise<{ success: boolean; indexSize?: number; error?: string } | null> {
  // The SQLite backend indexes entries automatically on store — this is a no-op
  const backend = await getBackend(options.dbPath);
  if (!backend) return null;
  try {
    const stats = await backend.getStats();
    return { success: true, indexSize: stats?.totalEntries ?? 0 };
  } catch (e) {
    logBridgeError('bridgeAddToHNSW', e);
    return { success: true };
  }
}

/**
 * Real status for the ANN (HNSW) fast path inside SqlBackend.search() —
 * whether the corpus is big enough to use it, whether it's currently built,
 * and where its on-disk cache lives. Read-only; does not build anything.
 */
export async function bridgeGetHNSWStatus(dbPath?: string): Promise<{
  available: boolean;
  thresholdEntries: number;
  activeEmbeddedEntries: number;
  built: boolean;
  entryCount: number;
  dimensions: number;
  cachePath: string | null;
} | null> {
  const backend = await getBackend(dbPath);
  if (!backend || typeof backend.getAnnStatus !== 'function') return null;
  try {
    return { available: true, ...backend.getAnnStatus() };
  } catch (e) {
    logBridgeError('bridgeGetHNSWStatus', e);
    return null;
  }
}

/**
 * Force-build (or reload from disk cache) the ANN index regardless of
 * MONOMIND_HNSW_THRESHOLD — the real implementation behind
 * `memory search --build-hnsw`.
 */
export async function bridgeForceBuildHNSW(dbPath?: string): Promise<{
  entryCount: number;
  dimensions: number;
  cachePath: string | null;
} | null> {
  const backend = await getBackend(dbPath);
  if (!backend || typeof backend.forceBuildAnnIndex !== 'function') return null;
  try {
    return await backend.forceBuildAnnIndex(BRIDGE_EMBEDDING_DIMS);
  } catch (e) {
    logBridgeError('bridgeForceBuildHNSW', e);
    return null;
  }
}

// ===== Pattern store =====

export async function bridgeStorePattern(options: {
  pattern: string;
  taskType?: string;
  outcome?: string;
  confidence?: number;
  dbPath?: string;
}): Promise<{ success: boolean; id: string; error?: string } | null> {
  return bridgeStoreEntry({
    key: `pattern_${options.taskType ?? 'general'}_${generateId('p')}`,
    value: JSON.stringify({
      pattern: options.pattern,
      taskType: options.taskType,
      outcome: options.outcome,
      confidence: options.confidence ?? 0.5,
    }),
    namespace: 'patterns',
    tags: options.taskType ? [options.taskType] : [],
    generateEmbeddingFlag: true,
    dbPath: options.dbPath,
  });
}

export async function bridgeSearchPatterns(options: {
  query: string;
  taskType?: string;
  limit?: number;
  dbPath?: string;
}): Promise<{
  success: boolean;
  patterns: { id: string; pattern: string; confidence: number; taskType?: string; score: number }[];
  error?: string;
} | null> {
  const result = await bridgeSearchEntries({
    query: options.query,
    namespace: 'patterns',
    limit: options.limit ?? 5,
    dbPath: options.dbPath,
  });
  if (!result) return null;

  return {
    success: result.success,
    patterns: result.results.map((r) => {
      let parsed: any = {};
      try {
        parsed = JSON.parse(r.content);
      } catch (e) {
        logBridgeError('bridgeSearchPatterns.parseContent', e); /* use raw */
      }
      return {
        id: r.id,
        pattern: parsed.pattern ?? r.content,
        confidence: parsed.confidence ?? r.score,
        taskType: parsed.taskType,
        score: r.score,
      };
    }),
  };
}

// ===== Usage capture & feedback weighting (closed loop) =====

/** Record that these entries were actually USED (returned to and consumed by a
 *  caller) — increments frequency_weight, which feeds the ranking blend.
 *
 *  Unresolvable ids are REPORTED, not dropped: this used to `continue` past
 *  every id it could not read, so a caller handing it a page of stale ids got
 *  `{success: true, updated: 0}` with nothing to say whether those entries had
 *  been deleted or the writes had failed. Same contract as
 *  `bridgeApplyFeedback`. */
export async function bridgeRecordUsage(options: {
  entryIds: string[];
  dbPath?: string;
}): Promise<{ success: boolean; updated: number; skipped?: SkippedEntry[] } | null> {
  const backend = await getBackend(options.dbPath);
  if (!backend) return null;
  try {
    const { updated, skipped } = await recordUsageOnBackend(
      backend,
      (options.entryIds ?? []).slice(0, 100),
    );
    if (updated) await flushBackend(backend);
    return skipped.length ? { success: true, updated, skipped } : { success: true, updated };
  } catch (e) {
    logBridgeError('bridgeRecordUsage', e);
    return { success: false, updated: 0 };
  }
}

/** Apply a usefulness rating to the entries that produced an answer:
 *  EWMA feedback_weight' = w + alpha*(score - w), clipped [0,1] (cognee's
 *  apply_feedback_weights). `ledgerKey` makes application idempotent — a
 *  daemon retry or duplicate MCP call must never compound the update. */
export async function bridgeApplyFeedback(options: {
  entryIds: string[];
  score: number; // 0..1 usefulness
  ledgerKey?: string;
  alpha?: number;
  dbPath?: string;
}): Promise<{
  success: boolean;
  applied: number;
  /** Ids that trained nothing, with why — so `applied: 0` is never a silent
   *  success. `not_found` means the id resolved to no entry (it was deleted, or
   *  it predates the in-place upsert fix and was orphaned by a re-ingest);
   *  `error` means the entry existed but could not be updated. */
  skipped?: { id: string; reason: 'not_found' | 'error' }[];
  alreadyApplied?: boolean;
  error?: string;
} | null> {
  const backend = await getBackend(options.dbPath);
  if (!backend) return null;

  try {
    const score = Math.max(0, Math.min(1, options.score));
    const alpha =
      typeof options.alpha === 'number'
        ? Math.max(0, Math.min(1, options.alpha))
        : FEEDBACK_EWMA_ALPHA;
    const ledgerEntryKey = options.ledgerKey ? `applied_${options.ledgerKey.slice(0, 500)}` : null;

    if (ledgerEntryKey) {
      const existing = await backend.getByKey('feedback', ledgerEntryKey).catch(() => null);
      if (existing) return { success: true, applied: 0, alreadyApplied: true };
    }

    let applied = 0;
    const skipped: { id: string; reason: 'not_found' | 'error' }[] = [];
    for (const id of (options.entryIds ?? []).slice(0, 100)) {
      if (typeof id !== 'string' || !id) continue;
      try {
        const entry = await backend.get(id);
        if (!entry) {
          skipped.push({ id, reason: 'not_found' });
          continue;
        }
        const { feedback } = entryWeights(entry.metadata);
        const next = Math.max(0, Math.min(1, feedback + alpha * (score - feedback)));
        await backend.update(id, { metadata: { feedback_weight: next } });
        applied++;
      } catch (e) {
        logBridgeError('bridgeApplyFeedback.entryUpdate', e);
        skipped.push({ id, reason: 'error' });
      }
    }

    if (ledgerEntryKey) {
      await bridgeStoreEntry({
        key: ledgerEntryKey,
        value: JSON.stringify({
          score,
          entryIds: options.entryIds.slice(0, 100),
          appliedAt: Date.now(),
          applied,
          skipped,
        }),
        namespace: 'feedback',
        generateEmbeddingFlag: false,
        dbPath: options.dbPath,
        upsert: true,
      });
    }
    if (applied) await flushBackend(backend);
    return skipped.length ? { success: true, applied, skipped } : { success: true, applied };
  } catch (err: unknown) {
    logBridgeError('bridgeApplyFeedback', err);
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, applied: 0, error: message };
  }
}

// ===== Feedback =====

export async function bridgeRecordFeedback(options: {
  taskType: string;
  action: string;
  outcome: 'success' | 'failure' | 'partial';
  confidence?: number;
  metadata?: Record<string, unknown>;
  dbPath?: string;
}): Promise<{ success: boolean; id: string; error?: string } | null> {
  return bridgeStoreEntry({
    key: `feedback_${options.taskType}_${Date.now()}`,
    value: JSON.stringify({
      taskType: options.taskType,
      action: options.action,
      outcome: options.outcome,
      confidence: options.confidence ?? 0.5,
      metadata: options.metadata ?? {},
      recordedAt: Date.now(),
    }),
    namespace: 'feedback',
    tags: [options.taskType, options.outcome],
    generateEmbeddingFlag: true,
    dbPath: options.dbPath,
  });
}

// ===== Causal edges =====

export async function bridgeRecordCausalEdge(options: {
  sourceId: string;
  targetId: string;
  relation: string;
  strength?: number;
  dbPath?: string;
}): Promise<{ success: boolean; id: string; error?: string } | null> {
  return bridgeStoreEntry({
    key: `causal_${options.sourceId}_${options.targetId}`,
    value: JSON.stringify({
      sourceId: options.sourceId,
      targetId: options.targetId,
      relation: options.relation,
      strength: options.strength ?? 1.0,
    }),
    namespace: 'causal',
    tags: ['causal', options.relation],
    generateEmbeddingFlag: false,
    dbPath: options.dbPath,
    upsert: true,
  });
}

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

// ===== Task routing =====

export async function bridgeRouteTask(options: {
  task: string;
  topK?: number;
  dbPath?: string;
}): Promise<{
  success: boolean;
  routes: { agentType: string; confidence: number; pattern?: string }[];
  error?: string;
} | null> {
  const result = await bridgeSearchEntries({
    query: options.task,
    namespace: 'patterns',
    limit: options.topK ?? 3,
    dbPath: options.dbPath,
  });
  if (!result) return null;

  return {
    success: result.success,
    routes: result.results.map((r) => {
      let parsed: any = {};
      try {
        parsed = JSON.parse(r.content);
      } catch (e) {
        logBridgeError('bridgeRouteTask.parseContent', e); /* use raw */
      }
      return {
        agentType: parsed.taskType ?? 'coder',
        confidence: r.score,
        pattern: parsed.pattern,
      };
    }),
  };
}

// ===== Health check =====

export async function bridgeHealthCheck(dbPath?: string): Promise<{
  healthy: boolean;
  backend: string;
  stats?: { totalEntries: number; namespaces: string[] };
  error?: string;
} | null> {
  const backend = await getBackend(dbPath);
  if (!backend) return { healthy: false, backend: 'sqlite', error: 'unavailable' };

  try {
    const health = await backend.healthCheck?.();
    const stats = await backend.getStats?.();
    return {
      healthy: health?.healthy ?? true,
      backend: 'sqlite',
      stats: stats
        ? {
            totalEntries: stats.totalEntries ?? 0,
            namespaces: Object.keys(stats.entriesByNamespace ?? {}),
          }
        : undefined,
    };
  } catch (e) {
    logBridgeError('bridgeHealthCheck', e);
    return { healthy: false, backend: 'sqlite' };
  }
}

// ===== Hierarchical memory =====

export async function bridgeHierarchicalStore(params: {
  key: string;
  value: string;
  tier?: string;
  importance?: number;
}): Promise<any> {
  return bridgeStoreEntry({
    key: params.key,
    value: params.value,
    namespace: `tier_${params.tier ?? 'working'}`,
    tags: [params.tier ?? 'working'],
    generateEmbeddingFlag: true,
  });
}

export async function bridgeHierarchicalRecall(params: {
  query: string;
  tier?: string;
  topK?: number;
}): Promise<any> {
  return bridgeSearchEntries({
    query: params.query,
    namespace: params.tier ? `tier_${params.tier}` : undefined,
    limit: params.topK ?? 5,
  });
}

// ===== Consolidation =====

/** Namespaces GC must never touch: durable knowledge/org/rule state, and the
 *  feedback ledger (deleting it would un-idempotent past ratings). */
const GC_PROTECTED_NS = /^(knowledge:|org:|agent:|kg:|rules$|feedback$)/;

export async function bridgeConsolidate(params: {
  /** Minimum age in MILLISECONDS since last update (default 7 days). */
  minAge?: number;
  maxEntries?: number;
  /** Namespace to GC; 'all' scans every non-protected namespace (default 'default'). */
  namespace?: string;
  dbPath?: string;
}): Promise<any> {
  const backend = await getBackend(params.dbPath);
  if (!backend) return { success: false, consolidated: 0 };

  try {
    const minAge = params.minAge ?? 7 * 24 * 3600 * 1000; // default: 7 days
    const cutoff = Date.now() - minAge;
    const ns = params.namespace ?? 'default';
    const entries = await backend.query({
      type: 'exact' as any,
      ...(ns === 'all' ? {} : { namespace: ns }),
      limit: params.maxEntries ?? 1000,
    });
    let deleted = 0;
    let kept = 0;
    for (const e of entries) {
      if (GC_PROTECTED_NS.test(String(e.namespace ?? ''))) continue;
      if (e.updatedAt >= cutoff) continue;
      const { feedback, frequency } = entryWeights(e.metadata);
      // Weight-aware GC (first real consumer of the closed loop): entries the
      // system learned are useful never age out; unused, unrated ones do.
      if (feedback > 0.6 || frequency >= 3) {
        kept++;
        continue;
      }
      if ((e.accessCount ?? 0) === 0) {
        await backend.delete(e.id).catch(() => {
          /* non-fatal */
        });
        deleted++;
      }
    }
    if (deleted) await flushBackend(backend);
    return { success: true, consolidated: deleted, preserved: kept };
  } catch (e) {
    logBridgeError('bridgeConsolidate', e);
    return { success: false, consolidated: 0 };
  }
}

// ===== Batch operations =====

export async function bridgeBatchOperation(params: {
  operation: string;
  entries: any[];
}): Promise<any> {
  const backend = await getBackend();
  if (!backend) return { success: false, processed: 0 };

  try {
    let processed = 0;
    if (params.operation === 'store') {
      for (const e of params.entries) {
        const result = await bridgeStoreEntry({
          key: e.key,
          value: e.value,
          namespace: e.namespace,
        });
        if (result?.success) processed++;
      }
    } else if (params.operation === 'delete') {
      for (const e of params.entries) {
        const result = await bridgeDeleteEntry({ key: e.key, namespace: e.namespace });
        if (result?.deleted) processed++;
      }
    }
    return { success: true, processed };
  } catch (e) {
    logBridgeError('bridgeBatchOperation', e);
    return { success: false, processed: 0 };
  }
}

// ===== Context synthesis =====

export async function bridgeContextSynthesize(params: {
  query: string;
  maxEntries?: number;
}): Promise<any> {
  const result = await bridgeSearchEntries({
    query: params.query,
    limit: params.maxEntries ?? 5,
  });
  if (!result?.success) return null;

  // Per-entry head cap plus a total budget — this block is injected verbatim
  // into prompts, so unbounded entries here were a token sink.
  const CONTEXT_TOTAL_CAP = 2560; // ~2.5 KB
  let total = 0;
  const lines: string[] = [];
  for (const r of result.results) {
    const line = `[${r.key}]: ${capResultContent(r.content)}`;
    if (total + line.length > CONTEXT_TOTAL_CAP) break;
    lines.push(line);
    total += line.length + 1;
  }
  const context = lines.join('\n');
  return { success: true, context, sources: result.results.length };
}

// ===== Semantic routing =====

export async function bridgeSemanticRoute(params: { input: string }): Promise<any> {
  return bridgeRouteTask({ task: params.input });
}
