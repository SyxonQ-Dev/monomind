/**
 * Memory Bridge — the read/search path: bridgeSearchEntries (semantic +
 * FTS5/BM25 keyword merge, stale and superseded-knowledge filtering,
 * cross-encoder reranking). Split out of memory-bridge.ts, which re-exports
 * it.
 */

import {
  _embedder,
  _reranker,
  _rerankerPromise,
  getBackend,
  loadReranker,
  rerankerDisabled,
  rerankResults,
} from './memory-bridge-backend.js';
import {
  blendScore,
  capResultContent,
  entryWeights,
  getAutomemConfig,
  logBridgeError,
} from './memory-bridge-core.js';
import { GLOBAL_BRAIN, getGlobalBrainDir, getProjectRoot } from './memory-bridge-paths.js';

export async function bridgeSearchEntries(options: {
  query: string;
  namespace?: string;
  limit?: number;
  threshold?: number;
  dbPath?: string;
  /** Skip cross-encoder reranking even if the model is loaded. */
  skipRerank?: boolean;
  /** When true, superseded knowledge chunks are kept in the results
   *  (flagged by the caller). Default false — removed documents are
   *  filtered out for security. */
  includeSuperseded?: boolean;
  /** Project root to read document metadata from for the knowledge-superseded
   *  check (default: getProjectRoot(), i.e. process.cwd()-derived). Callers
   *  operating on an explicit project directory that differs from cwd — e.g.
   *  searchKnowledge({ rootDir }) — must pass the SAME root here, or every
   *  freshly-ingested doc in that directory reads as superseded (its content
   *  hash won't be found in metadata read from the wrong place) and gets
   *  filtered out despite matching the query. */
  rootDir?: string;
}): Promise<{
  success: boolean;
  results: {
    id: string;
    key: string;
    content: string;
    score: number;
    namespace: string;
    provenance?: string;
    tags?: string[];
  }[];
  searchTime: number;
  /** What actually ran, never what was requested. 'keyword-fallback' means the
   *  vector path was attempted and did not produce the results. */
  searchMethod?: 'semantic' | 'keyword' | 'keyword-fallback';
  /** Whether a cross-encoder reranker was applied to the final results. */
  reranked?: boolean;
  /** Why the vector path did not serve these results (absent when it did). */
  fallbackReason?:
    | 'no-embedding-model'
    | 'empty-query'
    | 'embedding-failed'
    | 'no-semantic-matches';
  error?: string;
} | null> {
  const backend = await getBackend(options.dbPath);
  if (!backend) return null;

  try {
    const { query: queryStr, limit = 10, threshold = 0.3 } = options;
    // CLI callers pass 'all' as a no-filter sentinel — never treat it as a literal namespace
    const namespace =
      options.namespace && options.namespace !== 'all' ? options.namespace : undefined;
    const startTime = Date.now();

    // ── Knowledge removal support (issue #106) ──────────────────────
    // Pre-compute live document hashes for knowledge namespaces so we can
    // (a) over-fetch to compensate for superseded entries being filtered,
    // (b) filter them out after retrieval — ensuring removed documents
    //     are invisible to EVERY caller, not just searchKnowledge.
    // Dynamic import breaks the circular dependency: document-pipeline
    // imports getProjectRoot from this module.
    let _knowledgeLive: Set<string> | null = null;
    let _knowledgeHasMeta = false;
    let _isSupersededKey:
      | ((key: string, live: Set<string>, metaPresent: boolean) => boolean)
      | null = null;
    const knowledgeFilterActive = namespace?.startsWith('knowledge:') && !options.includeSuperseded;
    if (knowledgeFilterActive) {
      try {
        const dp = await import('../knowledge/document-pipeline.js');
        const rootDir =
          options.dbPath === GLOBAL_BRAIN
            ? getGlobalBrainDir()
            : (options.rootDir ?? getProjectRoot());
        _knowledgeLive = dp.liveContentHashes(rootDir);
        _knowledgeHasMeta = dp.hasKnowledgeMetadata(rootDir);
        _isSupersededKey = dp.isSupersededKey;
      } catch (e) {
        logBridgeError(
          'bridgeSearchEntries.knowledgeFilter',
          e,
        ); /* non-fatal: skip filtering when pipeline is unavailable */
      }
    }

    // Over-retrieve when the reranker is available: fetch more candidates so the
    // cross-encoder can reshuffle them. The reranker trims back to `limit`.
    // For knowledge namespaces, also over-fetch to compensate for superseded
    // document versions that will be filtered out below.
    const rerankerActive = !options.skipRerank && _reranker !== null && !rerankerDisabled();
    const knowledgeLimit =
      _knowledgeLive && _knowledgeLive.size > 0
        ? Math.min(Math.max(limit * 20, limit), 300)
        : limit;
    const retrieveK = rerankerActive
      ? Math.min(knowledgeLimit * 3, Math.max(20, knowledgeLimit))
      : knowledgeLimit;

    let results: any[] = [];
    let searchMethod: 'semantic' | 'keyword' | 'keyword-fallback' = 'keyword';
    // Reported to callers so "(semantic)" can never be printed over keyword hits.
    // The two reasons for skipping the vector path are distinct and must not be
    // conflated: a healthy model given an empty query is not a missing model.
    let fallbackReason:
      | 'no-embedding-model'
      | 'empty-query'
      | 'embedding-failed'
      | 'no-semantic-matches'
      | undefined = !_embedder
      ? 'no-embedding-model'
      : queryStr.length === 0
        ? 'empty-query'
        : undefined;
    let semanticAttempted = false;

    if (_embedder && queryStr.length > 0) {
      semanticAttempted = true;
      try {
        const queryEmbedding = await _embedder(queryStr);
        const searchResults = await backend.search(queryEmbedding, {
          k: retrieveK,
          threshold,
          filters: namespace ? { type: 'exact', namespace } : undefined,
        });
        const { feedbackInfluence } = getAutomemConfig();
        results = searchResults
          .map((r: any) => {
            const weights = entryWeights(r.entry.metadata);
            // Blend only here (semantic path): r.score is a genuine cosine similarity.
            const blended = blendScore(r.score, weights, feedbackInfluence);
            return {
              id: r.entry.id,
              key: r.entry.key,
              content: capResultContent(r.entry.content || ''),
              score: blended,
              namespace: r.entry.namespace,
              provenance: `semantic:${r.score.toFixed(3)}${blended !== r.score ? `→${blended.toFixed(3)}` : ''}`,
              tags: r.entry.tags ?? [],
              _createdAt: r.entry.createdAt || 0,
            };
          })
          .sort((a: any, b: any) => b.score - a.score);
        searchMethod = 'semantic';
        fallbackReason = undefined;
      } catch (e) {
        // fall through to keyword search — but never claim this was semantic
        fallbackReason = 'embedding-failed';
        if (process.env.DEBUG || process.env.MONOMIND_DEBUG)
          console.error(
            '[memory-bridge] semantic search failed — falling back to keyword matching:',
            e,
          );
      }
    }

    // Keyword search — always runs (not just as a fallback).
    // Entries stored without embeddings are invisible to the vector path,
    // so keyword results are merged into semantic results (union, deduplicated
    // by key) to ensure every findable entry surfaces regardless of whether
    // it has an embedding.  Semantic hits take priority on score.
    //
    // Issue #66: When the backend has FTS5, keyword matching runs inside
    // SQLite via MATCH — orders of magnitude faster than the old path that
    // loaded up to 50k rows and scanned them in JS. The JS fallback is
    // kept for sql.js WASM builds that lack the FTS5 extension.
    {
      const tokens = queryStr
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length > 1);
      let keywordHits: any[] = [];

      if (tokens.length) {
        // ── FTS5 fast path ──────────────────────────────────────────
        const fts5Results: any[] | null =
          typeof backend.keywordSearch === 'function'
            ? await backend.keywordSearch(queryStr, { namespace, limit }).catch(() => null)
            : null;

        if (fts5Results !== null && fts5Results.length > 0) {
          // FTS5 rank is negative (lower = better); normalise to 0–1 against
          // the BEST (largest-magnitude) result, not a hard floor of 1
          // (issue #224). BM25 IDF goes to zero/negative when a query term
          // appears in most or all of the matched rows — a small or
          // lexically-homogeneous result set (a duplicated FTS row for one
          // entry, per sql-schema.ts's `ensureFTS5Triggers`, was one way to
          // reach exactly this) — so a genuinely-best (or sole) match can
          // legitimately have |rank| < 1. A hard `Math.max(…,
          // 1)` floor then divides that down toward 0, displaying the
          // correct top match as ~0.00 instead of its best-available 1.0.
          // Mirrors the identical fix already applied to the JS BM25
          // fallback below (#126-review): only fall back to a floor of 1
          // when every rank is genuinely 0 (nothing to normalise against),
          // never merely because the raw magnitude is under 1.
          const rawMaxRank = Math.max(...fts5Results.map((r: any) => Math.abs(r.rank)));
          const maxRank = rawMaxRank > 0 ? rawMaxRank : 1;
          keywordHits = fts5Results.map((r: any) => {
            const score = rawMaxRank > 0 ? Math.abs(r.rank) / maxRank : 1;
            return {
              id: r.id,
              key: r.key,
              content: capResultContent(r.content || ''),
              score,
              namespace: r.namespace,
              provenance: `keyword-fts5:${score.toFixed(2)}`,
              tags: [] as string[],
              _createdAt: 0,
            };
          });
        } else {
          // ── JS fallback (no FTS5 or empty FTS5 result) ────────────
          const entries = await backend.query({
            type: 'exact',
            ...(namespace ? { namespace } : {}),
            limit: 50000,
          });

          // #126: Bm25Index.build() costs real time at scale (measured in
          // bm25-index.ts's own header: ~113ms/673 chunks, ~1.7s/12.5k
          // chunks) — this fallback can be handed up to 50,000 entries, so
          // building a fresh index on every call without a cap would make
          // large stores' searches slower, not better. Below the cap, BM25
          // (proper IDF weighting) replaces the naive token-overlap-fraction
          // scan; above it, the fast scan keeps running so latency never
          // regresses. MONOMIND_BM25=0 disables this arm entirely (mirrors
          // the MONOMIND_RERANKER kill-switch).
          const BM25_ENTRY_CAP = 1500;
          const bm25Enabled = (process.env.MONOMIND_BM25 ?? '1') !== '0';

          let bm25Ok = false;
          if (bm25Enabled && entries.length > 0 && entries.length <= BM25_ENTRY_CAP) {
            try {
              const { Bm25Index } = await import('./bm25-index.js');
              // #126-review: index by the entry's ARRAY POSITION, not e.key —
              // memory_entries only enforces UNIQUE(namespace, key), so a bare
              // key string can legitimately repeat across namespaces (e.g. two
              // agents each storing a 'summary' key in their own namespace).
              // Keying by e.key alone collided in that case: every BM25 hit
              // sharing that key string resolved to whichever entry happened
              // to be inserted last into the lookup map, silently returning
              // the wrong entry's id/content/namespace.
              const chunks = entries.map((e: any, i: number) => ({
                key: String(i),
                text: `${e.key || ''} ${e.content || ''}`,
              }));
              const idx = Bm25Index.build(chunks, () => false); // no superseded concept at this generic KV level — filtered later by callers that care
              const hits = idx.search(queryStr, limit);
              // #126-review: Math.max(..., 1) as a divide-by-zero guard also
              // silently floors the normalization divisor whenever every real
              // score is < 1 (common for small/sparse corpora — exactly the
              // regime this capped fallback runs in), so the top hit stopped
              // normalizing to 1.0 as the comment below claims. Only fall
              // back to 1 when there is no positive score to divide by.
              const rawMax = hits.length ? Math.max(...hits.map((h) => h.score)) : 0;
              const maxScore = rawMax > 0 ? rawMax : 1;
              keywordHits = hits.map((h) => {
                const e = entries[Number(h.key)];
                const normalized = h.score / maxScore; // BM25 scores aren't comparable across queries/corpora — normalise 0-1 like the FTS5 path does
                return {
                  id: e.id,
                  key: e.key,
                  content: capResultContent(e.content || ''),
                  score: normalized,
                  namespace: e.namespace,
                  provenance: `keyword-bm25:${normalized.toFixed(2)}`,
                  tags: e.tags ?? [],
                  _createdAt: e.createdAt || 0,
                };
              });
              bm25Ok = true;
            } catch (e) {
              // #126-review: BM25 build/search had no local try/catch, unlike
              // every other sub-path in this function — an exception here
              // used to propagate to the function's single outer catch,
              // discarding the whole call (including already-computed
              // semantic results) instead of degrading to the naive scan
              // below, which is what every other keyword-path failure does.
              if (process.env.DEBUG || process.env.MONOMIND_DEBUG)
                console.error(
                  '[memory-bridge] BM25 keyword search failed — falling back to token-overlap scan:',
                  e,
                );
            }
          }
          if (!bm25Ok) {
            keywordHits = entries
              .map((e: any) => {
                const haystack = `${e.key || ''} ${e.content || ''}`.toLowerCase();
                const hits = tokens.filter((t) => haystack.includes(t)).length;
                return { e, score: hits / tokens.length };
              })
              .filter((x: any) => x.score > 0)
              .sort((a: any, b: any) => b.score - a.score)
              .slice(0, limit)
              .map(({ e, score }: any) => ({
                id: e.id,
                key: e.key,
                content: capResultContent(e.content || ''),
                // Raw token-overlap fraction, NOT rescaled to look like a cosine.
                score,
                namespace: e.namespace,
                provenance: `keyword:${score.toFixed(2)}`,
                tags: e.tags ?? [],
                _createdAt: e.createdAt || 0,
              }));
          }
        }

        // Issue #223/#224 follow-up: FTS5/BM25 ranks above are normalised
        // RELATIVE to the best result in this call's own small candidate set
        // (score = |rank| / maxRank), so the top — or sole — hit always
        // lands at ~1.0 by construction, no matter how weak the actual
        // match is. `options.threshold` compared against that already-
        // inflated score can never reject a top/sole hit, so a single
        // coincidental partial-token overlap looks exactly as confident as
        // a genuine strong match. Gate on independent evidence instead: how
        // much of the QUERY the candidate actually covers. This can only
        // narrow the result set (never rescue something already excluded),
        // and doesn't touch the rank-normalisation math other callers rely on.
        keywordHits = keywordHits.filter((h: any) => {
          if (h.score < threshold) return false;
          const haystack = `${h.key || ''} ${h.content || ''}`.toLowerCase();
          const matchedFraction = tokens.filter((t) => haystack.includes(t)).length / tokens.length;
          return matchedFraction >= threshold;
        });

        if (results.length === 0) {
          // No semantic results — keyword is all we have.
          results = keywordHits;
          searchMethod = semanticAttempted ? 'keyword-fallback' : 'keyword';
          if (semanticAttempted && !fallbackReason) fallbackReason = 'no-semantic-matches';
        } else {
          // Merge: union deduplicated by key, semantic wins on duplicates.
          // Extras are flagged _keywordOnly so the reranking step below can
          // skip them — the cross-encoder scores r.content, and an entry
          // findable ONLY by keyword (e.g. a placeholder/near-empty content
          // whose relevance lives in the key) reranks as noise and gets
          // sliced off by the final `limit`, silently defeating the whole
          // point of merging it in. Guaranteed inclusion has to survive
          // reranking, not just the merge.
          const seenKeys = new Set(results.map((r: any) => r.key));
          const extras = keywordHits.filter((kh: any) => !seenKeys.has(kh.key));
          if (extras.length) {
            results = [...results, ...extras.map((e: any) => ({ ...e, _keywordOnly: true }))];
            // searchMethod stays 'semantic' — the primary path succeeded;
            // keyword only supplemented entries that lacked embeddings.
          }
        }
      } else if (results.length === 0) {
        // Empty token list AND no semantic results — nothing to search.
        searchMethod = semanticAttempted ? 'keyword-fallback' : 'keyword';
        if (semanticAttempted && !fallbackReason) fallbackReason = 'no-semantic-matches';
      }
    }

    // Filter stale entries based on automem config — skip for knowledge
    // namespaces (documents should remain searchable indefinitely)
    // Stale filtering is per-RESULT namespace (documents stay searchable
    // forever) — keying it on the query's namespace filter meant an
    // all-namespace search silently dropped knowledge:* results past the
    // stale cutoff.
    // org:* (cross-run org memory) and rules are durable learned state like
    // documents — the stale cliff silently erased org recall after a week.
    const durableNs = (ns: string) =>
      ns.startsWith('knowledge:') ||
      ns.startsWith('org:') ||
      ns.startsWith('agent:') ||
      ns.startsWith('kg:') ||
      ns === 'rules';
    const isKnowledgeNs = namespace ? durableNs(namespace) : false;
    if (!isKnowledgeNs) {
      const { staleDays } = getAutomemConfig();
      const staleCutoff = Date.now() - staleDays * 86400000;
      results = results.filter(
        (r: any) =>
          durableNs(String(r.namespace ?? '')) || !r._createdAt || r._createdAt > staleCutoff,
      );
    }
    results.forEach((r: any) => delete r._createdAt);

    // ── Knowledge superseded filtering (issue #106) ─────────────────
    // Remove document chunks whose content hash is no longer current
    // (i.e. the document was removed via `knowledge_remove` or replaced
    // by a newer ingest). This runs inside the bridge so every caller —
    // embeddings_search, CLI `memory search`, and searchKnowledge — gets
    // the same removal guarantee.
    if (_knowledgeLive && _isSupersededKey && results.length > 0) {
      results = results.filter(
        (r: any) => !_isSupersededKey?.(String(r.key ?? ''), _knowledgeLive!, _knowledgeHasMeta),
      );
      // Trim back to the originally requested limit after overfetch — but
      // never let this blind size-based cut drop a _keywordOnly extra (see
      // the merge above): reserve its slot and trim the rest first.
      if (results.length > limit) {
        const extras = results.filter((r: any) => r._keywordOnly);
        const main = results.filter((r: any) => !r._keywordOnly);
        const keep = Math.max(0, limit - extras.length);
        results = [...main.slice(0, keep), ...extras.slice(0, limit)];
      }
    }

    // Keyword-only extras are guaranteed to survive to the final result —
    // pull them out before reranking so the cross-encoder (which scores
    // r.content only) can't outrank them into oblivion, then reserve their
    // slots when re-merging below.
    const keywordOnlyResults = results.filter((r: any) => r._keywordOnly);
    let rerankPool = results.filter((r: any) => !r._keywordOnly);

    // ── Cross-encoder reranking ──────────────────────────────────────
    // Fires only when: reranker loaded, >1 result, not explicitly skipped.
    // Lazy-load on first qualifying search so startup stays fast.
    let reranked = false;
    if (!options.skipRerank && !rerankerDisabled() && rerankPool.length > 1) {
      if (!_reranker && !_rerankerPromise) {
        // First qualifying search — kick off the lazy load. This search
        // proceeds without reranking; the NEXT search will use it.
        loadReranker().catch(() => {
          /* swallowed — retry next time */
        });
      }
      if (_reranker) {
        const rr = await rerankResults(queryStr, rerankPool, limit);
        rerankPool = rr.reranked;
        reranked = rr.applied;
      }
    }

    if (keywordOnlyResults.length) {
      const keep = Math.max(0, limit - keywordOnlyResults.length);
      results = [...rerankPool.slice(0, keep), ...keywordOnlyResults.slice(0, limit)];
    } else {
      results = rerankPool;
    }
    results.forEach((r: any) => delete r._keywordOnly);

    return {
      success: true,
      results,
      searchTime: Date.now() - startTime,
      searchMethod,
      reranked,
      ...(searchMethod === 'semantic' ? {} : { fallbackReason }),
    };
  } catch (e) {
    logBridgeError('bridgeSearchEntries', e);
    return null;
  }
}
