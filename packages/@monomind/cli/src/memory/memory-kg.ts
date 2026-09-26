/**
 * Memory Knowledge Graph — entities, relations, and rules distilled from
 * agent sessions and org runs (cognee-concept port, Phase 2 of
 * docs/mastermind/2026-07-19-cognee-port-plan.md).
 *
 * Storage rides store A (memory-bridge) rather than a dedicated SQLite DB:
 * nodes live in namespace `kg:nodes`, edges in `kg:edges`, distilled rules
 * additionally in `rules` (so existing knowledge/injection surfaces find them).
 * That buys embeddings, upsert, sql.js fallback, and the Phase 1
 * feedback/frequency weighting for free — KG node ranking improves with use
 * automatically.
 *
 * OWNERSHIP is carried by `KgScope`, not by the store path. Every org under
 * one project root shares ONE org-memory store, so those namespaces would
 * otherwise be a single pool that any org can read, merge into, and roll back.
 * A scope suffixes every one of them (`kg:nodes:org:<org>`, …) and stamps the
 * asserting org onto every origin ref, so an org's reads, writes, glossary and
 * rollback all resolve through `kgNamespaces()` and can only reach what that
 * org asserted. An absent scope means PROJECT-SHARED knowledge — a scope in
 * its own right, not "all scopes". Crossing from an org into the shared graph
 * is `kgPromote`, an explicit operation, never a side effect of learning.
 *
 * IDENTITY is the (type, name) tuple, hashed length-prefixed so no component
 * can bleed into its neighbour and no distinction is truncated away — the same
 * injective-serialization discipline monograph's `symbolId`/`fileId` use, and
 * for the same reason. Name-only identity made `Person:Alex` and `Service:Alex`
 * one entity, and made two names that first differ at character 250 one entity
 * as well. Keys stay per-namespace, so scope still lives in the NAMESPACE: two
 * orgs asserting different facts about the same name produce the same id, and
 * only separate namespaces keep them from overwriting each other.
 *
 * Name-only merging did buy something real — it stopped the same entity forking
 * when the LLM said "Module" and the heuristic said "entity" — so that benefit
 * is kept by a NAME INDEX (`kg:names`) rather than by a lossy key. Resolution
 * goes through the index, never through a computed key: a generic assertion
 * adopts the single same-name entity if there is exactly one, a typed assertion
 * adopts a lone untyped one and promotes its type, and anything genuinely
 * ambiguous becomes a separate entity with the alternatives REPORTED as
 * candidates rather than silently merged.
 *
 * KNOWLEDGE IS CLAIMS, not a summary string. Each entity/edge/rule carries a
 * `claims` ledger of per-origin description contributions; the stored
 * `description` is DERIVED from it — the most recent contribution wins, because
 * description length measures verbosity and not truth. That is what makes a
 * correction expressible ("Now PostgreSQL" supersedes a longer MySQL blurb) and
 * what makes rollback reversible: withdrawing an origin drops its contribution
 * and RE-DERIVES the summary from the survivors, so the previous correct
 * description comes back instead of a bad one being frozen in place.
 * `origin_refs` remains, derived from the ledger, so provenance readers are
 * unaffected. Support is never silently truncated: past `MAX_CLAIMS` the entry
 * records `origins_dropped` and `provenance_complete:false`.
 *
 * EVIDENCE travels with the claim. Each contribution records how it was
 * obtained — `asserted` when someone stated it, `heuristic` when
 * `heuristicExtract` inferred it from two names sharing a sentence — and the
 * element's standing is projected from its live claims, with one asserted claim
 * outranking any number of guesses. A claim written before this recording
 * leaves the projection UNKNOWN rather than voting: reading an unrecorded
 * method as `asserted` would relabel the entire pre-existing graph as stated
 * fact. Retrieval uses exactly this and the `conflict` flag to rank, and
 * nothing else — source credibility and claim freshness need an evaluation set
 * to tune against, and guessing at them is the overclaim this replaced.
 *
 * MIGRATION: nothing is re-keyed, deleted, or orphaned. An entry written under
 * the old `n:<normalized-name>` scheme is still found — resolution falls back to
 * probing the legacy key — and is then adopted IN PLACE under its existing key
 * and registered in the name index. Legacy rows therefore keep working for
 * search, stats, glossary and rollback, and keep their edges (whose keys embed
 * the endpoint keys) intact. Only a genuinely NEW identity distinction — a
 * second type for a name, or a name that differs only past the old truncation
 * point — mints a new hashed id.
 *
 * // monolean: graph traversal is in-process over a paged kg:edges scan. The
 * // bridge exposes no indexed adjacency (src/dst) or origin lookup, so every
 * // neighbourhood/provenance question is a namespace scan; the upgrade path is
 * // a real SQLite edges table with indexed src/dst/origin columns, which turns
 * // these O(namespace) scans into O(matches). `kgStats` uses a real
 * // `bridgeCountEntries` (SELECT COUNT(*) WHERE namespace = ?) instead of a
 * // scan — that needs no history, a count is correct regardless of when a row
 * // was written. Adjacency/origin, in contrast, is NOT filled in here: an
 * // index built only from now on would silently miss every edge/claim written
 * // before it existed (there is no legacy-key probe for an arbitrary historical
 * // edge, unlike resolveEntity's single fallback key), so kgSearch/kgRollback
 * // would go from an honest, complete scan to an INcomplete indexed answer —
 * // a regression, not the fix. Closing this needs a real backfill/migration
 * // decision (how to populate the index for existing namespaces, and how to
 * // know when one is complete enough to trust), not more code here.
 *
 * @module v1/cli/memory/memory-kg
 */

