/**
 * Memory Knowledge Graph — retrieval: kgSearch (seed nodes, neighbourhood
 * expansion, evidence-aware ranking) and kgGlossary for extraction prompts.
 * Split out of memory-kg.ts, which re-exports the public symbols.
 */

import { bridgeGetEntry, bridgeSearchEntries } from './memory-bridge.js';
import type { KgExtractionMethod } from './memory-kg-claims.js';
import { readAdj, readIndexStatus } from './memory-kg-index.js';
import type { KgScope } from './memory-kg-model.js';
import { kgNamespaces, normalizeName } from './memory-kg-model.js';
import type { ScannedEntry } from './memory-kg-scan.js';
import { SEARCH_EDGE_SCAN_MAX, scanNamespace } from './memory-kg-scan.js';

// ── Search ──────────────────────────────────────────────────────────

export interface KgSearchResult {
  success: boolean;
  /** Rendered triplet lines, best first. */
  context: string;
  triplets: {
    source: string;
    relation: string;
    target: string;
    fact: string;
    score: number;
    /** How this edge came to exist. Absent means the edge predates method
     *  recording — not recorded, which is not the same as `asserted`. */
    method?: KgExtractionMethod;
    /** Live origins disagree about what this edge says. Present only when true. */
    conflict?: boolean;
    /** The edge's bridge entry id — feed this straight to `memory_feedback`
     *  (`bridgeApplyFeedback`/`bridgeRecordUsage`) to rate THIS relationship
     *  directly, rather than only the seed entity that surfaced it (K5). */
    id: string;
    /** The edge's stable graph key (`e:<hash>`, see `edgeKey`), for direct
     *  `bridgeGetEntry` lookup or diagnostics — distinct from `id` above. */
    key: string;
  }[];
  seeds: { name: string; type: string; description: string; score: number; id: string }[];
  /** True when the edge scan did NOT cover the whole namespace — the scan hit
   *  `SEARCH_EDGE_SCAN_MAX`, or the backend became unreadable partway. A
   *  relationship that exists may be missing from `triplets`; absence here is
   *  not evidence of absence in the graph. */
  truncated?: boolean;
  /** Edge rows actually read, so a caller can see how close it ran to the cap. */
  scannedEdges?: number;
  /** What the seed retrieval ACTUALLY ran, straight from the bridge — never what
   *  was hoped for. `keyword-fallback` means the vector path was tried and did
   *  not serve these results. Absent only when the bridge reported nothing. */
  method?: 'semantic' | 'keyword' | 'keyword-fallback';
  /** Why the vector path did not serve the seeds (absent when it did). */
  fallbackReason?: string;
  error?: string;
}

/** Seed candidates pulled before filtering and ranking. */
const SEARCH_SEED_LIMIT = 15;
/** Extra candidates fetched when a `nodeSet` narrows the graph.
 *
 *  The bridge has no tag filter, so set membership can only be tested after
 *  retrieval. Filtering the unfiltered top-15 meant a node that IS in the set
 *  but ranks 16th overall was missed — the set made results scarcer instead of
 *  more precise. Over-fetching moves the cutoff after the filter. */
const SEARCH_NODE_SET_OVERFETCH = 4;

/** How far a co-occurrence guess drops below an equally-seeded stated fact.
 *  Enough to lose a tie, not enough to hide it: `mentioned_with` between two
 *  strong seeds is still worth surfacing when nothing better was asserted. */
const HEURISTIC_PENALTY = 0.15;
/** Live origins disagree about what this edge says. Still returned — a disputed
 *  fact is information — but it does not outrank a settled one. */
const CONFLICT_PENALTY = 0.1;

/** Seeded retrieval → neighborhood → triplet ranking (cognee's brute-force
 *  triplet search, scaled down). Seed scores already carry the Phase 1 feedback
 *  blend, and the seed retrieval may be vector or keyword — `method` on the
 *  result says which actually ran.
 *
 *  Ranking weighs exactly two evidence signals, both read off the claim ledger:
 *  extraction method and description conflict. It deliberately does NOT model
 *  source credibility, claim freshness, or whether the relation itself answers
 *  the query — those need an evaluation set to tune against, and guessing at
 *  them would be the same overclaim this weighting exists to correct. */
