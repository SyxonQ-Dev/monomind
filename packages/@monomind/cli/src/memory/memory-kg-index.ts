/**
 * Memory Knowledge Graph — the K7 derived index: status, adjacency entries,
 * origin-support entries, the dual-write hooks that keep them in sync, and
 * the indexed reads used once a scope is `ready`. Split out of
 * memory-kg.ts, which re-exports the public symbols.
 */

import { bridgeGetEntry, bridgeStoreEntry } from './memory-bridge.js';
import type { KgNamespaces, KgScope } from './memory-kg-model.js';
import { kgNamespaces } from './memory-kg-model.js';
import type { KgReferenceEdge, ScannedEntry } from './memory-kg-scan.js';
import { originsOf } from './memory-kg-scan.js';

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

export const KG_INDEX_SCHEMA_VERSION = 1;
const INDEX_STATUS_KEY = 'status';
/** Edge keys recorded per adjacency entry before the index refuses to grow it
 *  further and fails the SCOPE's index rather than risk an oversized or
 *  silently truncated row. A hub node past this reads via the exhaustive
 *  scan, exactly as before the index existed — this only gates the fast
 *  path, never correctness. */
const MAX_ADJ_EDGES_PER_NODE = 2000;
/** Refs recorded per origin-support entry before the same refusal applies. */
const MAX_ORIGIN_INDEX_REFS = 5000;

export async function readIndexStatus(
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

export async function writeIndexStatus(
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

export async function readAdj(
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

export async function addToAdj(
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

export async function addToOriginIndex(
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
export async function onEntrySupported(
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
export async function onEdgeWritten(
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
export async function onEntryDeleted(
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
export async function onOriginWithdrawn(
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
export async function kgIndexedEdgesByEndpoint(
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
export async function kgIndexedByOrigin(
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
