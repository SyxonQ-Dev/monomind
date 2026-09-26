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

import type { KgEdgeInput, KgNodeInput } from './memory-kg-model.js';
import { normalizeName } from './memory-kg-model.js';

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
export type { ConsolidationCandidate, KgPromoteResult } from './memory-kg-promote.js';
export { kgConsolidateCandidates, kgPromote, kgStats } from './memory-kg-promote.js';
export type { KgIntegrityResult, KgRebuildResult } from './memory-kg-rebuild.js';
export { kgIntegrityCheck, kgRebuildIndex } from './memory-kg-rebuild.js';
export { kgRollback } from './memory-kg-rollback.js';
export type { RuleVerdict } from './memory-kg-rules.js';
export { kgIngestRules, kgListRules } from './memory-kg-rules.js';
export type { KgReferenceEdge } from './memory-kg-scan.js';
export { kgReferenceEdges } from './memory-kg-scan.js';
export type { KgSearchResult } from './memory-kg-search.js';
export { kgGlossary, kgSearch } from './memory-kg-search.js';

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