export async function kgSearch(options: {
  query: string;
  dbPath?: string;
  limit?: number;
  nodeSet?: string;
  /** Whose graph to search. Omit for project-shared knowledge; a scoped search
   *  never reaches another org's facts, and never the shared graph either. */
  scope?: KgScope;
}): Promise<KgSearchResult> {
  try {
    const limit = options.limit ?? 8;
    const ns = kgNamespaces(options.scope);
    const seedsRes = await bridgeSearchEntries({
      query: options.query,
      namespace: ns.nodes,
      // Over-fetch when a set filter follows, so the cutoff lands AFTER it.
      limit: options.nodeSet ? SEARCH_SEED_LIMIT * SEARCH_NODE_SET_OVERFETCH : SEARCH_SEED_LIMIT,
      threshold: 0.25,
      dbPath: options.dbPath,
    });
    // What the retrieval actually was, carried on every return below: a keyword
    // fallback presented as vector-seeded search is the overclaim B5 names.
    const retrieval = {
      ...(seedsRes?.searchMethod ? { method: seedsRes.searchMethod } : {}),
      ...(seedsRes?.fallbackReason ? { fallbackReason: seedsRes.fallbackReason } : {}),
    };
    let seedResults = seedsRes?.results ?? [];
    if (options.nodeSet) {
      const setTag = normalizeName(options.nodeSet);
      seedResults = seedResults.filter((r) => (r.tags ?? []).includes(setTag));
    }
    seedResults = seedResults.slice(0, SEARCH_SEED_LIMIT);
    if (!seedResults.length)
      return { success: true, context: '', triplets: [], seeds: [], ...retrieval };

    const seedScore = new Map<string, number>();
    for (const s of seedResults) seedScore.set(s.key, s.score);

    const triplets: KgSearchResult['triplets'] = [];
    let scannedEdges = 0;
    let truncated = false;

    /** Score one edge against the seeded entities and, if relevant, push its
     *  triplet — shared by the indexed and exhaustive gathering paths below
     *  so ranking never depends on which one ran (K7). */
    const considerEdge = (e: ScannedEntry): void => {
      scannedEdges++;
      const md = (e.metadata ?? {}) as Record<string, unknown>;
      if (md?.kg !== 'edge' || md.valid_to != null) return;
      const src = String(md.src ?? '');
      const dst = String(md.dst ?? '');
      const sSrc = seedScore.get(src) ?? 0;
      const sDst = seedScore.get(dst) ?? 0;
      if (sSrc === 0 && sDst === 0) return;
      // Both endpoints seeded beats one; the unseeded endpoint contributes a
      // neutral 0.35 so bridging edges from a strong seed still surface.
      const relevance =
        (Math.max(sSrc, 0.35) + Math.max(sDst, 0.35)) / 2 + (sSrc > 0 && sDst > 0 ? 0.1 : 0);
      // Evidence, from the claim ledger. An edge whose method was never
      // recorded is left at its relevance score — unknown is not evidence
      // against it, and penalizing it would demote the entire pre-existing
      // graph relative to anything written today.
      const method =
        md.method === 'asserted' || md.method === 'heuristic'
          ? (md.method as KgExtractionMethod)
          : undefined;
      const conflict = md.conflict === true;
      const score = Math.max(
        0,
        relevance -
          (method === 'heuristic' ? HEURISTIC_PENALTY : 0) -
          (conflict ? CONFLICT_PENALTY : 0),
      );
      triplets.push({
        source: String(md.source_name ?? src),
        relation: String(md.relation ?? 'related_to'),
        target: String(md.target_name ?? dst),
        fact: e.content,
        score,
        ...(method ? { method } : {}),
        ...(conflict ? { conflict } : {}),
        id: e.id,
        key: e.key,
      });
    };
    // Scores are per-edge, so pruning to the running top-`limit` after every
    // batch yields exactly the same result as sorting the whole set at the end.
    const pruneToLimit = (): void => {
      if (triplets.length > limit) {
        triplets.sort((a, b) => b.score - a.score);
        triplets.length = limit;
      }
    };

    // K7: gather candidate edges via each seed's adjacency entry — O(seeds ×
    // degree) instead of a full namespace scan — when the scope's index is
    // ready and every seed's adjacency entry resolves. Any seed that misses
    // (index not ready, or an unresolvable ref) falls the WHOLE query back to
    // the exhaustive scan rather than silently searching only some seeds.
    let covered = false;
    let usedIndex = false;
    if ((await readIndexStatus(ns, options.dbPath)).state === 'ready') {
      const candidateKeys = new Set<string>();
      let indexOk = true;
      for (const s of seedResults) {
        const adj = await readAdj(ns, s.key, options.dbPath);
        if (adj === null) {
          indexOk = false;
          break;
        }
        for (const key of adj.edgeKeys) candidateKeys.add(key);
      }
      if (indexOk) {
        for (const key of candidateKeys) {
          const res = await bridgeGetEntry({ key, namespace: ns.edges, dbPath: options.dbPath });
          if (res?.found && res.entry) considerEdge(res.entry as ScannedEntry);
        }
        pruneToLimit();
        usedIndex = true;
        covered = true;
      }
    }
    // Paged edge scan (see monolean note in module header). Each page is folded
    // into the running top-`limit` immediately, so memory stays at one page
    // regardless of how many edges the namespace holds.
    if (!usedIndex) {
      covered = await scanNamespace(ns.edges, options.dbPath, (page) => {
        for (const e of page) considerEdge(e);
        pruneToLimit();
        if (scannedEdges >= SEARCH_EDGE_SCAN_MAX) {
          truncated = true;
          return false;
        }
        return true;
      });
    }
    // An unreadable namespace is an incomplete answer, not an empty graph.
    if (!covered) truncated = true;
    triplets.sort((a, b) => b.score - a.score);

    const seeds = seedResults.slice(0, limit).map((s) => {
      // metadata is not in search results; parse from rendered content "name — description"
      const dash = s.content.indexOf(' — ');
      return {
        name: dash > 0 ? s.content.slice(0, dash) : s.key,
        // Tags carry the stored type (`['kg', <type>, …]`). The key never did:
        // reading `key.split(':')[1]` reported the type of `n:shared_service`
        // as `shared_service`, and under hashed IDs would report a digest.
        type: (s.tags ?? [])[1] ?? 'entity',
        description: dash > 0 ? s.content.slice(dash + 3) : s.content,
        score: s.score,
        id: s.id,
      };
    });

    const context = [
      ...triplets.map(
        (t) =>
          `${t.source} —${t.relation}→ ${t.target}${t.fact && t.fact !== `${t.source} ${t.relation} ${t.target}` ? ` (${t.fact})` : ''}`,
      ),
      ...(triplets.length ? [] : seeds.map((s) => `${s.name}: ${s.description}`)),
    ].join('\n');

    return {
      success: true,
      context,
      triplets,
      seeds,
      scannedEdges,
      ...(truncated && { truncated }),
      ...retrieval,
    };
  } catch (err) {
    return {
      success: false,
      context: '',
      triplets: [],
      seeds: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── Glossary (anti-duplicate-entity injection for extraction prompts) ──

export async function kgGlossary(options?: {
  dbPath?: string;
  limit?: number;
  /** Whose entity names to offer. The coordinator glossary MUST be scoped:
   *  suggesting another org's entity names is how one org's claims get merged
   *  into another's graph under a shared name. */
  scope?: KgScope;
}): Promise<string[]> {
  const limit = options?.limit ?? 40;
  // Running top-`limit` by rank, deduplicated by normalized name. Folding each
  // page in and pruning keeps the whole node namespace in scope without ever
  // holding more than a page plus `limit` names.
  let top: { name: string; norm: string; rank: number }[] = [];

  await scanNamespace(kgNamespaces(options?.scope).nodes, options?.dbPath, (page) => {
    for (const e of page) {
      const md = e.metadata as Record<string, unknown>;
      // Glossary is for ENTITY name reuse — rule prose and extraction-source
      // Session nodes would drown it.
      const t = String(md?.type ?? '').toLowerCase();
      if (md?.node_set === 'rules' || t === 'rule' || t === 'session') continue;
      const fw = typeof md.feedback_weight === 'number' ? md.feedback_weight : 0.5;
      const freq = typeof md.frequency_weight === 'number' ? md.frequency_weight : 0;
      const version = typeof md.version === 'number' ? md.version : 1;
      const name = String(md.name ?? e.key);
      top.push({ name, norm: normalizeName(name), rank: version + freq + fw });
    }
    top.sort((a, b) => b.rank - a.rank);
    const seen = new Set<string>();
    const pruned: typeof top = [];
    for (const n of top) {
      if (seen.has(n.norm)) continue;
      seen.add(n.norm);
      pruned.push(n);
      if (pruned.length >= limit) break;
    }
    top = pruned;
  });

  return top.map((n) => n.name);
}
