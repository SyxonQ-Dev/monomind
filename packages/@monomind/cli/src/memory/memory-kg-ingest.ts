/**
 * Memory Knowledge Graph — ingest: kgIngest (entity resolution, claim
 * merge under compare-and-swap, placeholder endpoints) and its per-call
 * report. Split out of memory-kg.ts, which re-exports kgIngest.
 */

import { bridgeGetEntry, bridgeStoreEntry } from './memory-bridge.js';
import type { DerivedClaims, KgExtractionMethod } from './memory-kg-claims.js';
import { applyClaim } from './memory-kg-claims.js';
import { onEdgeWritten, onEntrySupported } from './memory-kg-index.js';
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
  MAX_DESC_LEN,
  MAX_EDGES_PER_CALL,
  MAX_NODES_PER_CALL,
  normalizeName,
  typeBucket,
} from './memory-kg-model.js';
import type { KgNameCandidate } from './memory-kg-names.js';
import { resolveEntity, writeNameIndex } from './memory-kg-names.js';
import { FailureLog, MAX_FAILURES, withCasRetry } from './memory-kg-scan.js';

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
