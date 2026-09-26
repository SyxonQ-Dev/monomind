/**
 * Memory Bridge — entry reads and deletes (list, count, get, delete),
 * embedding generation, backend stats, and HNSW status/build. Split out of
 * memory-bridge.ts, which re-exports the public symbols.
 */

import { _embedder, flushBackend, getBackend } from './memory-bridge-backend.js';
import {
  BRIDGE_EMBEDDING_DIMS,
  BRIDGE_EMBEDDING_MODEL,
  logBridgeError,
} from './memory-bridge-core.js';

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
