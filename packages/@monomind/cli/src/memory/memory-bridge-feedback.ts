/**
 * Memory Bridge — the usage/feedback closed loop: usage capture
 * (frequency_weight), EWMA feedback weighting with an idempotency ledger,
 * and feedback records. Split out of memory-bridge.ts, which re-exports the
 * public symbols.
 */

import { flushBackend, getBackend } from './memory-bridge-backend.js';
import { entryWeights, FEEDBACK_EWMA_ALPHA, logBridgeError } from './memory-bridge-core.js';
import type { SkippedEntry } from './memory-bridge-store.js';
import { bridgeStoreEntry, recordUsageOnBackend } from './memory-bridge-store.js';

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
