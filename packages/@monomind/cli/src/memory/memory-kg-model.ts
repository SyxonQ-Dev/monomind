/**
 * Memory Knowledge Graph — namespaces, limits, identity (entity/edge/rule
 * keys), the ingest input/result types, and scope (org ownership). Split out
 * of memory-kg.ts, which re-exports the public symbols; see that module's
 * header for the design.
 */

import { createHash } from 'node:crypto';

export const KG_NODES_NS = 'kg:nodes';
export const KG_EDGES_NS = 'kg:edges';
export const RULES_NS = 'rules';
/** Name → entity index. Index rows are NOT claims, so they live outside the
 *  three claim namespaces: putting them in `kg:nodes` would make them seed
 *  candidates for `kgSearch` and rows in `kgStats`. */
export const KG_NAMES_NS = 'kg:names';
/** Derived adjacency index namespace (K7). See `KgNamespaces.adj`. */
export const KG_ADJ_NS = 'kg:adj';
/** Derived origin-support index namespace (K7). See `KgNamespaces.originIdx`. */
export const KG_ORIGIN_IDX_NS = 'kg:origin-idx';
/** Derived-index status namespace (K7). See `KgNamespaces.indexStatus`. */
export const KG_INDEX_STATUS_NS = 'kg:index-status';

const MAX_NAME_LEN = 200;
export const MAX_DESC_LEN = 2000;

/** Nodes/edges/rules accepted per call. Overflow is REPORTED, never sliced away
 *  in silence — see `KgIngestResult.nodesTruncated`. */
export const MAX_NODES_PER_CALL = 500;
export const MAX_EDGES_PER_CALL = 1000;
export const MAX_RULES_PER_CALL = 50;

/** Per-origin description contributions retained on one element.
 *
 *  A cap has to exist — the bridge caps a stored value, and an element asserted
 *  by ten thousand runs would otherwise stop being writable. What must NOT
 *  happen is the old `origin_refs.slice(-100)`, which dropped the oldest
 *  provenance and left the entry claiming complete history. Past this cap the
 *  oldest contributions are dropped AND the entry records `origins_dropped`
 *  with `provenance_complete: false`, so a reader can tell that a rollback of an
 *  old origin may find nothing to withdraw. */
export const MAX_CLAIMS = 200;

// ── Identity ────────────────────────────────────────────────────────

/**
 * Version of the identity scheme implemented by `entityId`/`edgeKey`/`ruleKey`.
 *
 * Bump when a derivation changes. Entries written under an older scheme are not
 * orphaned: resolution probes the previous key shape and adopts the row in
 * place (see `resolveEntity`), so a bump costs a second keyed lookup on the
 * miss path rather than a migration.
 *
 * Version 1 was the name-only scheme (`n:<normalized-name>`, truncated to 200
 * characters), under which `Person:Alex` and `Service:Alex` were one entity and
 * two names first differing at character 250 were one entity.
 */
export const KG_ID_VERSION = 2;

/** Identity-grade name normalization: the same folding as `normalizeName` but
 *  WITHOUT its 200-character truncation, which silently merged long names that
 *  differ only past the cut. `normalizeName` keeps truncating because it feeds
 *  tags and display, where length matters and collisions do not. */
export function canonicalName(name: string): string {
  return String(name).trim().toLowerCase().replace(/['’]/g, '').replace(/\s+/g, '_');
}

/** Types that assert nothing. A generic label must not fork an entity away from
 *  its typed self, so it maps to the empty discriminator and is resolved by
 *  name (see `resolveEntity`). */
const GENERIC_TYPES = new Set(['', 'entity', 'unknown']);

/** The identity-bearing part of a type: '' when the caller told us nothing. */
export function typeBucket(type: string | undefined): string {
  const t = canonicalName(type ?? '');
  return GENERIC_TYPES.has(t) ? '' : t;
}

/** Hash a tuple injectively: every component is length-prefixed, so no
 *  component's content can masquerade as a delimiter or bleed into its
 *  neighbour, and no two distinct tuples share an input string. Same discipline
 *  as monograph's `symbolId`/`fileId` (packages/@monomind/monograph/src/types.ts),
 *  and adopted here for the same reason — the previous scheme lost distinctions
 *  to truncation and to an unescaped separator. */
export function hashTuple(components: string[]): string {
  const canonical = components.map((c) => `${Buffer.byteLength(c, 'utf8')}:${c}`).join('');
  return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 32);
}

/** Mint an entity id from the full identity tuple.
 *
 *  This MINTS; it does not RESOLVE. A caller that computes an id and writes to
 *  it bypasses the name index and re-forks the entities the index exists to
 *  keep together — every ingest path goes through `resolveEntity` instead. */
export function nodeKey(type: string, name: string): string {
  return `n:${hashTuple([String(KG_ID_VERSION), typeBucket(type), canonicalName(name)])}`;
}

/** The pre-`KG_ID_VERSION` key for a name: name-only, truncated at 200. Probed
 *  on a miss so existing graphs keep working without being re-keyed. */
export function legacyNodeKey(name: string): string {
  return `n:${normalizeName(name)}`;
}

export interface KgNodeInput {
  name: string;
  /** Basic type, cognee-style ("Person", "Tool", "Service") — not over-specific. */
  type?: string;
  description?: string;
  nodeSet?: string;
}
export interface KgEdgeInput {
  source: string;
  target: string;
  /** snake_case relation name. */
  relation: string;
  /** One-sentence concrete fact using the endpoint names. */
  description?: string;
  sourceType?: string;
  targetType?: string;
}

export interface KgIngestResult {
  success: boolean;
  nodesAdded: number;
  nodesMerged: number;
  edgesAdded: number;
  edgesMerged: number;
  /** Writes the bridge refused, one message each (capped at MAX_FAILURES).
   *  Non-empty ⇒ `success` is false and the counters describe only what
   *  actually persisted. */
  failures?: string[];
  error?: string;
  /** Items the payload asked for that this call refused. Present only when
   *  non-zero, so a caller who sent a clean payload sees a clean result. */
  nodesRejected?: number;
  edgesRejected?: number;
  /** Items dropped because the payload exceeded the per-call cap. The cap has
   *  not changed; what has changed is that it is now REPORTED instead of being
   *  a silent `.slice()`. */
  nodesTruncated?: number;
  edgesTruncated?: number;
  /** Why items were rejected, one message each (capped at MAX_FAILURES). */
  rejections?: string[];
  /** Endpoint entities created because an edge named them and they did not
   *  exist. Edge-only ingestion used to succeed with zero nodes and one edge,
   *  leaving a fact unreachable through both of its own endpoints. */
  placeholders?: number;
  /** Same-name entities this call did NOT merge with, one message each. A
   *  same-name match is a CANDIDATE, not a merge. */
  ambiguities?: string[];
  /** Elements whose support ledger hit `MAX_CLAIMS` on this call, so their
   *  oldest provenance was dropped. Never silent. */
  provenanceTruncated?: number;
}

/** cognee DataPoint normalization: lowercase, spaces→_, strip apostrophes. */
export function normalizeName(name: string): string {
  return String(name)
    .trim()
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/\s+/g, '_')
    .slice(0, MAX_NAME_LEN);
}

