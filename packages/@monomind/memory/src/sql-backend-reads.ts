/**
 * Read-path methods for SqlBackend (get/query/search family).
 *
 * File-size sweep: split out of sql-backend.ts. Mixed into
 * SqlBackend.prototype at the bottom of sql-backend.ts.
 *
 * @module v1/memory/sql-backend-reads
 */

import { cosineSimilarity } from './math-utils.js';
import type { SqlBackend } from './sql-backend.js';
import type { SqlParam } from './sql-driver.js';
import type { MemoryEntry, MemoryQuery, SearchOptions, SearchResult } from './types.js';

/** Cap on votes/rows pulled in one go, guarding against unbounded memory use. */
const MAX_QUERY_LIMIT = 10_000;

export const sqlBackendReadMethods = {
  async get(this: SqlBackend, id: string, agentId?: string): Promise<MemoryEntry | null> {
    this.ensureInitialized();
    const startTime = performance.now();
    const row = this.driver?.get(
      'SELECT memory_entries.*, emb.embedding AS _emb FROM memory_entries LEFT JOIN memory_embeddings emb ON emb.entry_id = memory_entries.id WHERE memory_entries.id = ?',
      [id],
    );
    if (!row) return null;

    // Collaborative memory promotion — https://arxiv.org/abs/2505.18279
    const AGENT_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
    if (agentId && AGENT_ID_RE.test(agentId)) {
      try {
        this.driver?.run(
          'INSERT OR IGNORE INTO agent_reads (entry_id, agent_id, read_at) VALUES (?, ?, ?)',
          [id, agentId, Date.now()],
        );
        this._readCount++;
        if (this._readCount % 1000 === 0) this.checkAndPromoteEntry(id);
      } catch {
        /* non-critical */
      }
    }

    const entry = this.rowToEntry(row);
    this.emit('entry:retrieved', { id, duration: performance.now() - startTime });
    return entry;
  },

  /**
   * Promote an entry to 'team' once 3+ distinct agents have read it within 24h.
   * https://arxiv.org/abs/2505.18279
   */
  checkAndPromoteEntry(this: SqlBackend, entryId: string): void {
    const d = this.driver;
    if (!d) return;
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    d.run('DELETE FROM agent_reads WHERE read_at <= ?', [cutoff]);
    const row = d.get(
      'SELECT COUNT(DISTINCT agent_id) as cnt FROM agent_reads WHERE entry_id = ? AND read_at > ?',
      [entryId, cutoff],
    );
    if (Number(row?.cnt ?? 0) >= 3) {
      d.run(
        "UPDATE memory_entries SET access_level = 'team' WHERE id = ? AND access_level = 'private'",
        [entryId],
      );
    }
  },

  async getByKey(this: SqlBackend, namespace: string, key: string): Promise<MemoryEntry | null> {
    this.ensureInitialized();
    const startTime = performance.now();
    const row = this.driver?.get(
      'SELECT memory_entries.*, emb.embedding AS _emb FROM memory_entries LEFT JOIN memory_embeddings emb ON emb.entry_id = memory_entries.id WHERE memory_entries.namespace = ? AND memory_entries.key = ?',
      [namespace, key],
    );
    if (!row) return null;
    const entry = this.rowToEntry(row);
    this.emit('entry:retrieved', { namespace, key, duration: performance.now() - startTime });
    return entry;
  },

  async query(this: SqlBackend, query: MemoryQuery): Promise<MemoryEntry[]> {
    this.ensureInitialized();
    const startTime = performance.now();

    // PKG-3: LEFT JOIN memory_embeddings once so rowToEntry can read the
    // embedding column without an N+1 round-trip per result row.
    let sql =
      'SELECT memory_entries.*, emb.embedding AS _emb FROM memory_entries LEFT JOIN memory_embeddings emb ON emb.entry_id = memory_entries.id WHERE 1=1';
    const params: SqlParam[] = [];

    if (query.namespace) {
      sql += ' AND namespace = ?';
      params.push(query.namespace);
    }
    if (query.key) {
      sql += ' AND key = ?';
      params.push(query.key);
    }
    if (query.keyPrefix) {
      sql += ' AND key LIKE ?';
      params.push(`${query.keyPrefix}%`);
    }
    if (query.memoryType) {
      sql += ' AND type = ?';
      params.push(query.memoryType);
    }
    if (query.accessLevel) {
      sql += ' AND access_level = ?';
      params.push(query.accessLevel);
    }
    if (query.ownerId) {
      sql += ' AND owner_id = ?';
      params.push(query.ownerId);
    }
    if (query.createdAfter) {
      sql += ' AND created_at >= ?';
      params.push(query.createdAfter);
    }
    if (query.createdBefore) {
      sql += ' AND created_at <= ?';
      params.push(query.createdBefore);
    }
    if (query.updatedAfter) {
      sql += ' AND updated_at >= ?';
      params.push(query.updatedAfter);
    }
    if (query.updatedBefore) {
      sql += ' AND updated_at <= ?';
      params.push(query.updatedBefore);
    }
    // Bi-temporal event-time filters (arXiv:2501.13956 — Zep/Graphiti)
    if (query.eventAfter) {
      sql += ' AND event_at >= ?';
      params.push(query.eventAfter);
    }
    if (query.eventBefore) {
      sql += ' AND event_at <= ?';
      params.push(query.eventBefore);
    }

    if (!query.includeExpired) {
      sql += ' AND (expires_at IS NULL OR expires_at > ?)';
      params.push(Date.now());
    }

    // MemoryQuery.tags is documented as "entries must have all specified tags"
    // (types.ts). Counting distinct matches enforces that; an EXISTS(... IN ...)
    // would be ANY-match, which is exactly the divergence that made the two old
    // backends return different result sets for the same call.
    if (query.tags && query.tags.length > 0) {
      this.validateTags(query.tags);
      const placeholders = query.tags.map(() => '?').join(', ');
      sql += ` AND (
        SELECT COUNT(DISTINCT t.tag) FROM memory_entry_tags t
        WHERE t.entry_id = memory_entries.id AND t.tag IN (${placeholders})
      ) = ?`;
      params.push(...query.tags, query.tags.length);
    }

    const colMap: Record<string, string> = {
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      lastAccessedAt: 'last_accessed_at',
      accessCount: 'access_count',
      key: 'key',
    };
    const orderCol =
      query.sortField && query.sortField !== 'score' && colMap[query.sortField]
        ? colMap[query.sortField]
        : 'created_at';
    const orderDir = query.sortDirection === 'asc' ? 'ASC' : 'DESC';
    sql += ` ORDER BY ${orderCol} ${orderDir} LIMIT ?`;

    const effectiveLimit = Math.min(Math.max(1, query.limit ?? MAX_QUERY_LIMIT), MAX_QUERY_LIMIT);
    params.push(effectiveLimit);
    if (query.offset) {
      sql += ' OFFSET ?';
      params.push(query.offset);
    }

    const rows = this.driver?.all(sql, params) ?? [];
    const results = rows.map((r) => this.rowToEntry(r));

    const duration = performance.now() - startTime;
    this.stats.queryCount++;
    this.stats.totalQueryTime += duration;
    this.emit('query:executed', { query, resultCount: results.length, duration });
    return results;
  },

  /**
   * Semantic search. Below MONOMIND_HNSW_THRESHOLD active embedded entries
   * (default 100,000), brute-force cosine over stored embeddings — namespace-
   * and TTL-filtered in SQL — stays cheaper (a few tens of ms at second-brain
   * scale). Above it, getAnnIndex() builds (or loads a persisted) HNSW graph
   * and this searches that instead; results are still namespace/threshold
   * filtered post-search to match the brute-force semantics exactly.
   */
  async search(
    this: SqlBackend,
    embedding: Float32Array,
    options: SearchOptions,
  ): Promise<SearchResult[]> {
    this.ensureInitialized();
    const ns = options.filters?.namespace;

    const ann = await this.getAnnIndex(embedding.length).catch(() => null);
    if (ann) {
      const applyFilters = (raw: Array<{ id: string; distance: number }>): SearchResult[] => {
        const out: SearchResult[] = [];
        for (const r of raw) {
          const entry = ann.entries.get(r.id);
          if (!entry) continue;
          if (ns && entry.namespace !== ns) continue;
          const score = 1 - r.distance;
          if (options.threshold !== undefined && score < options.threshold) continue;
          out.push({ entry, score, distance: r.distance });
          if (out.length >= options.k) break;
        }
        return out;
      };

      const overFetch = Math.max(options.k * 4, options.k + 20);
      let results = applyFilters(
        await ann.index.search(embedding, Math.min(overFetch, ann.entries.size)),
      );

      // A fixed over-fetch multiple assumes matches are spread roughly evenly
      // through the globally-nearest candidates. A namespace filter can
      // violate that — a namespace's true nearest neighbors may simply not be
      // among the top `overFetch` globally, understating recall (or
      // returning nothing) even though matches exist elsewhere in the graph.
      // There's no way to know how deep those matches rank without searching
      // further, so the only correct fallback is to widen all the way to the
      // full index rather than guessing a bigger-but-still-arbitrary number.
      if (ns && results.length < options.k && ann.entries.size > overFetch) {
        results = applyFilters(await ann.index.search(embedding, ann.entries.size));
      }

      results.sort((a, b) => b.score - a.score);
      return results;
    }

    const rows =
      this.driver?.iterate(
        `SELECT e.*, emb.embedding AS _emb
         FROM memory_entries e
         JOIN memory_embeddings emb ON emb.entry_id = e.id
        WHERE (e.expires_at IS NULL OR e.expires_at = 0 OR e.expires_at > ?)
        ${ns ? 'AND e.namespace = ?' : ''}`,
        ns ? [Date.now(), ns] : [Date.now()],
      ) ?? [];

    const results: SearchResult[] = [];
    for (const row of rows) {
      const buf = row._emb as Buffer | Uint8Array | undefined;
      if (!buf || buf.byteLength % 4 !== 0) continue;
      const vec = new Float32Array(buf.buffer as ArrayBuffer, buf.byteOffset, buf.byteLength / 4);
      if (vec.length !== embedding.length) continue;
      const similarity = cosineSimilarity(embedding, vec);
      if (options.threshold !== undefined && similarity < options.threshold) continue;
      // PKG-3: row already carries _emb from the JOIN; rowToEntry reads it
      // directly instead of re-querying memory_embeddings per row.
      results.push({ entry: this.rowToEntry(row), score: similarity, distance: 1 - similarity });
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, options.k);
  },

  /**
   * FTS5-accelerated keyword search (Issue #66).
   *
   * When the FTS5 index is available, text matching runs inside SQLite via
   * `MATCH` — orders of magnitude faster than loading 50k rows into JS. When
   * FTS5 is unavailable (e.g. sql.js WASM compiled without the extension) the
   * method returns `null` so the caller can fall back to JS-side matching.
   *
   * `queryText` is the raw user query; it is FTS5-tokenized automatically.
   * Special characters are escaped to prevent FTS5 syntax errors.
   */
  async keywordSearch(
    this: SqlBackend,
    queryText: string,
    options: {
      namespace?: string;
      limit?: number;
    } = {},
  ): Promise<
    { id: string; key: string; content: string; namespace: string; rank: number }[] | null
  > {
    this.ensureInitialized();
    if (!this._fts5Available) return null;

    const limit = Math.min(Math.max(1, options.limit ?? 50), MAX_QUERY_LIMIT);

    // Escape FTS5 special characters and build a query where every token must
    // appear (implicit AND). Tokens shorter than 2 chars are dropped — they
    // produce noise and FTS5 may reject single-char tokens depending on the
    // tokenizer configuration.
    const tokens = queryText
      .replace(/[":*^~(){}[\]\\]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 1)
      .map((t) => `"${t}"`);
    if (!tokens.length) return null;

    const d = this.driver!;
    const ns = options.namespace;

    const search = (match: string) =>
      d.all(
        `SELECT f.entry_id, f.key, f.content, e.namespace, rank
           FROM memory_entries_fts f
           JOIN memory_entries e ON e.id = f.entry_id
          WHERE memory_entries_fts MATCH ?
            AND (e.expires_at IS NULL OR e.expires_at = 0 OR e.expires_at > ?)
            ${ns ? 'AND e.namespace = ?' : ''}
          ORDER BY rank
          LIMIT ?`,
        ns ? [match, Date.now(), ns, limit] : [match, Date.now(), limit],
      );

    // Preserve the precise all-terms query first. Natural-language queries
    // often contain context words absent from the target document, though; a
    // zero-result strict search should still surface the best lexical leads.
    let rows = search(tokens.join(' '));
    if (rows.length === 0 && tokens.length > 1) rows = search(tokens.join(' OR '));

    return rows.map((r) => ({
      id: String(r.entry_id),
      key: String(r.key),
      content: String(r.content),
      namespace: String(r.namespace),
      // FTS5 rank is negative (lower = better match); invert to a 0–1 score.
      rank: Number(r.rank),
    }));
  },

  async count(this: SqlBackend, namespace?: string): Promise<number> {
    this.ensureInitialized();
    const row = namespace
      ? this.driver?.get('SELECT COUNT(*) as count FROM memory_entries WHERE namespace = ?', [
          namespace,
        ])
      : this.driver?.get('SELECT COUNT(*) as count FROM memory_entries');
    return Number(row?.count ?? 0);
  },

  async listNamespaces(this: SqlBackend): Promise<string[]> {
    this.ensureInitialized();
    return (this.driver?.all('SELECT DISTINCT namespace FROM memory_entries') ?? []).map((r) =>
      String(r.namespace),
    );
  },
};
