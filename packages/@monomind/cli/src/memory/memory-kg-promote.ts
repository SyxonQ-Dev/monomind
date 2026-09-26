/**
 * Memory Knowledge Graph — graph maintenance reads and moves: kgPromote
 * (org-owned → project-shared, explicit), consolidation candidates, and
 * kgStats. Split out of memory-kg.ts, which re-exports the public symbols.
 */

import { bridgeCountEntries } from './memory-bridge.js';
import { kgIngest } from './memory-kg-ingest.js';
import type { KgEdgeInput, KgIngestResult, KgNodeInput, KgScope } from './memory-kg-model.js';
import {
  kgNamespaces,
  kgQualifyOrigin,
  MAX_DESC_LEN,
  MAX_EDGES_PER_CALL,
  MAX_NODES_PER_CALL,
  MAX_RULES_PER_CALL,
} from './memory-kg-model.js';
import { kgIngestRules } from './memory-kg-rules.js';
import { collectByOrigin, FailureLog, scanNamespace } from './memory-kg-scan.js';

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