/** Edge identity: the endpoint IDs (already collision-free) plus the relation,
 *  hashed injectively so a relation containing the old `|` separator can no
 *  longer forge a different edge's key. */
export function edgeKey(srcKey: string, relation: string, dstKey: string): string {
  return `e:${hashTuple([String(KG_ID_VERSION), srcKey, canonicalName(relation), dstKey])}`;
}

/** The pre-`KG_ID_VERSION` edge key, for the same in-place adoption as
 *  `legacyNodeKey`. Composed from the RESOLVED endpoint keys, so it names the
 *  legacy edge exactly when both endpoints are themselves legacy rows. */
export function legacyEdgeKey(srcKey: string, relation: string, dstKey: string): string {
  return `e:${srcKey}|${normalizeName(relation)}|${dstKey}`;
}

/** Rule identity: the full rule text. The old key truncated the normalized rule
 *  at 120 characters, so two rules sharing a long preamble were one rule. */
export function ruleKey(rule: string): string {
  return `rule:${hashTuple([String(KG_ID_VERSION), canonicalName(rule)])}`;
}

export function legacyRuleKey(rule: string): string {
  return `rule:${normalizeName(rule).slice(0, 120)}`;
}

// ── Scope (org ownership) ───────────────────────────────────────────

/** Who owns a set of graph facts. `org` absent = project-shared knowledge. */
export interface KgScope {
  org?: string;
}

export interface KgNamespaces {
  nodes: string;
  edges: string;
  rules: string;
  /** Name → entity index backing `resolveEntity`. Holds no claims. */
  names: string;
  /** Derived adjacency index: entity id -> edge keys touching it (K7). Holds
   *  no claims either — every entry is rebuildable from `edges`. */
  adj: string;
  /** Derived origin-support index: origin ref -> {ns,key} refs it supports,
   *  across nodes/edges/rules (K7). Rebuildable from all three. */
  originIdx: string;
  /** This scope's derived-index build/readiness state (K7). One row. */
  indexStatus: string;
}

/** The namespaces a scope owns. Every read and write in this module resolves
 *  through here, which is what makes ownership enforced rather than advisory:
 *  there is no code path that reaches an org's facts without naming that org,
 *  and none that reaches every org at once. */
export function kgNamespaces(scope?: KgScope): KgNamespaces {
  const org = scope?.org?.trim();
  if (!org)
    return {
      nodes: KG_NODES_NS,
      edges: KG_EDGES_NS,
      rules: RULES_NS,
      names: KG_NAMES_NS,
      adj: KG_ADJ_NS,
      originIdx: KG_ORIGIN_IDX_NS,
      indexStatus: KG_INDEX_STATUS_NS,
    };
  const suffix = `:org:${normalizeName(org)}`;
  return {
    nodes: KG_NODES_NS + suffix,
    edges: KG_EDGES_NS + suffix,
    rules: RULES_NS + suffix,
    names: KG_NAMES_NS + suffix,
    adj: KG_ADJ_NS + suffix,
    originIdx: KG_ORIGIN_IDX_NS + suffix,
    indexStatus: KG_INDEX_STATUS_NS + suffix,
  };
}

/** Stamp the asserting org onto a provenance ref, so a claim's origin says WHO
 *  asserted it and not merely which run id — `run:m4x2` alone is ambiguous
 *  across orgs, and a promoted claim in the shared graph would otherwise carry
 *  an origin no one owns.
 *
 *  Applied by the ingest/rollback entry points rather than by callers: a
 *  caller that forgets is exactly how ownership stopped being enforced. */
export function kgQualifyOrigin(originRef: string, scope?: KgScope): string {
  const org = scope?.org?.trim();
  return org ? `org:${normalizeName(org)}/${originRef}` : originRef;
}
