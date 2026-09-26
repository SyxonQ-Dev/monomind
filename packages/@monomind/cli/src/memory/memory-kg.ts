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

import {
  bridgeCountEntries,
  bridgeDeleteEntry,
  bridgeGetEntry,
  bridgeListEntries,
  bridgeSearchEntries,
  bridgeStoreEntry,
} from './memory-bridge.js';
import type { DerivedClaims, KgExtractionMethod } from './memory-kg-claims.js';
import { applyClaim, withoutOrigin } from './memory-kg-claims.js';
import type {
  KgEdgeInput,
  KgIngestResult,
  KgNamespaces,
  KgNodeInput,
  KgScope,
} from './memory-kg-model.js';
import {
  canonicalName,
  edgeKey,
  KG_ID_VERSION,
  kgNamespaces,
  kgQualifyOrigin,
  legacyEdgeKey,
  legacyRuleKey,
  MAX_DESC_LEN,
  MAX_EDGES_PER_CALL,
  MAX_NODES_PER_CALL,
  MAX_RULES_PER_CALL,
  normalizeName,
  ruleKey,
  typeBucket,
} from './memory-kg-model.js';
import type { KgNameCandidate } from './memory-kg-names.js';
import { readNameIndex, resolveEntity, writeNameIndex } from './memory-kg-names.js';
import type { KgReferenceEdge, ScannedEntry } from './memory-kg-scan.js';
import {
  clearNamespace,
  collectByOrigin,
  FailureLog,
  kgReferenceEdges,
  MAX_FAILURES,
  originsOf,
  SCAN_PAGE,
  SEARCH_EDGE_SCAN_MAX,
  scanNamespace,
  withCasRetry,
} from './memory-kg-scan.js';

export type { KgClaim, KgExtractionMethod } from './memory-kg-claims.js';
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
export type { KgReferenceEdge } from './memory-kg-scan.js';
export { kgReferenceEdges } from './memory-kg-scan.js';

// ── Ingest ──────────────────────────────────────────────────────────

/** Merge extracted nodes/edges into the KG.
 *
 *  Identity is the (type, name) tuple resolved through the name index, so an
 *  entity is idempotent under re-extraction but two different things sharing a
 *  name stay two things. Each write adds this origin's CONTRIBUTION to the
 *  element's claim ledger, from which the description and `origin_refs` are
 *  derived — which is what lets a later ingest correct an earlier one and lets
 *  rollback put the earlier one back.
 *
 *  The COMPLETE payload is validated before anything is written, and every edge
 *  endpoint is made to exist (as a placeholder entity when the caller named one
 *  that does not) before the edge lands. An edge whose endpoint could not be
 *  created is rejected rather than written: retrieval is seeded from nodes, so
 *  an edge with a missing endpoint is a fact that cannot be found through
 *  either of the things it is about.
 *
 *  NOT ATOMIC — the memory bridge has no transaction primitive, so a failure
 *  part-way through leaves earlier writes persisted. The counters therefore
 *  report only what actually landed, `failures` lists what did not, and
 *  `success` is false whenever anything was refused. A partial ingest is safe
 *  to retry: every write is a keyed upsert. */