import { bridgeCountEntries, bridgeGetEntry, bridgeListEntries } from './memory-bridge.js';
import type { KgIndexStatus } from './memory-kg-index.js';
import {
  addToAdj,
  addToOriginIndex,
  KG_INDEX_SCHEMA_VERSION,
  kgIndexedByOrigin,
  kgIndexedEdgesByEndpoint,
  readIndexStatus,
  writeIndexStatus,
} from './memory-kg-index.js';
import { kgIngest } from './memory-kg-ingest.js';
import type { KgEdgeInput, KgIngestResult, KgNodeInput, KgScope } from './memory-kg-model.js';
import {
  kgNamespaces,
  kgQualifyOrigin,
  MAX_DESC_LEN,
  MAX_EDGES_PER_CALL,
  MAX_NODES_PER_CALL,
  MAX_RULES_PER_CALL,
  normalizeName,
} from './memory-kg-model.js';
import { kgIngestRules } from './memory-kg-rules.js';
import type { KgReferenceEdge } from './memory-kg-scan.js';
import {
  clearNamespace,
  collectByOrigin,
  FailureLog,
  kgReferenceEdges,
  originsOf,
  SCAN_PAGE,
  scanNamespace,
} from './memory-kg-scan.js';

export type { KgClaim, KgExtractionMethod } from './memory-kg-claims.js';
export type { KgIndexState, KgIndexStatus } from './memory-kg-index.js';
export { kgIndexStatus } from './memory-kg-index.js';
export { kgIngest } from './memory-kg-ingest.js';
export type {
  KgEdgeInput,
  KgIngestResult,
  KgNamespaces,
  KgNodeInput,
  KgScope,
} from './memory-kg-model.js';
export {
  KG_ADJ_NS,
  KG_EDGES_NS,
  KG_ID_VERSION,
  KG_INDEX_STATUS_NS,
  KG_NAMES_NS,
  KG_NODES_NS,
  KG_ORIGIN_IDX_NS,
  kgNamespaces,
  kgQualifyOrigin,
  nodeKey,
  normalizeName,
  RULES_NS,
} from './memory-kg-model.js';
export type { KgNameCandidate } from './memory-kg-names.js';
export { kgRollback } from './memory-kg-rollback.js';
export type { RuleVerdict } from './memory-kg-rules.js';
export { kgIngestRules, kgListRules } from './memory-kg-rules.js';
export type { KgReferenceEdge } from './memory-kg-scan.js';
export { kgReferenceEdges } from './memory-kg-scan.js';
export type { KgSearchResult } from './memory-kg-search.js';
export { kgGlossary, kgSearch } from './memory-kg-search.js';

// ── Promotion (org-owned → project-shared, explicit) ────────────────

export interface KgPromoteResult {
  success: boolean;
  nodes: number;
  edges: number;
  rules: number;
  /** Origin the shared copy carries, so the promotion can be withdrawn on its
   *  own and the shared graph records who shared the claim. */
  promotedAs: string;
  failures?: string[];
  error?: string;
}

/** Copy one origin's claims out of an org's scope into project-shared
 *  knowledge.
 *
 *  Sharing is deliberate, never a side effect of learning: `kgIngest` under a
 *  scope only ever writes that org's namespaces, and this is the one path a
 *  claim takes across the boundary. The org keeps its own copy untouched — the
 *  shared copy is an INDEPENDENT assertion under `promoted:<org-ref>`, so
 *  rolling back either side leaves the other standing, and a shared claim
 *  always names the org that vouched for it.
 *
 *  Like ingest, NOT atomic: the counters report what actually landed. */
