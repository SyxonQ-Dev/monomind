/**
 * Memory Bridge — Routes CLI memory operations through SQLite
 *
 * Uses SQLiteBackend (better-sqlite3, sql.js WASM fallback) from @monoes/memory.
 * LanceDB was replaced by this SQLite engine 2026-07; the on-disk data
 * directory is still named `lancedb` for legacy/back-compat path resolution
 * (see getDbPath in memory-bridge-paths.ts) but no longer holds LanceDB data.
 * All exported function signatures are unchanged.
 *
 * @module v1/cli/memory-bridge
 */

import { flushBackend, getBackend } from './memory-bridge-backend.js';
import {
  capResultContent,
  entryWeights,
  generateId,
  logBridgeError,
} from './memory-bridge-core.js';
import { bridgeDeleteEntry } from './memory-bridge-entries.js';
import { bridgeSearchEntries } from './memory-bridge-search.js';
import { bridgeStoreEntry } from './memory-bridge-store.js';

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
export {
  bridgeAddToHNSW,
  bridgeCountEntries,
  bridgeDeleteEntry,
  bridgeForceBuildHNSW,
  bridgeGenerateEmbedding,
  bridgeGetBackendStats,
  bridgeGetEntry,
  bridgeGetHNSWStatus,
  bridgeListEntries,
  bridgeLoadEmbeddingModel,
} from './memory-bridge-entries.js';
export {
  bridgeApplyFeedback,
  bridgeRecordFeedback,
  bridgeRecordUsage,
} from './memory-bridge-feedback.js';
export type { ProjectRootResolution } from './memory-bridge-paths.js';
export {
  bridgeGetDbPath,
  GLOBAL_BRAIN,
  getGlobalBrainDir,
  getProjectRoot,
  getProjectRootResolution,
} from './memory-bridge-paths.js';
export { bridgeSearchEntries } from './memory-bridge-search.js';
export {
  bridgeLatestSession,
  bridgeSessionEnd,
  bridgeSessionStart,
} from './memory-bridge-sessions.js';
export { bridgeStoreEntry } from './memory-bridge-store.js';

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