export async function kgIngest(options: {
  nodes: KgNodeInput[];
  edges?: KgEdgeInput[];
  /** Provenance: run id, session id, or doc hash this extraction came from.
   *  Stored qualified by `scope` — see `kgQualifyOrigin`. */
  originRef: string;
  /** Owner of these facts. Omit for project-shared knowledge. */
  scope?: KgScope;
  /** How this payload was produced. Defaults to `asserted`; `heuristicExtract`
   *  callers must pass `heuristic` so a co-occurrence guess is not stored as a
   *  stated fact. Recorded per origin, so the same element can hold a heuristic
   *  claim from one run and an asserted one from another. */
  method?: KgExtractionMethod;
  dbPath?: string;
}): Promise<KgIngestResult> {
  const { dbPath } = options;
  const method = options.method ?? 'asserted';
  const ns = kgNamespaces(options.scope);
  const originRef = kgQualifyOrigin(options.originRef, options.scope);
  const failures = new FailureLog();
  const report = new IngestReport();
  let nodesAdded = 0,
    nodesMerged = 0,
    edgesAdded = 0,
    edgesMerged = 0;

  try {
    // ── Validate the COMPLETE payload before mutating anything ──
    // An invalid item that surfaces halfway through leaves the graph holding
    // part of a payload the caller was told was rejected.
    const allNodes = options.nodes ?? [];
    const allEdges = options.edges ?? [];
    const nodes = allNodes.slice(0, MAX_NODES_PER_CALL);
    const edges = allEdges.slice(0, MAX_EDGES_PER_CALL);
    report.nodesTruncated = allNodes.length - nodes.length;
    report.edgesTruncated = allEdges.length - edges.length;

    const validNodes: { input: KgNodeInput; type: string; desc: string }[] = [];
    nodes.forEach((n, i) => {
      if (!n?.name?.trim()) return report.rejectNode(`node[${i}]: missing name`);
      validNodes.push({
        input: n,
        type: n.type?.trim() || 'entity',
        desc: (n.description ?? '').slice(0, MAX_DESC_LEN),
      });
    });
    const validEdges: KgEdgeInput[] = [];
    edges.forEach((e, i) => {
      const missing = !e?.source?.trim()
        ? 'source'
        : !e?.target?.trim()
          ? 'target'
          : !e?.relation?.trim()
            ? 'relation'
            : '';
      if (missing) return report.rejectEdge(`edge[${i}]: missing ${missing}`);
      validEdges.push(e);
    });

    /** Entity IDs this call has already resolved AND confirmed to exist, so an
     *  edge does not re-resolve an endpoint the node loop just wrote. */
    const resolved = new Map<string, string>();
    // Length-prefix the type so the split point is unambiguous regardless of
    // what characters `name` contains (it can hold arbitrary text, including
    // whatever separator a naive join might pick) — same discipline
    // hashTuple() above uses for the same reason. A bare `\0`-joined string
    // here was written as an actual NUL byte, not the literal two-character
    // escape text, which is harmless at runtime (this key is an in-memory
    // Map key only, never persisted) but made git treat this file as binary.
    const memoKey = (name: string, type: string) => {
      const t = typeBucket(type);
      return `${t.length}:${t}${canonicalName(name)}`;
    };

    for (const { input: n, type, desc } of validNodes) {
      const target = await resolveEntity(n.name, type, ns, dbPath);
      if (!target) {
        failures.note(`node ${n.name}: name index unreadable`);
        continue;
      }
      report.noteAmbiguity(n.name, target.candidates);
      const wrote = await writeEntity({
        id: target.id,
        name: n.name,
        type,
        description: desc,
        nodeSet: n.nodeSet,
        originRef,
        method,
        ns,
        dbPath,
        failures,
        report,
      });
      if (wrote === null) continue;
      if (wrote) nodesAdded++;
      else nodesMerged++;
      resolved.set(memoKey(n.name, type), target.id);
      if (target.index) await writeNameIndex(n.name, target.index, ns, dbPath, failures);
      await onEntrySupported(ns, ns.nodes, target.id, originRef, dbPath);
    }

    /** Resolve an edge endpoint, creating an explicit placeholder entity when
     *  the caller named something that does not exist. Returns null when the
     *  endpoint could not be made to exist — the edge is then rejected rather
     *  than written without it. */
    const endpoint = async (name: string, type: string | undefined): Promise<string | null> => {
      const memo = memoKey(name, type ?? 'entity');
      const hit = resolved.get(memo);
      if (hit) return hit;
      const target = await resolveEntity(name, type ?? 'entity', ns, dbPath);
      if (!target) {
        failures.note(`endpoint ${name}: name index unreadable`);
        return null;
      }
      report.noteAmbiguity(name, target.candidates);
      // Always write: naming an endpoint IS an assertion that it exists, so
      // this origin joins the entity's support either way. A write that CREATES
      // the entity is the placeholder case worth reporting.
      const wrote = await writeEntity({
        id: target.id,
        name,
        type: type ?? 'entity',
        description: '',
        placeholder: true,
        originRef,
        method,
        ns,
        dbPath,
        failures,
        report,
      });
      if (wrote === null) return null;
      if (wrote) report.placeholders++;
      if (target.index) await writeNameIndex(name, target.index, ns, dbPath, failures);
      resolved.set(memo, target.id);
      await onEntrySupported(ns, ns.nodes, target.id, originRef, dbPath);
      return target.id;
    };

    for (const e of validEdges) {
      const srcKey = await endpoint(e.source, e.sourceType);
      const dstKey = await endpoint(e.target, e.targetType);
      if (!srcKey || !dstKey) {
        report.rejectEdge(`edge ${e.source}-${e.relation}->${e.target}: endpoint not persisted`);
        continue;
      }
      const desc = (e.description ?? '').slice(0, MAX_DESC_LEN);
      const fallbackFact = `${e.source} ${e.relation} ${e.target}`;

      // New key first, then the pre-KG_ID_VERSION shape: a legacy edge between
      // two adopted legacy endpoints keeps its own key rather than being
      // duplicated under a new one. Resolved once — a CAS retry re-reads this
      // same key, it does not re-run legacy resolution.
      let key = edgeKey(srcKey, e.relation, dstKey);
      const probe = await bridgeGetEntry({ key, namespace: ns.edges, dbPath });
      if (!probe?.found) {
        const legacy = legacyEdgeKey(srcKey, e.relation, dstKey);
        const hit = await bridgeGetEntry({ key: legacy, namespace: ns.edges, dbPath });
        if (hit?.found && hit.entry) key = legacy;
      }

      // Re-read and re-merge on every CAS attempt (see withCasRetry): a stale
      // `md`/`derived` retried against a fresh row would silently re-lose
      // whatever a concurrent writer just added (K5).
      let md: Record<string, unknown> = {};
      let derived!: DerivedClaims;
      let isNew = false;
      const res = await withCasRetry(async () => {
        const existing = await bridgeGetEntry({ key, namespace: ns.edges, dbPath });
        isNew = !(existing?.found && existing.entry);
        md = (existing?.entry?.metadata ?? {}) as Record<string, unknown>;
        derived = applyClaim(md, originRef, desc, Date.now(), method);
        const ver = existing?.entry?.version;

        return bridgeStoreEntry({
          key,
          value: derived.description || fallbackFact,
          namespace: ns.edges,
          dbPath,
          upsert: true,
          generateEmbeddingFlag: false,
          tags: ['kg', normalizeName(e.relation)],
          metadata: {
            ...md,
            kg: 'edge',
            id_version: KG_ID_VERSION,
            src: srcKey,
            dst: dstKey,
            relation: normalizeName(e.relation),
            source_name: e.source,
            target_name: e.target,
            ...derived,
            valid_from: md.valid_from ?? Date.now(),
            valid_to: null,
          },
          ifVersion: isNew ? 'absent' : typeof ver === 'number' ? ver : undefined,
        });
      });
      if (failures.add(res, `edge ${key}`)) continue;
      report.noteProvenanceLoss(md, derived);
      if (isNew) edgesAdded++;
      else edgesMerged++;
      await onEntrySupported(ns, ns.edges, key, originRef, dbPath);
      if (isNew) await onEdgeWritten(ns, key, srcKey, dstKey, dbPath);
    }

    return {
      success: !failures.failed,
      nodesAdded,
      nodesMerged,
      edgesAdded,
      edgesMerged,
      ...(failures.failed ? { failures: failures.messages, error: failures.summary() } : {}),
      ...report.fields(),
    };
  } catch (err) {
    return {
      success: false,
      nodesAdded,
      nodesMerged,
      edgesAdded,
      edgesMerged,
      ...(failures.messages.length ? { failures: failures.messages } : {}),
      ...report.fields(),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Write one entity's claim contribution.
 *
 *  @returns true when the entity was created, false when an existing one was
 *  merged into, and null when the bridge refused the write (the caller must not
 *  count it, and must not treat the entity as existing). */
async function writeEntity(o: {
  id: string;
  name: string;
  type: string;
  description: string;
  nodeSet?: string;
  placeholder?: boolean;
  originRef: string;
  method: KgExtractionMethod;
  ns: KgNamespaces;
  dbPath: string | undefined;
  failures: FailureLog;
  report: IngestReport;
}): Promise<boolean | null> {
  // Re-read and re-merge on every CAS attempt (see withCasRetry) rather than
  // once up front: a stale `md`/`derived` retried against a fresh row would
  // silently re-lose whatever a concurrent writer just added (K5).
  let md: Record<string, unknown> = {};
  let derived!: DerivedClaims;
  let isNew = false;
  const res = await withCasRetry(async () => {
    const existing = await bridgeGetEntry({ key: o.id, namespace: o.ns.nodes, dbPath: o.dbPath });
    isNew = !(existing?.found && existing.entry);
    md = (existing?.entry?.metadata ?? {}) as Record<string, unknown>;
    derived = applyClaim(md, o.originRef, o.description, Date.now(), o.method);

    // Keep the most specific type: a generic heuristic 'entity' never
    // overwrites an LLM-assigned one, and a specific one promotes an untyped
    // entity.
    const prevType = typeof md.type === 'string' ? md.type : '';
    const bestType = typeBucket(prevType) ? prevType : o.type;
    const nodeSet = o.nodeSet ?? (typeof md.node_set === 'string' ? md.node_set : null);
    const ver = existing?.entry?.version;

    return bridgeStoreEntry({
      key: o.id,
      value: `${o.name} — ${derived.description || bestType}`,
      namespace: o.ns.nodes,
      dbPath: o.dbPath,
      upsert: true,
      tags: ['kg', normalizeName(bestType), ...(nodeSet ? [normalizeName(nodeSet)] : [])],
      metadata: {
        ...md,
        kg: 'node',
        id_version: KG_ID_VERSION,
        type: bestType,
        name: o.name,
        node_set: nodeSet,
        ...derived,
        // A placeholder stops being one the moment a real assertion describes it.
        placeholder: o.placeholder === true && !derived.description ? true : undefined,
        version: (typeof md.version === 'number' ? md.version : 0) + 1,
        valid_from: md.valid_from ?? Date.now(),
        valid_to: null,
      },
      // isNew ⇒ this row must not already exist; otherwise it must still be at
      // the version we just read. Absent when the loaded backend/test double
      // does not report a version, so behaviour is unchanged there (see
      // bridgeGetEntry's `version` field).
      ifVersion: isNew ? 'absent' : typeof ver === 'number' ? ver : undefined,
    });
  });
  // Name first: the ID is a digest, and a failure message a human cannot map
  // back to the thing that failed is not a diagnosis.
  if (o.failures.add(res, `node ${o.name} (${o.id})`)) return null;
  // Only after the write landed: a refused write dropped no provenance, because
  // it changed nothing.
  o.report.noteProvenanceLoss(md, derived);
  return isNew;
}

/** The accepted/rejected/truncated bookkeeping a caller needs in order to know
 *  that what it sent is what the graph holds. */
class IngestReport {
  nodesRejected = 0;
  edgesRejected = 0;
  nodesTruncated = 0;
  edgesTruncated = 0;
  placeholders = 0;
  provenanceTruncated = 0;
  readonly rejections: string[] = [];
  readonly ambiguities: string[] = [];

  rejectNode(message: string): void {
    this.nodesRejected++;
    if (this.rejections.length < MAX_FAILURES) this.rejections.push(message);
  }

  rejectEdge(message: string): void {
    this.edgesRejected++;
    if (this.rejections.length < MAX_FAILURES) this.rejections.push(message);
  }

  noteAmbiguity(name: string, candidates: KgNameCandidate[]): void {
    if (!candidates.length || this.ambiguities.length >= MAX_FAILURES) return;
    const types = candidates.map((c) => c.type || 'untyped').join(', ');
    this.ambiguities.push(`${name}: kept separate from ${candidates.length} same-name (${types})`);
  }

  noteProvenanceLoss(md: Record<string, unknown>, derived: DerivedClaims): void {
    const before = typeof md.origins_dropped === 'number' ? md.origins_dropped : 0;
    if (derived.origins_dropped > before) this.provenanceTruncated++;
  }

  /** Only non-zero counters are emitted, so a clean payload yields a clean
   *  result and the existing `KgIngestResult` shape is unchanged for callers
   *  that construct it themselves. */
  fields(): Partial<KgIngestResult> {
    return {
      ...(this.nodesRejected ? { nodesRejected: this.nodesRejected } : {}),
      ...(this.edgesRejected ? { edgesRejected: this.edgesRejected } : {}),
      ...(this.nodesTruncated ? { nodesTruncated: this.nodesTruncated } : {}),
      ...(this.edgesTruncated ? { edgesTruncated: this.edgesTruncated } : {}),
      ...(this.rejections.length ? { rejections: this.rejections } : {}),
      ...(this.placeholders ? { placeholders: this.placeholders } : {}),
      ...(this.ambiguities.length ? { ambiguities: this.ambiguities } : {}),
      ...(this.provenanceTruncated ? { provenanceTruncated: this.provenanceTruncated } : {}),
    };
  }
}

// ── Rules (two-stage distillation support) ──────────────────────────

export interface RuleVerdict {
  rule: string;
  /** `failed` — the candidate was fine, but a write the caller was told about
   *  did not land. It is neither `invalid` (which blames the caller's input)
   *  nor `accepted`/`already_known` (which claim the graph now holds it). Both
   *  of those used to be reported unconditionally, so a caller reading verdicts
   *  saw every rule land while the aggregate `accepted` count said zero. */
  verdict: 'accepted' | 'already_known' | 'invalid' | 'failed';
  similarTo?: string;
}

/** Stage-2 of cognee's curator/writer distillation: the CALLER (an LLM agent)
 *  proposes candidate rules; this accepts each unless a semantically
 *  near-identical rule exists (embedding dedup — deterministic keys can't
 *  collapse paraphrases). Accepted rules are stored both as KG nodes
 *  (node_set=rules) and as plain `rules`-namespace entries so the existing
 *  injection/search surfaces pick them up with zero new plumbing.
 *
 *  A candidate that dedups against an existing rule still ADDS its origin to
 *  that rule's support set: two independent runs asserting the same rule mean
 *  the rule survives either one being rolled back. Dropping the second origin
 *  (as this used to) made rollback of the FIRST run delete knowledge the
 *  second run independently vouched for.
 *
 *  Like `kgIngest`, NOT atomic — see that function's note. */
export async function kgIngestRules(options: {
  rules: { rule: string; context?: string }[];
  originRef: string;
  /** Owner of these rules. Omit for project-shared knowledge. */
  scope?: KgScope;
  dbPath?: string;
  /** Similarity above which a candidate is already_known (default 0.78 —
   *  MiniLM paraphrases of the same rule commonly land 0.78-0.9; cognee's
   *  equivalent control is prompt-injected LLM judgment, which we approximate). */
  dedupThreshold?: number;
}): Promise<{
  success: boolean;
  verdicts: RuleVerdict[];
  accepted: number;
  failures?: string[];
  error?: string;
  /** Candidates dropped by the per-call cap, reported rather than sliced away
   *  in silence. */
  rulesTruncated?: number;
}> {
  const verdicts: RuleVerdict[] = [];
  const threshold = options.dedupThreshold ?? 0.78;
  const failures = new FailureLog();
  const ns = kgNamespaces(options.scope);
  // Direct writes here store the qualified ref; nested kgIngest calls get the
  // RAW ref plus the scope and qualify it themselves, so it is stamped once.
  const originRef = kgQualifyOrigin(options.originRef, options.scope);
  let accepted = 0;
  const all = options.rules ?? [];
  const batch = all.slice(0, MAX_RULES_PER_CALL);
  const rulesTruncated = all.length - batch.length;

  try {
    for (const r of batch) {
      const rule = r?.rule?.trim();
      if (!rule || rule.length < 8) {
        verdicts.push({ rule: r?.rule ?? '', verdict: 'invalid' });
        continue;
      }

      const similar = await bridgeSearchEntries({
        query: rule,
        namespace: ns.rules,
        limit: 1,
        threshold,
        dbPath: options.dbPath,
      });
      const top = similar?.results?.[0];
      // Issue #111: FTS5 keyword scores are min-max normalized per batch.
      // With limit:1, the sole result always scores 1.0 — any rule sharing
      // even one keyword was falsely marked as a duplicate.
      //
      // Only trust embedding-backed (semantic) cosine scores for dedup.
      // Keyword-only matches can't distinguish paraphrases from merely
      // overlapping vocabulary — fall back to exact-text comparison.
      // (Key-based upsert on store already handles identical keys.)
      const provenance = top?.provenance;
      let isDuplicate = false;
      if (top && provenance?.startsWith('semantic:')) {
        const rawCosine = parseFloat(provenance.slice('semantic:'.length));
        isDuplicate = rawCosine >= threshold;
      } else if (top) {
        // Keyword-only: only suppress true near-exact duplicates.
        const existing = (top.content || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const candidate = rule.replace(/\s+/g, ' ').trim().toLowerCase();
        isDuplicate = existing === candidate;
      }
      if (isDuplicate && top?.key) {
        // `already_known` is a claim that this origin now supports the existing
        // rule. If reinforcement did not land, it does not — and a later
        // rollback of the OTHER origin would delete a rule this run believes it
        // vouched for.
        const reinforced = await reinforceRuleOrigin(
          top.key,
          top.content,
          options.originRef,
          options.scope,
          options.dbPath,
          failures,
        );
        verdicts.push({
          rule,
          verdict: reinforced ? 'already_known' : 'failed',
          similarTo: top.key,
        });
        continue;
      }

      // Identity is the full rule text. The old key truncated at 120 normalized
      // characters, so two rules sharing a long preamble were the same rule.
      // A rule stored under that scheme is adopted in place rather than
      // duplicated under the new key.
      let key = ruleKey(rule);
      let priorMd: Record<string, unknown> = {};
      const current = await bridgeGetEntry({ key, namespace: ns.rules, dbPath: options.dbPath });
      if (current?.found && current.entry) priorMd = current.entry.metadata as typeof priorMd;
      else {
        const legacy = legacyRuleKey(rule);
        const hit = await bridgeGetEntry({
          key: legacy,
          namespace: ns.rules,
          dbPath: options.dbPath,
        });
        if (hit?.found && hit.entry) {
          key = legacy;
          priorMd = hit.entry.metadata as typeof priorMd;
        }
      }
      // The mirrored KG node is named by the FULL rule text. Truncating it to
      // 200 characters put two rules sharing a long preamble on one node — the
      // same collision `ruleKey` was just widened to prevent, reintroduced one
      // namespace over.
      const ruleName = rule;
      const stored = await bridgeStoreEntry({
        key,
        value: rule + (r.context ? `\n(context: ${r.context.slice(0, 500)})` : ''),
        namespace: ns.rules,
        dbPath: options.dbPath,
        upsert: true,
        tags: ['rule'],
        metadata: {
          ...priorMd,
          ...applyClaim(priorMd, originRef, rule, Date.now()),
          id_version: KG_ID_VERSION,
          derived_from: originRef,
          // Lets the dedup path reinforce the matching KG node without having
          // to re-derive the node name from the stored value (which may carry
          // an appended context block).
          rule: ruleName,
        },
      });
      const nodeRes = await kgIngest({
        nodes: [{ name: ruleName, type: 'Rule', description: rule, nodeSet: 'rules' }],
        originRef: options.originRef,
        scope: options.scope,
        dbPath: options.dbPath,
      });
      const ruleFailed = failures.add(stored, `rule ${key}`);
      if (!ruleFailed) await onEntrySupported(ns, ns.rules, key, originRef, options.dbPath);
      if (nodeRes.failures?.length) for (const m of nodeRes.failures) failures.note(m);
      // Only count a rule as accepted when BOTH of its writes landed; a rule
      // present in one namespace only is not the state the caller was told
      // about. The per-rule verdict now says the same thing — it read
      // `accepted` unconditionally, so the two halves of one result disagreed.
      const landed = !ruleFailed && nodeRes.success;
      if (landed) accepted++;
      verdicts.push({ rule, verdict: landed ? 'accepted' : 'failed' });
    }
    return {
      success: !failures.failed,
      verdicts,
      accepted,
      ...(failures.failed ? { failures: failures.messages, error: failures.summary() } : {}),
      ...(rulesTruncated ? { rulesTruncated } : {}),
    };
  } catch (err) {
    return {
      success: false,
      verdicts,
      accepted,
      ...(failures.messages.length ? { failures: failures.messages } : {}),
      ...(rulesTruncated ? { rulesTruncated } : {}),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Add `originRef` to an already-stored rule's support set — both the
 *  `rules`-namespace entry and its `node_set=rules` KG node. Idempotent in
 *  effect: re-asserting an origin the rule already carries leaves the support
 *  set unchanged.
 *
 *  @returns true when the rule genuinely carries this origin afterwards —
 *  including the no-op case where it already did. False means the support set
 *  is not what the caller is about to be told it is. */
async function reinforceRuleOrigin(
  matchedKey: string,
  matchedContent: string,
  /** RAW ref — qualified here for the rules entry, and passed on unqualified
   *  to `kgIngest`, which qualifies it once with the same scope. */
  originRef: string,
  scope: KgScope | undefined,
  dbPath: string | undefined,
  failures: FailureLog,
): Promise<boolean> {
  const ns = kgNamespaces(scope);
  const qualified = kgQualifyOrigin(originRef, scope);
  const existing = await bridgeGetEntry({ key: matchedKey, namespace: ns.rules, dbPath });
  if (!existing?.found || !existing.entry) {
    // The dedup hit came from search; if the entry can't be re-read by key the
    // support set cannot be updated, and silently proceeding is exactly the
    // provenance loss this function exists to prevent.
    failures.note(`rule ${matchedKey}: matched by dedup but not readable by key`);
    return false;
  }
  const entry = existing.entry;
  const md = entry.metadata as Record<string, unknown>;
  const origins = Array.isArray(md.origin_refs) ? (md.origin_refs as string[]) : [];
  // The KG node's name: recorded at accept time, else the first line of the
  // stored value (any context block is appended after a newline).
  const ruleName =
    typeof md.rule === 'string' && md.rule
      ? md.rule
      : (matchedContent || entry.content).split('\n')[0];

  // Both writes are attempted regardless: skipping the node write because the
  // entry write failed would leave the two halves disagreeing about who
  // supports this rule. Only the REPORT changes.
  let ok = true;
  if (!origins.includes(qualified)) {
    const res = await bridgeStoreEntry({
      key: entry.key,
      value: entry.content,
      namespace: ns.rules,
      dbPath,
      upsert: true,
      generateEmbeddingFlag: entry.hasEmbedding,
      tags: entry.tags,
      metadata: {
        ...md,
        rule: ruleName,
        // A dedup hit is SUPPORT, not a correction: the candidate asserts the
        // rule the entry already holds. Its contribution therefore carries no
        // description of its own — passing one here (the truncated `rule` name,
        // as this did) made the newest claim disagree with the stored text and
        // flagged the rule as conflicted with a truncation of itself.
        ...applyClaim(md, qualified, '', Date.now()),
      },
    });
    if (failures.add(res, `rule ${entry.key}`)) ok = false;
    else await onEntrySupported(ns, ns.rules, entry.key, qualified, dbPath);
  }

  // The rule's KG node needs the same origin — rollback walks nodes separately.
  const nodeRes = await kgIngest({
    nodes: [{ name: ruleName, type: 'Rule', description: '', nodeSet: 'rules' }],
    originRef,
    scope,
    dbPath,
  });
  if (nodeRes.failures?.length) for (const m of nodeRes.failures) failures.note(m);
  return ok && nodeRes.success;
}

/** List stored rules (for injection or review). */
export async function kgListRules(options?: {
  dbPath?: string;
  limit?: number;
  scope?: KgScope;
}): Promise<{ rule: string; key: string }[]> {
  const res = await bridgeListEntries({
    namespace: kgNamespaces(options?.scope).rules,
    limit: options?.limit ?? 50,
    dbPath: options?.dbPath,
  });
  return (res?.entries ?? []).map((e) => ({ rule: e.content, key: e.key }));
}

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

// ── Rollback (per-origin bad-ingest recovery) ───────────────────────

/** Withdraw `originRef`'s support from the graph: remove it from every
 *  node/edge/rule it backs, and delete the element once no origin remains.
 *
 *  The withdrawn ref is REWRITTEN out of the surviving elements' origin lists,
 *  not left behind. Retaining it (as this used to) meant a second rollback saw
 *  a two-entry list and retained again — so an element could outlive the
 *  withdrawal of every origin that ever supported it.
 *
 *  The scan is EXHAUSTIVE: it pages each namespace to the end rather than
 *  reading one capped list. A capped scan let an element past the cap keep a
 *  withdrawn origin while the caller was told the rollback succeeded.
 *
 *  Collect-then-mutate is deliberate: deleting a row pulls every later row back
 *  one position, so a delete inside the page loop would make an advancing
 *  offset skip whatever slid into the gap. (Rewrites are no longer a hazard —
 *  the bridge's upsert reuses the existing entry id and preserves `createdAt`
 *  rather than re-inserting at the head of the default ordering — but this
 *  function deletes as well as rewrites.) Only origin-carrying entries are
 *  retained during the scan, so memory tracks the rollback's own footprint, not
 *  the namespace size. */
export async function kgRollback(options: {
  originRef: string;
  /** Whose knowledge to withdraw from. A rollback can only reach the named
   *  scope's namespaces — an org's rollback is an ownership boundary, not just
   *  a label on the output. */
  scope?: KgScope;
  dbPath?: string;
}): Promise<{
  success: boolean;
  deleted: number;
  retained: number;
  failures?: string[];
  error?: string;
  /** Edges deleted because this rollback removed an endpoint they name. A
   *  relation between two things is not a fact once one of them is gone, and
   *  retrieval is node-seeded, so leaving them behind left unreachable rows
   *  claiming a graph that no longer exists. */
  danglingEdgesRemoved?: number;
}> {
  const failures = new FailureLog();
  const namespaces = kgNamespaces(options.scope);
  const originRef = kgQualifyOrigin(options.originRef, options.scope);
  let deleted = 0,
    retained = 0;
  /** Entity IDs this rollback removed, and the names that pointed at them. */
  const removedIds = new Set<string>();
  const removedNames = new Set<string>();
  try {
    // K7: one indexed read across all three namespaces, tried before the
    // exhaustive per-namespace scan. Only trusted when the scope's index is
    // `ready` AND every ref it names still resolves — `kgIndexedByOrigin`
    // returns null otherwise, and this falls straight back to the scan.
    let indexedByNs: Map<string, ScannedEntry[]> | null = null;
    if ((await readIndexStatus(namespaces, options.dbPath)).state === 'ready') {
      const indexed = await kgIndexedByOrigin(namespaces, originRef, options.dbPath);
      if (indexed !== null) {
        indexedByNs = new Map([
          [namespaces.nodes, []],
          [namespaces.edges, []],
          [namespaces.rules, []],
        ]);
        for (const { ns, entry } of indexed) indexedByNs.get(ns)?.push(entry);
      }
    }

    for (const ns of [namespaces.nodes, namespaces.edges, namespaces.rules]) {
      const found = indexedByNs
        ? { entries: indexedByNs.get(ns) ?? [], covered: true }
        : await collectByOrigin(ns, originRef, options.dbPath);
      // A partial scan cannot be reported as a completed withdrawal.
      if (!found.covered) {
        failures.note(`${ns}: memory backend unavailable`);
        continue;
      }
      const withdrawn = found.entries.map((e) => ({
        entry: e,
        // Re-derive from the claim ledger rather than editing an origin list:
        // this is what puts back the description a withdrawn origin overwrote.
        remaining: withoutOrigin((e.metadata ?? {}) as Record<string, unknown>, originRef),
      }));

      for (const { entry: e, remaining } of withdrawn) {
        const md = (e.metadata ?? {}) as Record<string, unknown>;

        if (remaining === null) {
          const del = await bridgeDeleteEntry({ id: e.id, namespace: ns, dbPath: options.dbPath });
          if (del?.deleted) {
            deleted++;
            await onOriginWithdrawn(namespaces, ns, e.key, originRef, options.dbPath);
            await onEntryDeleted(
              namespaces,
              e.key,
              options.dbPath,
              ns === namespaces.edges
                ? { src: String(md.src ?? ''), dst: String(md.dst ?? '') }
                : undefined,
            );
          } else failures.note(`${ns}/${e.key}: delete failed`);
          if (ns === namespaces.nodes && del?.deleted) {
            removedIds.add(e.key);
            if (typeof md.name === 'string') removedNames.add(md.name);
          }
          continue;
        }

        const store = await bridgeStoreEntry({
          key: e.key,
          value: rerender(e.content, md, remaining.description, ns === namespaces.rules),
          namespace: ns,
          dbPath: options.dbPath,
          upsert: true,
          // Edges are stored without embeddings; re-deriving one here would
          // silently change how the entry behaves in search.
          generateEmbeddingFlag: e.hasEmbedding,
          tags: e.tags,
          metadata: { ...md, ...remaining },
        });
        if (!failures.add(store, `${ns}/${e.key}: origin withdrawal`)) {
          retained++;
          await onOriginWithdrawn(namespaces, ns, e.key, originRef, options.dbPath);
        }
      }
    }

    // Drop the removed entities out of the name index, so a later ingest of the
    // same name does not resolve onto an entity that no longer exists.
    for (const name of removedNames) {
      const known = await readNameIndex(name, namespaces, options.dbPath);
      if (known === null) {
        // An unreadable index must not be rewritten from a guess — doing so
        // would erase every same-name entity this rollback did NOT remove.
        failures.note(`${namespaces.names}: name index unreadable for ${name}`);
        continue;
      }
      const survivors = known.filter((c) => !removedIds.has(c.id));
      if (survivors.length !== known.length)
        await writeNameIndex(name, survivors, namespaces, options.dbPath, failures);
    }

    const danglingEdgesRemoved = removedIds.size
      ? await removeEdgesMissingEndpoints(namespaces, removedIds, options.dbPath, failures)
      : 0;

    return {
      success: !failures.failed,
      deleted,
      retained,
      ...(failures.failed ? { failures: failures.messages, error: failures.summary() } : {}),
      ...(danglingEdgesRemoved ? { danglingEdgesRemoved } : {}),
    };
  } catch (err) {
    return {
      success: false,
      deleted,
      retained,
      ...(failures.messages.length ? { failures: failures.messages } : {}),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Re-render a stored value after its derived description changed.
 *
 *  Rules are left alone: their value is the rule text plus an optional context
 *  block, not a rendering of a description. */
function rerender(
  content: string,
  md: Record<string, unknown>,
  description: string,
  isRule: boolean,
): string {
  if (isRule || description === md.description) return content;
  if (md.kg === 'edge') return description || `${md.source_name} ${md.relation} ${md.target_name}`;
  return `${md.name} — ${description || md.type}`;
}

/** Delete every edge incident to one of `removedIds`. Collect-then-mutate for
 *  the same reason `kgRollback` does. */
async function removeEdgesMissingEndpoints(
  ns: KgNamespaces,
  removedIds: Set<string>,
  dbPath: string | undefined,
  failures: FailureLog,
): Promise<number> {
  const doomed: { entry: ScannedEntry; src: string; dst: string }[] = [];
  const covered = await scanNamespace(ns.edges, dbPath, (page) => {
    for (const e of page) {
      const md = (e.metadata ?? {}) as Record<string, unknown>;
      const src = String(md.src ?? '');
      const dst = String(md.dst ?? '');
      if (removedIds.has(src) || removedIds.has(dst)) doomed.push({ entry: e, src, dst });
    }
  });
  if (!covered) {
    failures.note(`${ns.edges}: memory backend unavailable during dangling-edge sweep`);
    return 0;
  }
  let removed = 0;
  for (const { entry: e, src, dst } of doomed) {
    const del = await bridgeDeleteEntry({ id: e.id, namespace: ns.edges, dbPath });
    if (del?.deleted) {
      removed++;
      // Only the surviving endpoint needs its adjacency entry pruned — the
      // removed one's own entry is moot, its entity is gone too.
      await onEntryDeleted(ns, e.key, dbPath, {
        src: removedIds.has(src) ? dst : src,
        dst: removedIds.has(src) ? dst : src,
      });
    } else failures.note(`${ns.edges}/${e.key}: dangling-edge delete failed`);
  }
  return removed;
}

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

// ── Derived index (K7): adjacency + origin-support, rebuildable ─────
//
// kgSearch's edge scan and kgRollback's origin scan read via an EXHAUSTIVE
// scan (`kgReferenceEdges`/`collectByOrigin`) because there is no legacy-key
// fallback probe for an arbitrary historical edge or origin, the way K4's
// identity migration has one for entity names (see the module header). An
// index built only from writes made after it exists would silently miss
// everything written before — a regression, not a fix.
//
// So this index is REBUILDABLE, not incrementally bootstrapped: `kgRebuildIndex`
// runs one full canonical scan (nodes, then edges, then rules) and writes
// every adjacency/origin-support entry from scratch, validates the result
// against the same reference reads this module already trusts, and only then
// flips the scope to `ready`. Both index namespaces hold REFERENCES (edge
// keys / {ns,key} pairs), never duplicated claim content — an edge's
// description or claims changing never desyncs the index; only a structural
// add/remove does, which the dual-write hooks below cover.
//
// `ready` is per SCOPE and per SCHEMA VERSION: a scope that has never been
// rebuilt, or was rebuilt under an older schema, reads exactly as it always
// has (the exhaustive scan) — this index degrades to a no-op, never to a
// silently incomplete answer. A dual-write hiccup downgrades the scope to
// `failed` rather than letting the index silently drift out of sync.

export type KgIndexState = 'absent' | 'building' | 'validating' | 'ready' | 'failed';

export interface KgIndexStatus {
  state: KgIndexState;
  schemaVersion: number;
  /** Resume point for an interrupted `kgRebuildIndex`. */
  cursor?: { phase: 'nodes' | 'edges' | 'rules'; offset: number };
  counts?: { nodes: number; edges: number; rules: number };
  startedAt?: number;
  updatedAt?: number;
  error?: string;
  /** Only meaningful when `state === 'failed'`. True for a build-phase
   *  failure (the backend went unavailable mid-scan, or a dual-write hook
   *  hit an error after `ready`): everything already written is still
   *  correct, just incomplete, so the next call RESUMES from `cursor`. False
   *  for a validation-phase failure (the built index disagreed with an
   *  independent reference read): something already written is wrong, not
   *  merely incomplete, so the next call restarts a fresh scan — resuming
   *  would re-derive the same mistake instead of correcting it. */
  resumable?: boolean;
}

const KG_INDEX_SCHEMA_VERSION = 1;
const INDEX_STATUS_KEY = 'status';
/** Edge keys recorded per adjacency entry before the index refuses to grow it
 *  further and fails the SCOPE's index rather than risk an oversized or
 *  silently truncated row. A hub node past this reads via the exhaustive
 *  scan, exactly as before the index existed — this only gates the fast
 *  path, never correctness. */
const MAX_ADJ_EDGES_PER_NODE = 2000;
/** Refs recorded per origin-support entry before the same refusal applies. */
const MAX_ORIGIN_INDEX_REFS = 5000;

async function readIndexStatus(
  ns: KgNamespaces,
  dbPath: string | undefined,
): Promise<KgIndexStatus> {
  const res = await bridgeGetEntry({ key: INDEX_STATUS_KEY, namespace: ns.indexStatus, dbPath });
  if (!res?.found || !res.entry) return { state: 'absent', schemaVersion: KG_INDEX_SCHEMA_VERSION };
  const md = (res.entry.metadata ?? {}) as Partial<KgIndexStatus>;
  // An older/foreign schema is not a resumable build — start over rather than
  // trust rows shaped by a version this code no longer understands.
  if (md.schemaVersion !== KG_INDEX_SCHEMA_VERSION) {
    return { state: 'absent', schemaVersion: KG_INDEX_SCHEMA_VERSION };
  }
  return { ...(md as KgIndexStatus), schemaVersion: KG_INDEX_SCHEMA_VERSION };
}

async function writeIndexStatus(
  ns: KgNamespaces,
  status: KgIndexStatus,
  dbPath: string | undefined,
): Promise<boolean> {
  const res = await bridgeStoreEntry({
    key: INDEX_STATUS_KEY,
    value: `kg index: ${status.state}`,
    namespace: ns.indexStatus,
    dbPath,
    upsert: true,
    generateEmbeddingFlag: false,
    metadata: { ...status, updatedAt: Date.now() },
  });
  return Boolean(res?.success);
}

/** Downgrade a scope's index to `failed` after a dual-write hiccup, so reads
 *  fall back to the exhaustive scan instead of silently drifting. Never
 *  throws — this runs from inside a best-effort maintenance path. */
async function markIndexFailed(
  ns: KgNamespaces,
  dbPath: string | undefined,
  error: string,
): Promise<void> {
  try {
    const current = await readIndexStatus(ns, dbPath);
    if (current.state === 'absent' || current.state === 'failed') return; // nothing to protect
    // Not resumable: the cursor here is stale (either a completed build's end
    // position, or mid-build), and a dual-write hiccup means something is
    // missing from an UNKNOWN part of the index — only a fresh rescan finds it.
    await writeIndexStatus(ns, { ...current, state: 'failed', resumable: false, error }, dbPath);
  } catch {
    /* best-effort: if even the downgrade write fails, the next rebuild's
       validation step still catches an inconsistent index before it is
       ever trusted for a read. */
  }
}

/** This scope's derived-index build/readiness state. `absent` means no one
 *  has ever called `kgRebuildIndex` for it — every read behaves exactly as
 *  it did before this index existed. */
export async function kgIndexStatus(options?: {
  scope?: KgScope;
  dbPath?: string;
}): Promise<KgIndexStatus> {
  return readIndexStatus(kgNamespaces(options?.scope), options?.dbPath);
}

// ── Adjacency entries (entity id -> edge keys) ───────────────────────

interface KgAdjEntry {
  edgeKeys: string[];
}

async function readAdj(
  ns: KgNamespaces,
  entityId: string,
  dbPath: string | undefined,
): Promise<KgAdjEntry | null> {
  const res = await bridgeGetEntry({ key: entityId, namespace: ns.adj, dbPath });
  if (!res) return null; // backend unavailable, distinct from "no entry yet"
  if (!res.found || !res.entry) return { edgeKeys: [] };
  const md = (res.entry.metadata ?? {}) as Partial<KgAdjEntry>;
  return { edgeKeys: Array.isArray(md.edgeKeys) ? (md.edgeKeys as string[]) : [] };
}

async function addToAdj(
  ns: KgNamespaces,
  entityId: string,
  edgeKey: string,
  dbPath: string | undefined,
): Promise<boolean> {
  const current = await readAdj(ns, entityId, dbPath);
  if (current === null) return false;
  if (current.edgeKeys.includes(edgeKey)) return true; // already present, idempotent
  if (current.edgeKeys.length >= MAX_ADJ_EDGES_PER_NODE) return false;
  const res = await bridgeStoreEntry({
    key: entityId,
    value: `kg adjacency: ${entityId}`,
    namespace: ns.adj,
    dbPath,
    upsert: true,
    generateEmbeddingFlag: false,
    metadata: { edgeKeys: [...current.edgeKeys, edgeKey] },
  });
  return Boolean(res?.success);
}

async function removeFromAdj(
  ns: KgNamespaces,
  entityId: string,
  edgeKey: string,
  dbPath: string | undefined,
): Promise<boolean> {
  const current = await readAdj(ns, entityId, dbPath);
  if (current === null) return false;
  if (!current.edgeKeys.includes(edgeKey)) return true; // already absent
  const res = await bridgeStoreEntry({
    key: entityId,
    value: `kg adjacency: ${entityId}`,
    namespace: ns.adj,
    dbPath,
    upsert: true,
    generateEmbeddingFlag: false,
    metadata: { edgeKeys: current.edgeKeys.filter((k) => k !== edgeKey) },
  });
  return Boolean(res?.success);
}

// ── Origin-support entries (origin ref -> {namespace,key} refs) ─────

interface KgOriginIndexRef {
  ns: string;
  key: string;
}

interface KgOriginIndexEntry {
  refs: KgOriginIndexRef[];
}

async function readOriginIndex(
  ns: KgNamespaces,
  originRef: string,
  dbPath: string | undefined,
): Promise<KgOriginIndexEntry | null> {
  const res = await bridgeGetEntry({ key: originRef, namespace: ns.originIdx, dbPath });
  if (!res) return null;
  if (!res.found || !res.entry) return { refs: [] };
  const md = (res.entry.metadata ?? {}) as Partial<KgOriginIndexEntry>;
  return { refs: Array.isArray(md.refs) ? (md.refs as KgOriginIndexRef[]) : [] };
}

async function addToOriginIndex(
  ns: KgNamespaces,
  originRef: string,
  ref: KgOriginIndexRef,
  dbPath: string | undefined,
): Promise<boolean> {
  const current = await readOriginIndex(ns, originRef, dbPath);
  if (current === null) return false;
  if (current.refs.some((r) => r.ns === ref.ns && r.key === ref.key)) return true;
  if (current.refs.length >= MAX_ORIGIN_INDEX_REFS) return false;
  const res = await bridgeStoreEntry({
    key: originRef,
    value: `kg origin index: ${originRef}`,
    namespace: ns.originIdx,
    dbPath,
    upsert: true,
    generateEmbeddingFlag: false,
    metadata: { refs: [...current.refs, ref] },
  });
  return Boolean(res?.success);
}

async function removeFromOriginIndex(
  ns: KgNamespaces,
  originRef: string,
  ref: KgOriginIndexRef,
  dbPath: string | undefined,
): Promise<boolean> {
  const current = await readOriginIndex(ns, originRef, dbPath);
  if (current === null) return false;
  const next = current.refs.filter((r) => !(r.ns === ref.ns && r.key === ref.key));
  if (next.length === current.refs.length) return true; // already absent
  const res = await bridgeStoreEntry({
    key: originRef,
    value: `kg origin index: ${originRef}`,
    namespace: ns.originIdx,
    dbPath,
    upsert: true,
    generateEmbeddingFlag: false,
    metadata: { refs: next },
  });
  return Boolean(res?.success);
}

// ── Dual-write hooks ──────────────────────────────────────────────────
//
// Best-effort and self-gating: a no-op (one status read) while the scope's
// index is `absent`, so ordinary ingest/rollback pay nothing extra until
// someone opts in by calling `kgRebuildIndex`. A failure here fails the
// INDEX (downgrades the scope to `failed`), never the canonical write or
// delete it accompanies — the index is a cache, not a second source of truth.

/** After a node/edge/rule write lands, record that `originRef` supports it. */
async function onEntrySupported(
  ns: KgNamespaces,
  entryNs: string,
  entryKey: string,
  originRef: string,
  dbPath: string | undefined,
): Promise<void> {
  const status = await readIndexStatus(ns, dbPath);
  if (status.state === 'absent' || status.state === 'failed') return;
  const ok = await addToOriginIndex(ns, originRef, { ns: entryNs, key: entryKey }, dbPath);
  if (!ok) await markIndexFailed(ns, dbPath, `origin index write failed for ${originRef}`);
}

/** After an edge write lands, record it in both endpoints' adjacency. */
async function onEdgeWritten(
  ns: KgNamespaces,
  edgeKey: string,
  src: string,
  dst: string,
  dbPath: string | undefined,
): Promise<void> {
  const status = await readIndexStatus(ns, dbPath);
  if (status.state === 'absent' || status.state === 'failed') return;
  const okSrc = await addToAdj(ns, src, edgeKey, dbPath);
  const okDst = src === dst ? true : await addToAdj(ns, dst, edgeKey, dbPath);
  if (!okSrc || !okDst) await markIndexFailed(ns, dbPath, `adjacency write failed for ${edgeKey}`);
}

/** After `kgRollback` deletes an entry outright (no origin left to support
 *  it), remove it from every index it could appear in. */
async function onEntryDeleted(
  ns: KgNamespaces,
  entryKey: string,
  dbPath: string | undefined,
  endpoints?: { src: string; dst: string },
): Promise<void> {
  const status = await readIndexStatus(ns, dbPath);
  if (status.state === 'absent' || status.state === 'failed') return;
  let ok = true;
  if (endpoints) {
    ok = (await removeFromAdj(ns, endpoints.src, entryKey, dbPath)) && ok;
    if (endpoints.dst !== endpoints.src)
      ok = (await removeFromAdj(ns, endpoints.dst, entryKey, dbPath)) && ok;
  }
  if (!ok) await markIndexFailed(ns, dbPath, `adjacency removal failed for ${entryKey}`);
}

/** After `kgRollback` withdraws one origin's support from an entry that
 *  survives (another origin still supports it), drop just that origin's ref. */
async function onOriginWithdrawn(
  ns: KgNamespaces,
  entryNs: string,
  entryKey: string,
  originRef: string,
  dbPath: string | undefined,
): Promise<void> {
  const status = await readIndexStatus(ns, dbPath);
  if (status.state === 'absent' || status.state === 'failed') return;
  const ok = await removeFromOriginIndex(ns, originRef, { ns: entryNs, key: entryKey }, dbPath);
  if (!ok) await markIndexFailed(ns, dbPath, `origin index removal failed for ${originRef}`);
}

// ── Indexed reads (used by kgSearch/kgRollback only when state === 'ready') ─

/** The indexed equivalent of `kgReferenceEdges({ endpointId })`: edges
 *  touching one entity, read via its adjacency entry instead of a namespace
 *  scan. Returns `null` when any edge key it names cannot be resolved — a
 *  torn index must never be presented as a complete answer. */
async function kgIndexedEdgesByEndpoint(
  ns: KgNamespaces,
  entityId: string,
  dbPath: string | undefined,
): Promise<KgReferenceEdge[] | null> {
  const adj = await readAdj(ns, entityId, dbPath);
  if (adj === null) return null;
  const edges: KgReferenceEdge[] = [];
  for (const key of adj.edgeKeys) {
    const res = await bridgeGetEntry({ key, namespace: ns.edges, dbPath });
    if (!res?.found || !res.entry) return null; // stale ref — do not half-answer
    const md = (res.entry.metadata ?? {}) as Record<string, unknown>;
    edges.push({
      key,
      src: String(md.src ?? ''),
      dst: String(md.dst ?? ''),
      relation: String(md.relation ?? 'related_to'),
      originRefs: originsOf(res.entry),
    });
  }
  return edges;
}

/** The indexed equivalent of `collectByOrigin`: every {namespace,key} entry
 *  one origin supports, read via its origin-index entry instead of scanning
 *  every namespace. Returns `null` on any unresolvable ref, same reasoning
 *  as `kgIndexedEdgesByEndpoint`. */
/** Returns each entry paired with the namespace it was read from (from the
 *  index's own ref, not trusted from the entry itself) so a caller can sort
 *  results back into per-namespace buckets without guessing. */
async function kgIndexedByOrigin(
  ns: KgNamespaces,
  originRef: string,
  dbPath: string | undefined,
): Promise<{ ns: string; entry: ScannedEntry }[] | null> {
  const idx = await readOriginIndex(ns, originRef, dbPath);
  if (idx === null) return null;
  const entries: { ns: string; entry: ScannedEntry }[] = [];
  for (const ref of idx.refs) {
    const res = await bridgeGetEntry({ key: ref.key, namespace: ref.ns, dbPath });
    if (!res?.found || !res.entry) return null;
    entries.push({ ns: ref.ns, entry: res.entry as ScannedEntry });
  }
  return entries;
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
