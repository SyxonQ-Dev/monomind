/**
 * Write-path methods for SqlBackend (store/update/delete family).
 *
 * File-size sweep: split out of sql-backend.ts. Mixed into
 * SqlBackend.prototype at the bottom of sql-backend.ts.
 *
 * @module v1/memory/sql-backend-writes
 */

import type { SqlBackend } from './sql-backend.js';
import type { SqlParam } from './sql-driver.js';
import type { MemoryEntry, MemoryEntryUpdate } from './types.js';

export const sqlBackendWriteMethods = {
  async store(this: SqlBackend, entry: MemoryEntry): Promise<void> {
    this.ensureInitialized();
    const startTime = performance.now();
    this.validateTags(entry.tags);

    this.driver?.transaction(() => this.storeSync(entry));

    const duration = performance.now() - startTime;
    this.stats.writeCount++;
    this.stats.totalWriteTime += duration;
    this.emit('entry:stored', { id: entry.id, duration });
  },

  /**
   * Compare-and-swap update: writes ONLY if the row's stored `version` still
   * equals `expectedVersion`. The check and the write are one SQL statement
   * (`UPDATE ... WHERE id = ? AND version = ?`), so SQLite's own single-
   * statement atomicity — the same guarantee `store()`'s INSERT OR REPLACE
   * already relies on — makes this a real compare-and-swap against every
   * other writer, in this process or another, with no bridge-level lock.
   *
   * Exists for memory-KG review finding K5: a getByKey() + store() read-
   * merge-write (what every caller did before this) leaves a window in which
   * two concurrent callers each merge onto the same row and the second
   * store() silently overwrites the first's contribution. A caller that reads
   * a row's version, merges onto it, and writes back through here instead
   * gets `false` when its merge has gone stale, rather than winning a race it
   * did not know it was running.
   *
   * Only the columns a claim-ledger merge (memory-kg.ts) actually changes are
   * updated; embeddings are left untouched, matching storeSync's own rule that
   * a revision without a new vector keeps the one it had.
   *
   * @returns true when the write landed, false when the row's version had
   * already moved (or the row no longer exists) — the caller must re-read and
   * re-merge, never assume the write happened.
   */
  async storeIfVersion(
    this: SqlBackend,
    entry: MemoryEntry,
    expectedVersion: number,
  ): Promise<boolean> {
    this.ensureInitialized();
    this.validateTags(entry.tags);
    const d = this.driver!;
    return d.transaction(() => {
      const changes = d.run(
        `UPDATE memory_entries
           SET content = ?, tags = ?, metadata = ?, updated_at = ?, version = ?, "references" = ?
         WHERE id = ? AND version = ?`,
        [
          entry.content,
          JSON.stringify(entry.tags),
          JSON.stringify(entry.metadata),
          entry.updatedAt,
          entry.version,
          JSON.stringify(entry.references),
          entry.id,
          expectedVersion,
        ] as SqlParam[],
      );
      if (changes === 0) return false;
      d.run('DELETE FROM memory_entry_tags WHERE entry_id = ?', [entry.id]);
      for (const tag of entry.tags) {
        d.run('INSERT OR IGNORE INTO memory_entry_tags (entry_id, tag) VALUES (?, ?)', [
          entry.id,
          tag,
        ]);
      }
      return true;
    });
  },

  /**
   * Compare-and-swap create: the create-side counterpart to `storeIfVersion`.
   * Inserts ONLY if no row already occupies this id or this namespace/key pair
   * (the schema's `UNIQUE(namespace, key)` index — see sql-schema.ts).
   *
   * Exists for the same K5 race on the CREATE side: two concurrent callers
   * asserting the same new KG entity mint the same deterministic `key` but a
   * different random row `id` (see memory-bridge.ts's upsert). Plain `store()`
   * (INSERT OR REPLACE) resolves that collision by silently deleting whichever
   * row landed first — exactly the lost update K5 describes, just on first
   * write instead of a merge. `INSERT OR IGNORE` instead leaves the first row
   * untouched and reports that it did, so the loser re-reads and merges onto
   * it instead of clobbering it.
   *
   * @returns true when this call created the row, false when one already
   * existed — the caller must re-read and merge rather than assume it won.
   */
  async storeIfAbsent(this: SqlBackend, entry: MemoryEntry): Promise<boolean> {
    this.ensureInitialized();
    this.validateTags(entry.tags);
    const d = this.driver!;
    return d.transaction(() => {
      const changes = d.run(
        `INSERT OR IGNORE INTO memory_entries (
           id, key, content, type, namespace, tags, metadata, owner_id, access_level,
           created_at, updated_at, expires_at, event_at, version, "references",
           access_count, last_accessed_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          entry.id,
          entry.key,
          entry.content,
          entry.type,
          entry.namespace,
          JSON.stringify(entry.tags),
          JSON.stringify(entry.metadata),
          entry.ownerId || null,
          entry.accessLevel,
          entry.createdAt,
          entry.updatedAt,
          entry.expiresAt || null,
          entry.eventAt ?? null,
          entry.version,
          JSON.stringify(entry.references),
          entry.accessCount,
          entry.lastAccessedAt,
        ] as SqlParam[],
      );
      if (changes === 0) return false;
      for (const tag of entry.tags) {
        d.run('INSERT OR IGNORE INTO memory_entry_tags (entry_id, tag) VALUES (?, ?)', [
          entry.id,
          tag,
        ]);
      }
      if (entry.embedding && entry.embedding.byteLength > 0) {
        const bytes = Buffer.from(
          entry.embedding.buffer as ArrayBuffer,
          entry.embedding.byteOffset,
          entry.embedding.byteLength,
        );
        d.run('INSERT OR REPLACE INTO memory_embeddings (entry_id, embedding) VALUES (?, ?)', [
          entry.id,
          bytes,
        ]);
      }
      return true;
    });
  },

  /** Synchronous store body, shared by store() and bulkInsert(). */
  storeSync(this: SqlBackend, entry: MemoryEntry): void {
    const d = this.driver!;

    // Read any existing embedding BEFORE INSERT OR REPLACE fires the CASCADE
    // that would delete it — an entry updated without a vector must keep the
    // one it already had.
    let embeddingToStore = entry.embedding;
    if (!embeddingToStore) {
      const existing = d.get('SELECT embedding FROM memory_embeddings WHERE entry_id = ?', [
        entry.id,
      ]);
      const buf = existing?.embedding as Buffer | Uint8Array | undefined;
      if (buf && buf.byteLength > 0) {
        embeddingToStore = new Float32Array(
          buf.buffer as ArrayBuffer,
          buf.byteOffset,
          buf.byteLength / 4,
        );
      }
    }

    d.run(
      `INSERT OR REPLACE INTO memory_entries (
         id, key, content, type, namespace, tags, metadata, owner_id, access_level,
         created_at, updated_at, expires_at, event_at, version, "references",
         access_count, last_accessed_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        entry.id,
        entry.key,
        entry.content,
        entry.type,
        entry.namespace,
        JSON.stringify(entry.tags),
        JSON.stringify(entry.metadata),
        entry.ownerId || null,
        entry.accessLevel,
        entry.createdAt,
        entry.updatedAt,
        entry.expiresAt || null,
        entry.eventAt ?? null,
        entry.version,
        JSON.stringify(entry.references),
        entry.accessCount,
        entry.lastAccessedAt,
      ] as SqlParam[],
    );

    d.run('DELETE FROM memory_entry_tags WHERE entry_id = ?', [entry.id]);
    for (const tag of entry.tags) {
      d.run('INSERT OR IGNORE INTO memory_entry_tags (entry_id, tag) VALUES (?, ?)', [
        entry.id,
        tag,
      ]);
    }

    if (embeddingToStore) {
      // Slice by byteOffset/byteLength: for copies under Node's 4KB pooling
      // threshold, `.buffer` refers to the entire shared pool, so writing it
      // whole silently stores unrelated memory.
      const bytes = Buffer.from(
        embeddingToStore.buffer as ArrayBuffer,
        embeddingToStore.byteOffset,
        embeddingToStore.byteLength,
      );
      d.run('INSERT OR REPLACE INTO memory_embeddings (entry_id, embedding) VALUES (?, ?)', [
        entry.id,
        bytes,
      ]);
    }
  },

  async bulkInsert(this: SqlBackend, entries: MemoryEntry[]): Promise<void> {
    this.ensureInitialized();
    for (const e of entries) this.validateTags(e.tags);
    this.driver?.transaction(() => {
      for (const entry of entries) this.storeSync(entry);
    });
    this.emit('bulk:inserted', { count: entries.length });
  },

  async update(
    this: SqlBackend,
    id: string,
    update: MemoryEntryUpdate,
  ): Promise<MemoryEntry | null> {
    this.ensureInitialized();
    const entry = await this.get(id);
    if (!entry) return null;

    if (update.content !== undefined) entry.content = update.content;
    if (update.tags !== undefined) entry.tags = update.tags;
    if (update.metadata !== undefined) entry.metadata = { ...entry.metadata, ...update.metadata };
    if (update.accessLevel !== undefined) entry.accessLevel = update.accessLevel;
    if (update.expiresAt !== undefined) entry.expiresAt = update.expiresAt;
    if (update.references !== undefined) entry.references = update.references;

    entry.updatedAt = Date.now();
    entry.version++;

    await this.store(entry);
    this.emit('entry:updated', { id });
    return entry;
  },

  async delete(this: SqlBackend, id: string): Promise<boolean> {
    this.ensureInitialized();
    const d = this.driver!;
    // Explicit tag cleanup as well as the CASCADE — belt and braces, since FK
    // enforcement is a pragma that not every driver honours.
    d.run('DELETE FROM memory_entry_tags WHERE entry_id = ?', [id]);
    d.run('DELETE FROM memory_embeddings WHERE entry_id = ?', [id]);
    const changes = d.run('DELETE FROM memory_entries WHERE id = ?', [id]);
    if (changes > 0) {
      this.emit('entry:deleted', { id });
      return true;
    }
    return false;
  },

  async bulkDelete(this: SqlBackend, ids: string[]): Promise<number> {
    this.ensureInitialized();
    const d = this.driver!;
    const count = d.transaction(() => {
      let deleted = 0;
      for (const id of ids) {
        d.run('DELETE FROM memory_entry_tags WHERE entry_id = ?', [id]);
        d.run('DELETE FROM memory_embeddings WHERE entry_id = ?', [id]);
        if (d.run('DELETE FROM memory_entries WHERE id = ?', [id]) > 0) deleted++;
      }
      return deleted;
    });
    this.emit('bulk:deleted', { count });
    return count;
  },

  async clearNamespace(this: SqlBackend, namespace: string): Promise<number> {
    this.ensureInitialized();
    const d = this.driver!;
    const count = d.transaction(() => {
      d.run(
        `DELETE FROM memory_entry_tags
          WHERE entry_id IN (SELECT id FROM memory_entries WHERE namespace = ?)`,
        [namespace],
      );
      const changes = d.run('DELETE FROM memory_entries WHERE namespace = ?', [namespace]);
      d.run('DELETE FROM memory_embeddings WHERE entry_id NOT IN (SELECT id FROM memory_entries)');
      return changes;
    });
    this.emit('namespace:cleared', { namespace, count });
    return count;
  },
};
