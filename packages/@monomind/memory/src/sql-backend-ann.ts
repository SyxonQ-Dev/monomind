/**
 * ANN (HNSW) index build/cache internals for SqlBackend.search()'s fast path.
 *
 * File-size sweep: split out of sql-backend.ts. These are mixed into
 * SqlBackend.prototype at the bottom of sql-backend.ts, which also owns the
 * fields these methods read and write (_annIndex, _annEntries,
 * _annDimensions, _annBuiltForCount, _annBuiltForMaxUpdatedAt, ANN_THRESHOLD,
 * getAnnCacheDir()). `SqlBackend.ANN_THRESHOLD` (a static access valid from
 * inside the class body) becomes `(this.constructor as typeof
 * SqlBackend).ANN_THRESHOLD` here, since these methods are no longer
 * lexically inside the class — behaviourally identical, as ANN_THRESHOLD is
 * never overridden by a subclass.
 *
 * @module v1/memory/sql-backend-ann
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomicSync } from './atomic-file.js';
import { HNSWIndex, type HNSWSerialized } from './hnsw-index.js';
import type { SqlBackend } from './sql-backend.js';
import type { MemoryEntry } from './types.js';

export const sqlBackendAnnMethods = {
  annCachePath(this: SqlBackend): string | null {
    const dir = this.getAnnCacheDir();
    return dir ? join(dir, 'hnsw-index.json') : null;
  },

  /**
   * Staleness fingerprint for the ANN cache: row count alone misses an
   * in-place embedding update (same id, re-embedded content — the count
   * doesn't change), which would otherwise leave the cached graph serving a
   * stale vector for that entry indefinitely. `updated_at` is bumped on
   * every store() call (including updates to an existing id), so pairing
   * count with MAX(updated_at) catches that case too.
   */
  countEmbeddedActiveEntries(this: SqlBackend): { count: number; maxUpdatedAt: number } {
    const row = this.driver?.get(
      `SELECT COUNT(*) as c, COALESCE(MAX(e.updated_at), 0) as m FROM memory_entries e
        JOIN memory_embeddings emb ON emb.entry_id = e.id
       WHERE (e.expires_at IS NULL OR e.expires_at = 0 OR e.expires_at > ?)`,
      [Date.now()],
    ) as { c: number; m: number } | undefined;
    return { count: row?.c ?? 0, maxUpdatedAt: row?.m ?? 0 };
  },

  /**
   * Returns a ready-to-search ANN index for the given embedding dimensions,
   * or null when the corpus is below ANN_THRESHOLD (brute force stays the
   * search path). Tries, in order: the process-lifetime cache, a valid
   * on-disk cache (skips the DB read + graph build entirely), then a full
   * rebuild from memory_embeddings (writing a fresh on-disk cache for next
   * time).
   */
  async getAnnIndex(
    this: SqlBackend,
    dimensions: number,
    force = false,
  ): Promise<{ index: HNSWIndex; entries: Map<string, MemoryEntry> } | null> {
    const { count, maxUpdatedAt } = this.countEmbeddedActiveEntries();
    if (!force && count < (this.constructor as typeof SqlBackend).ANN_THRESHOLD) return null;

    if (
      !force &&
      this._annIndex &&
      this._annDimensions === dimensions &&
      this._annBuiltForCount === count &&
      this._annBuiltForMaxUpdatedAt === maxUpdatedAt
    ) {
      return { index: this._annIndex, entries: this._annEntries };
    }

    const cachePath = this.annCachePath();
    if (!force && cachePath && existsSync(cachePath)) {
      try {
        const parsed = JSON.parse(readFileSync(cachePath, 'utf8')) as {
          entryCount: number;
          maxUpdatedAt: number;
          dimensions: number;
          index: HNSWSerialized;
          entries: Array<[string, MemoryEntry]>;
        };
        if (
          parsed.entryCount === count &&
          parsed.maxUpdatedAt === maxUpdatedAt &&
          parsed.dimensions === dimensions
        ) {
          const index = HNSWIndex.deserialize(parsed.index);
          const entries = new Map(parsed.entries);
          this._annIndex = index;
          this._annDimensions = dimensions;
          this._annBuiltForCount = count;
          this._annBuiltForMaxUpdatedAt = maxUpdatedAt;
          this._annEntries = entries;
          return { index, entries };
        }
      } catch {
        // Corrupt or incompatible cache — fall through to a full rebuild.
      }
    }

    const rows =
      this.driver?.iterate(
        `SELECT e.*, emb.embedding AS _emb
         FROM memory_entries e
         JOIN memory_embeddings emb ON emb.entry_id = e.id
        WHERE (e.expires_at IS NULL OR e.expires_at = 0 OR e.expires_at > ?)`,
        [Date.now()],
      ) ?? [];

    const index = new HNSWIndex({ dimensions, metric: 'cosine' });
    const entries = new Map<string, MemoryEntry>();
    const points: Array<{ id: string; vector: Float32Array }> = [];
    for (const row of rows) {
      const buf = row._emb as Buffer | Uint8Array | undefined;
      if (!buf || buf.byteLength % 4 !== 0) continue;
      const vec = new Float32Array(buf.buffer as ArrayBuffer, buf.byteOffset, buf.byteLength / 4);
      if (vec.length !== dimensions) continue;
      const entry = this.rowToEntry(row);
      points.push({ id: entry.id, vector: vec });
      entries.set(entry.id, entry);
    }
    await index.rebuild(points);

    this._annIndex = index;
    this._annDimensions = dimensions;
    this._annBuiltForCount = count;
    this._annBuiltForMaxUpdatedAt = maxUpdatedAt;
    this._annEntries = entries;

    if (cachePath) {
      try {
        writeFileAtomicSync(
          cachePath,
          JSON.stringify({
            entryCount: count,
            maxUpdatedAt,
            dimensions,
            index: index.serialize(),
            entries: Array.from(entries.entries()),
          }),
        );
      } catch {
        // Best-effort — a failed cache write just means the next cold start rebuilds.
      }
    }

    return { index, entries };
  },
};