export async function kgPromote(options: {
  /** The org-side ref to promote, unqualified (e.g. `run:m4x2`). */
  originRef: string;
  /** Owner the claims are promoted FROM. Promoting from the shared scope is a
   *  no-op and is refused rather than silently duplicating. */
  from: KgScope;
  dbPath?: string;
}): Promise<KgPromoteResult> {
  const empty = { nodes: 0, edges: 0, rules: 0 };
  if (!options.from?.org?.trim())
    return {
      success: false,
      ...empty,
      promotedAs: '',
      error: 'promotion needs an owning org to promote from',
    };

  const ns = kgNamespaces(options.from);
  const sourceRef = kgQualifyOrigin(options.originRef, options.from);
  const promotedAs = `promoted:${sourceRef}`;
  const failures = new FailureLog();

  try {
    const [nodeHits, edgeHits, ruleHits] = await Promise.all([
      collectByOrigin(ns.nodes, sourceRef, options.dbPath),
      collectByOrigin(ns.edges, sourceRef, options.dbPath),
      collectByOrigin(ns.rules, sourceRef, options.dbPath),
    ]);
    // A partial read would promote a partial claim set while reporting the
    // whole origin as shared.
    for (const [name, hit] of [
      ['nodes', nodeHits],
      ['edges', edgeHits],
      ['rules', ruleHits],
    ] as const)
      if (!hit.covered) failures.note(`${name}: memory backend unavailable`);
    if (failures.failed)
      return {
        success: false,
        ...empty,
        promotedAs,
        failures: failures.messages,
        error: failures.summary(),
      };

    // Rule NODES are re-created by kgIngestRules; promoting them again through
    // kgIngest would double-count and strip their rules-namespace entry.
    const nodes: KgNodeInput[] = nodeHits.entries
      .filter((e) => {
        const md = (e.metadata ?? {}) as Record<string, unknown>;
        return md.node_set !== 'rules' && String(md.type ?? '').toLowerCase() !== 'rule';
      })
      .map((e) => {
        const md = (e.metadata ?? {}) as Record<string, unknown>;
        return {
          name: String(md.name ?? e.key),
          type: String(md.type ?? 'entity'),
          description: String(md.description ?? ''),
          nodeSet: typeof md.node_set === 'string' ? md.node_set : undefined,
        };
      });
    const edges: KgEdgeInput[] = edgeHits.entries.map((e) => {
      const md = (e.metadata ?? {}) as Record<string, unknown>;
      return {
        source: String(md.source_name ?? md.src ?? ''),
        target: String(md.target_name ?? md.dst ?? ''),
        relation: String(md.relation ?? 'related_to'),
        description: String(md.description ?? ''),
      };
    });
    const rules = ruleHits.entries.map((e) => {
      const md = (e.metadata ?? {}) as Record<string, unknown>;
      return { rule: String(md.rule ?? e.content.split('\n')[0]) };
    });

    let promotedNodes = 0,
      promotedEdges = 0,
      promotedRules = 0;
    /** A batch that REJECTED part of what it was handed did not promote the
     *  whole origin, so it cannot be reported as a clean share. Rejections are
     *  not in `failures` — they are the caller's payload being refused, not the
     *  bridge failing — so they have to be carried across explicitly. */
    const carry = (res: KgIngestResult, what: string) => {
      if (res.failures?.length) for (const m of res.failures) failures.note(m);
      const rejected = (res.nodesRejected ?? 0) + (res.edgesRejected ?? 0);
      if (rejected) failures.note(`${what}: ${rejected} item(s) rejected — ${res.rejections?.[0]}`);
    };
    // kgIngest caps a call at 500 nodes / 1000 edges, so a large origin has to
    // be promoted in batches rather than silently truncated. Nodes go first so
    // every edge endpoint already exists when the edges land.
    for (let i = 0; i < nodes.length; i += MAX_NODES_PER_CALL) {
      const res = await kgIngest({
        nodes: nodes.slice(i, i + MAX_NODES_PER_CALL),
        originRef: promotedAs,
        dbPath: options.dbPath,
      });
      promotedNodes += res.nodesAdded + res.nodesMerged;
      carry(res, 'promoted nodes');
    }
    for (let i = 0; i < edges.length; i += MAX_EDGES_PER_CALL) {
      const res = await kgIngest({
        nodes: [],
        edges: edges.slice(i, i + MAX_EDGES_PER_CALL),
        originRef: promotedAs,
        dbPath: options.dbPath,
      });
      promotedEdges += res.edgesAdded + res.edgesMerged;
      carry(res, 'promoted edges');
    }
    for (let i = 0; i < rules.length; i += MAX_RULES_PER_CALL) {
      const res = await kgIngestRules({
        rules: rules.slice(i, i + MAX_RULES_PER_CALL),
        originRef: promotedAs,
        dbPath: options.dbPath,
      });
      promotedRules += res.accepted;
      if (res.failures?.length) for (const m of res.failures) failures.note(m);
      const invalid = res.verdicts.filter((v) => v.verdict === 'invalid').length;
      if (invalid) failures.note(`promoted rules: ${invalid} rejected as invalid`);
    }

    return {
      success: !failures.failed,
      nodes: promotedNodes,
      edges: promotedEdges,
      rules: promotedRules,
      promotedAs,
      ...(failures.failed ? { failures: failures.messages, error: failures.summary() } : {}),
    };
  } catch (err) {
    return {
      success: false,
      ...empty,
      promotedAs,
      ...(failures.messages.length ? { failures: failures.messages } : {}),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── Consolidation candidates (cognee consolidate_entity_descriptions) ──

export interface ConsolidationCandidate {
  name: string;
  type: string;
  description: string;
  edgeCount: number;
  /** Neighborhood facts to merge into one canonical description. */
  neighborhood: string[];
}

/** Entities whose descriptions are stale relative to their connectivity —
 *  the LLM half runs in the LIVE agent: it rewrites each candidate's
 *  description from the neighborhood facts and resubmits via memory_kg_ingest.
 *  A resubmission is a NEW contribution and therefore the current one, so a
 *  shorter but better-supported summary now wins; under "longest description
 *  wins" a consolidation that tightened the prose was silently discarded.
 *  No LLM here (fully local constraint). */
export async function kgConsolidateCandidates(options?: {
  dbPath?: string;
  /** Minimum edges for a node to qualify (default 3). */
  minEdges?: number;
  limit?: number;
  scope?: KgScope;
}): Promise<ConsolidationCandidate[]> {
  const minEdges = options?.minEdges ?? 3;
  const limit = options?.limit ?? 10;
  const ns = kgNamespaces(options?.scope);

  // Degree index over the FULL edge namespace. Only the first 12 facts per node
  // are kept (that is all the result exposes), so the index costs a bounded
  // amount per node rather than one string per edge.
  const degree = new Map<string, { count: number; facts: string[] }>();
  await scanNamespace(ns.edges, options?.dbPath, (page) => {
    for (const e of page) {
      const md = e.metadata as Record<string, unknown>;
      for (const end of [String(md.src ?? ''), String(md.dst ?? '')]) {
        if (!end) continue;
        const slot = degree.get(end) ?? { count: 0, facts: [] };
        slot.count++;
        if (slot.facts.length < 12) slot.facts.push(e.content);
        degree.set(end, slot);
      }
    }
  });

  let candidates: ConsolidationCandidate[] = [];
  await scanNamespace(ns.nodes, options?.dbPath, (page) => {
    for (const n of page) {
      const md = n.metadata as Record<string, unknown>;
      const slot = degree.get(n.key);
      if (!slot || slot.count < minEdges) continue;
      const description = String(md.description ?? '');
      // Cap the growth target at MAX_DESC_LEN — a very-high-degree node whose
      // description is already at the cap can never "grow out" of candidacy and
      // would otherwise permanently occupy a slot.
      if (description.length >= Math.min(40 * slot.count, MAX_DESC_LEN)) continue;
      candidates.push({
        name: String(md.name ?? n.key),
        type: String(md.type ?? 'entity'),
        description,
        edgeCount: slot.count,
        neighborhood: slot.facts,
      });
    }
    // Ranking is per-node, so keeping only the running top-`limit` after each
    // page gives the same answer as ranking every node at the end.
    candidates.sort((a, b) => b.edgeCount - a.edgeCount);
    candidates = candidates.slice(0, limit);
  });
  return candidates;
}

// ── Stats ───────────────────────────────────────────────────────────

/** Real counts, not page lengths. `bridgeListEntries.total` reports how many
 *  rows that one call returned, so the old capped list made a 10,001-node graph
 *  report exactly 10,000 forever.
 *
 *  Tries a real indexed `SELECT COUNT(*) WHERE namespace = ?` first
 *  (`bridgeCountEntries`, K7) — cheap and exact, since every row in a KG
 *  namespace is exactly one node/edge/rule (the name index lives in its own
 *  namespace). Falls back to the paginated scan — one query per 1,000 rows,
 *  still exact — when the loaded bridge predates `bridgeCountEntries`, or a
 *  test double doesn't stub it. */
export async function kgStats(options?: {
  dbPath?: string;
  /** Whose graph to measure. Counting every org's facts under one org's name
   *  is what made `org memory <name> stats` a fiction. */
  scope?: KgScope;
}): Promise<{ nodes: number; edges: number; rules: number }> {
  const ns = kgNamespaces(options?.scope);
  const count = async (namespace: string) => {
    try {
      const real = await bridgeCountEntries(namespace, options?.dbPath);
      if (real !== null) return real;
    } catch {
      /* bridgeCountEntries unavailable on this loaded bridge (or a test
         double that doesn't stub it) — fall back to the exhaustive scan. */
    }
    let n = 0;
    await scanNamespace(namespace, options?.dbPath, (page) => {
      n += page.length;
    });
    return n;
  };
  const [nodes, edges, rules] = await Promise.all([
    count(ns.nodes),
    count(ns.edges),
    count(ns.rules),
  ]);
  return { nodes, edges, rules };
}

// ── Rebuild (K7): the one function that builds/repairs the derived index ──

/** Entities/origins sampled for post-build validation. A scan that saw fewer
 *  than this many distinct entities AND origins gets FULL validation, not a
 *  sample — most real scopes will. `KgRebuildResult.status.validation` says
 *  which happened, honestly, rather than letting "validated" imply "all". */
const VALIDATE_SAMPLE = 200;

export interface KgRebuildResult {
  success: boolean;
  status: KgIndexStatus;
  validation?: { sampledEntities: number; sampledOrigins: number; full: boolean };
  error?: string;
}

function phaseOrder(phase: 'nodes' | 'edges' | 'rules' | undefined): number {
  return phase === 'edges' ? 1 : phase === 'rules' ? 2 : 0;
}

function sameEdgeKeySet(a: KgReferenceEdge[], b: KgReferenceEdge[]): boolean {
  const ak = new Set(a.map((e) => e.key));
  const bk = new Set(b.map((e) => e.key));
  if (ak.size !== bk.size) return false;
  for (const k of ak) if (!bk.has(k)) return false;
  return true;
}

/** (Re)build a scope's derived index from canonical data — nodes, then
 *  edges, then rules, that fixed order, resuming from the last checkpointed
 *  `{phase, offset}` rather than restarting when a prior call was
 *  interrupted mid-build. Every write here (`addToAdj`/`addToOriginIndex`)
 *  is idempotent, so a page reprocessed after an interruption cannot
 *  duplicate an entry.
 *
 *  A concurrent ingest/rollback during the build is safe, not just tolerated:
 *  the dual-write hooks run whenever state is not `absent`/`failed`, so a
 *  write made mid-build is captured whether or not the scan has reached that
 *  row yet — at worst twice, which idempotency absorbs for free. The one
 *  residual race (a row deleted between the scan reading it and the scan's
 *  own write landing) can leave a dangling ref in the index; it is never
 *  observable as wrong data, because every indexed READ
 *  (`kgIndexedEdgesByEndpoint`/`kgIndexedByOrigin`) returns `null` — and the
 *  caller falls back to the exhaustive scan — the instant it cannot resolve
 *  a ref it holds. This is the backend's real capability (single-row CAS,
 *  no cross-row transaction), used honestly rather than claiming atomicity
 *  it cannot provide.
 *
 *  Ends in `validating`: samples up to `VALIDATE_SAMPLE` of the entities and
 *  origins the scan actually saw, and re-reads them through the just-built
 *  index, comparing against a FRESH, independent reference read
 *  (`kgReferenceEdges`/`collectByOrigin`) — not the in-memory data the build
 *  itself computed, which would only prove the build agrees with itself. A
 *  write that silently failed, or a concurrent change the dual-write hooks
 *  missed, is exactly what this catches before the index is ever trusted. */
export async function kgRebuildIndex(options?: {
  scope?: KgScope;
  dbPath?: string;
}): Promise<KgRebuildResult> {
  const ns = kgNamespaces(options?.scope);
  const dbPath = options?.dbPath;
  let status = await readIndexStatus(ns, dbPath);
  // Resume from the checkpointed cursor for an interrupted build or a
  // resumable (build-phase) failure; a fresh scan for everything else —
  // `absent`, `ready` (this call IS the deliberate re-verify), and a
  // validation-phase failure, where something already written was wrong.
  const resume = status.state === 'building' || (status.state === 'failed' && status.resumable);
  if (!resume) {
    status = {
      state: 'building',
      schemaVersion: KG_INDEX_SCHEMA_VERSION,
      cursor: { phase: 'nodes', offset: 0 },
      counts: { nodes: 0, edges: 0, rules: 0 },
      startedAt: Date.now(),
    };
    if (!(await writeIndexStatus(ns, status, dbPath))) {
      return { success: false, status, error: 'could not persist initial build status' };
    }
  }

  const seenEntities: string[] = [];
  const seenOrigins: string[] = [];
  const noteEntity = (id: string) => {
    if (id && !seenEntities.includes(id) && seenEntities.length < VALIDATE_SAMPLE) {
      seenEntities.push(id);
    }
  };
  const noteOrigin = (ref: string) => {
    if (!seenOrigins.includes(ref) && seenOrigins.length < VALIDATE_SAMPLE) seenOrigins.push(ref);
  };

  // `addToAdj`/`addToOriginIndex` only APPEND onto whatever is already
  // there. That's exactly right for a RESUME (everything present was
  // written earlier in this same build attempt), but wrong for a FRESH
  // build: a stale or corrupted entry left over from a PRIOR build (e.g.
  // the exact thing a failed validation just caught) would never be
  // cleared, only added to. So a fresh build clears both derived-index
  // namespaces up front, once, before touching any phase — every write for
  // the rest of THIS build attempt, in this call or a later one resuming
  // it, can then safely append, because the namespace is known to hold only
  // rows this attempt wrote.
  if (!resume) {
    const adjCleared = await clearNamespace(ns.adj, dbPath);
    const originCleared = await clearNamespace(ns.originIdx, dbPath);
    if (!adjCleared || !originCleared) {
      status = { ...status, state: 'failed', error: 'could not clear prior index before rebuild' };
      await writeIndexStatus(ns, status, dbPath);
      return { success: false, status, error: status.error };
    }
  }

  const phases: { phase: 'nodes' | 'edges' | 'rules'; namespace: string }[] = [
    { phase: 'nodes', namespace: ns.nodes },
    { phase: 'edges', namespace: ns.edges },
    { phase: 'rules', namespace: ns.rules },
  ];

  try {
    for (const { phase, namespace } of phases) {
      if (phaseOrder(status.cursor?.phase) > phaseOrder(phase)) continue; // already scanned
      let offset = status.cursor?.phase === phase ? (status.cursor.offset ?? 0) : 0;
      let count = status.counts?.[phase] ?? 0;
      for (;;) {
        const page = await bridgeListEntries({ namespace, limit: SCAN_PAGE, offset, dbPath });
        if (!page) {
          // The cursor stays exactly where it was: everything indexed before
          // this page is still correct, only incomplete, so a retry resumes.
          status = {
            ...status,
            state: 'failed',
            resumable: true,
            error: `${namespace}: backend unavailable during rebuild`,
          };
          await writeIndexStatus(ns, status, dbPath);
          return { success: false, status, error: status.error };
        }
        for (const e of page.entries) {
          const md = (e.metadata ?? {}) as Record<string, unknown>;
          count++;
          if (phase === 'edges' && md.kg === 'edge') {
            const src = String(md.src ?? '');
            const dst = String(md.dst ?? '');
            if (src) {
              await addToAdj(ns, src, e.key, dbPath);
              noteEntity(src);
            }
            if (dst && dst !== src) {
              await addToAdj(ns, dst, e.key, dbPath);
              noteEntity(dst);
            }
          }
          if (phase === 'nodes') noteEntity(e.key);
          for (const originRef of originsOf(e)) {
            await addToOriginIndex(ns, originRef, { ns: namespace, key: e.key }, dbPath);
            noteOrigin(originRef);
          }
        }
        offset += page.entries.length;
        status = {
          ...status,
          cursor: { phase, offset },
          counts: { ...status.counts, [phase]: count } as KgIndexStatus['counts'],
        };
        await writeIndexStatus(ns, status, dbPath);
        if (page.entries.length < SCAN_PAGE) break; // last page of this namespace
      }
    }

    status = { ...status, state: 'validating' };
    await writeIndexStatus(ns, status, dbPath);

    const mismatches: string[] = [];
    for (const id of seenEntities) {
      const indexed = await kgIndexedEdgesByEndpoint(ns, id, dbPath);
      const reference = await kgReferenceEdges({ endpointId: id, scope: options?.scope, dbPath });
      if (indexed === null || !reference.success || reference.truncated) {
        mismatches.push(`entity ${id}: reference read incomplete`);
        continue;
      }
      if (!sameEdgeKeySet(indexed, reference.edges))
        mismatches.push(`entity ${id}: adjacency mismatch`);
    }
    for (const originRef of seenOrigins) {
      const indexed = await kgIndexedByOrigin(ns, originRef, dbPath);
      if (indexed === null) {
        mismatches.push(`origin ${originRef}: index unreadable`);
        continue;
      }
      const refA = await collectByOrigin(ns.nodes, originRef, dbPath);
      const refB = await collectByOrigin(ns.edges, originRef, dbPath);
      const refC = await collectByOrigin(ns.rules, originRef, dbPath);
      if (!refA.covered || !refB.covered || !refC.covered) {
        mismatches.push(`origin ${originRef}: reference scan incomplete`);
        continue;
      }
      const expected = new Set([
        ...refA.entries.map((e) => `${ns.nodes}|${e.key}`),
        ...refB.entries.map((e) => `${ns.edges}|${e.key}`),
        ...refC.entries.map((e) => `${ns.rules}|${e.key}`),
      ]);
      const indexedKeys = new Set(indexed.map((e) => `${e.ns}|${e.entry.key}`));
      if (expected.size !== indexedKeys.size || [...expected].some((k) => !indexedKeys.has(k))) {
        mismatches.push(`origin ${originRef}: support-index mismatch`);
      }
    }

    const full = seenEntities.length < VALIDATE_SAMPLE && seenOrigins.length < VALIDATE_SAMPLE;
    const validation = {
      sampledEntities: seenEntities.length,
      sampledOrigins: seenOrigins.length,
      full,
    };
    if (mismatches.length) {
      const summary = mismatches.slice(0, 5).join('; ');
      status = {
        ...status,
        state: 'failed',
        error: `validation failed: ${summary}${mismatches.length > 5 ? ` (+${mismatches.length - 5} more)` : ''}`,
      };
      await writeIndexStatus(ns, status, dbPath);
      return { success: false, status, validation, error: status.error };
    }

    status = { ...status, state: 'ready', error: undefined };
    await writeIndexStatus(ns, status, dbPath);
    return { success: true, status, validation };
  } catch (err) {
    status = {
      ...status,
      state: 'failed',
      error: err instanceof Error ? err.message : String(err),
    };
    try {
      await writeIndexStatus(ns, status, dbPath);
    } catch {
      /* best-effort — see markIndexFailed */
    }
    return { success: false, status, error: status.error };
  }
}

// ── Integrity ───────────────────────────────────────────────────────

export interface KgIntegrityResult {
  success: boolean;
  edges: number;
  /** Edges naming an endpoint that does not exist. Retrieval is node-seeded,
   *  so such an edge is a fact unreachable through either of the things it is
   *  about — it can only be found by a check like this one. */
  dangling: { key: string; missing: string[] }[];
  /** True when the edge scan did not cover the namespace: absence of a dangling
   *  edge here is then not evidence that there is none. */
  truncated?: boolean;
  error?: string;
}

/** Verify that every edge's endpoints exist.
 *
 *  `kgIngest` now creates missing endpoints before writing an edge and
 *  `kgRollback` removes edges whose endpoints it deleted, so a healthy graph
 *  reports nothing. This exists for graphs written before either rule, and as
 *  the check that says so rather than assuming it. */
export async function kgIntegrityCheck(options?: {
  dbPath?: string;
  scope?: KgScope;
  /** Dangling edges to report before stopping (default 100). */
  limit?: number;
}): Promise<KgIntegrityResult> {
  const ns = kgNamespaces(options?.scope);
  const limit = options?.limit ?? 100;
  const dangling: KgIntegrityResult['dangling'] = [];
  let edges = 0;
  try {
    /** Endpoint id → exists. One keyed lookup per DISTINCT endpoint. */
    const seen = new Map<string, boolean>();
    const exists = async (id: string): Promise<boolean> => {
      const hit = seen.get(id);
      if (hit !== undefined) return hit;
      const res = await bridgeGetEntry({ key: id, namespace: ns.nodes, dbPath: options?.dbPath });
      const found = Boolean(res?.found && res.entry);
      seen.set(id, found);
      return found;
    };

    // Collect first, then probe: the probes are reads, but interleaving many
    // per page would hold the page open far longer than the scan needs.
    const rows: { key: string; src: string; dst: string }[] = [];
    const covered = await scanNamespace(ns.edges, options?.dbPath, (page) => {
      for (const e of page) {
        const md = (e.metadata ?? {}) as Record<string, unknown>;
        if (md.kg !== 'edge') continue;
        edges++;
        rows.push({ key: e.key, src: String(md.src ?? ''), dst: String(md.dst ?? '') });
      }
    });

    for (const row of rows) {
      if (dangling.length >= limit) break;
      const missing: string[] = [];
      if (!row.src || !(await exists(row.src))) missing.push(row.src || '<no src>');
      if (!row.dst || !(await exists(row.dst))) missing.push(row.dst || '<no dst>');
      if (missing.length) dangling.push({ key: row.key, missing });
    }

    return {
      success: true,
      edges,
      dangling,
      ...(covered && dangling.length < limit ? {} : { truncated: true }),
    };
  } catch (err) {
    return {
      success: false,
      edges,
      dangling,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── Heuristic extraction (LLM-less fallback) ────────────────────────

/** Regex extraction for when no LLM is in the loop (memory-palace lineage):
 *  proper-noun phrases and `code identifiers` become entities, sentence
 *  co-occurrence becomes `mentioned_with` edges. Lower-trust by design — real
 *  entity/relation quality comes from the LLM path (memory_kg_ingest called
 *  by the live agent, or the org coordinator's org_learn tool).
 *
 *  Callers MUST ingest this with `method: 'heuristic'`. "Lower-trust by design"
 *  was true and unenforced: nothing downstream could tell these edges from
 *  facts an agent stated, so ranking treated them identically. */
export function heuristicExtract(
  text: string,
  opts?: { sourceName?: string },
): { nodes: KgNodeInput[]; edges: KgEdgeInput[] } {
  const nodes = new Map<string, KgNodeInput>();
  const edges: KgEdgeInput[] = [];
  const src = String(text || '').slice(0, 50_000);

  const sentences = src.split(/(?<=[.!?])\s+|\n+/).slice(0, 400);
  const STOPWORDS = new Set([
    'The',
    'This',
    'That',
    'These',
    'Those',
    'It',
    'A',
    'An',
    'If',
    'When',
    'While',
    'But',
    'And',
    'Or',
    'For',
    'Then',
    'Also',
    'Not',
    'No',
    'Yes',
    'I',
    'We',
    'You',
    'They',
    'He',
    'She',
    'Run',
    'Outcome',
    'Assets',
    'Goal',
    'Org',
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
    'Monday',
    'Tuesday',
    'Wednesday',
    'Thursday',
    'Friday',
    'Saturday',
    'Sunday',
  ]);

  for (const sentence of sentences) {
    const found: string[] = [];
    // Proper-noun phrases: consecutive Capitalized words (2-40 chars each).
    for (const m of sentence.matchAll(
      /\b([A-Z][a-zA-Z0-9_-]{1,40}(?:\s+[A-Z][a-zA-Z0-9_-]{1,40}){0,3})\b/g,
    )) {
      const phrase = m[1];
      if (STOPWORDS.has(phrase)) continue;
      found.push(phrase);
    }
    // Code identifiers in backticks or dotted/slashed paths.
    for (const m of sentence.matchAll(/`([^`\n]{2,80})`/g)) found.push(m[1]);

    const uniq = [...new Set(found)].slice(0, 8);
    for (const name of uniq) {
      if (!nodes.has(normalizeName(name))) {
        nodes.set(normalizeName(name), {
          name,
          type: /[./`(]/.test(name) ? 'CodeElement' : 'Entity',
          description: sentence.trim().slice(0, 300),
        });
      }
    }
    // Co-occurrence edges within a sentence (first mention chains to the rest).
    // `mentioned_with`, not `relates_to`: all this observed is two names in one
    // sentence. `relates_to` reads as an asserted relation, and a reader cannot
    // tell one that an agent stated from one this regex inferred.
    for (let i = 1; i < uniq.length && i < 4; i++) {
      edges.push({
        source: uniq[0],
        target: uniq[i],
        relation: 'mentioned_with',
        description: sentence.trim().slice(0, 300),
      });
    }
  }

  if (opts?.sourceName) {
    const srcNode: KgNodeInput = {
      name: opts.sourceName,
      type: 'Session',
      description: 'extraction source',
    };
    nodes.set(normalizeName(opts.sourceName), srcNode);
    for (const n of [...nodes.values()].slice(0, 30)) {
      if (n.name !== opts.sourceName)
        edges.push({
          source: n.name,
          target: opts.sourceName,
          relation: 'mentioned_in',
          sourceType: n.type,
          targetType: 'Session',
        });
    }
  }

  return { nodes: [...nodes.values()].slice(0, 100), edges: edges.slice(0, 200) };
}
