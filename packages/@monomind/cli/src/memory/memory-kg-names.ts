/**
 * Memory Knowledge Graph — the name index and merge index, and entity
 * resolution through them (same-name candidates without name-only
 * identity). Split out of memory-kg.ts, which re-exports the public
 * symbols.
 */

import { mergeKey } from './entity-name-key.js';
import { bridgeDeleteEntry, bridgeGetEntry, bridgeStoreEntry } from './memory-bridge.js';
import type { KgNamespaces } from './memory-kg-model.js';
import {
  canonicalName,
  hashTuple,
  KG_ID_VERSION,
  legacyNodeKey,
  nodeKey,
  typeBucket,
} from './memory-kg-model.js';
import type { FailureLog } from './memory-kg-scan.js';

// ── Name index (same-name candidates, without name-only identity) ────

/** An entity the name index knows about. */
export interface KgNameCandidate {
  id: string;
  /** Identity-bearing type bucket; '' for an entity asserted without a type. */
  type: string;
}

function nameIndexKey(name: string): string {
  return `nm:${hashTuple([String(KG_ID_VERSION), canonicalName(name)])}`;
}

/** A coarser, additive index alongside the exact one: bucketed by `mergeKey`
 *  (case/separator/plural-insensitive), so "Node.js" and "nodejs" land in the
 *  same bucket even though their exact `nameIndexKey`s differ. Purely a hint
 *  like the exact index — `resolveEntity` still applies the same (type, name)
 *  merge rules to whatever it finds here, so a bucket hit is a candidate,
 *  never an automatic cross-type merge. */
function mergeIndexKey(name: string): string {
  return `nmk:${hashTuple([String(KG_ID_VERSION), mergeKey(name)])}`;
}

/** @returns the indexed entities, or null when the backend could not be read.
 *
 *  The null is load-bearing: an unreadable index looks exactly like an empty
 *  one, and treating a read failure as "no entities with this name" would make
 *  the next write REPLACE the row with a single entry, erasing every other
 *  same-name entity from the index. A later generic assertion would then see one
 *  candidate and adopt it — a silent wrong merge caused by a read hiccup. */
export async function readNameIndex(
  name: string,
  ns: KgNamespaces,
  dbPath: string | undefined,
): Promise<KgNameCandidate[] | null> {
  const res = await bridgeGetEntry({ key: nameIndexKey(name), namespace: ns.names, dbPath });
  if (!res) return null;
  const raw = (res.entry?.metadata as Record<string, unknown> | undefined)?.entities;
  if (!Array.isArray(raw)) return [];
  return (raw as KgNameCandidate[]).filter((c) => c && typeof c.id === 'string');
}

/** Persist (or clear) the index row for one name.
 *
 *  The index is a HINT, not a source of truth: it is written after the entity
 *  write lands, and a row that goes stale — pointing at an entity a rollback
 *  removed — self-heals, because resolving onto a missing id makes the next
 *  ingest create that entity fresh with an empty claim ledger, which is exactly
 *  what a new entity is. Nothing reads the index to decide what the graph
 *  contains; `kgStats`, `kgSearch` and `kgRollback` all read the claim
 *  namespaces. */
export async function writeNameIndex(
  name: string,
  entities: KgNameCandidate[],
  ns: KgNamespaces,
  dbPath: string | undefined,
  failures: FailureLog,
): Promise<void> {
  const key = nameIndexKey(name);
  if (!entities.length) {
    await bridgeDeleteEntry({ key, namespace: ns.names, dbPath });
    return;
  }
  const res = await bridgeStoreEntry({
    key,
    value: name,
    namespace: ns.names,
    dbPath,
    upsert: true,
    generateEmbeddingFlag: false,
    tags: ['kg', 'name-index'],
    metadata: { kg: 'name', name, entities },
  });
  failures.add(res, `name index ${key}`);
  await writeMergeIndex(name, entities, ns, dbPath, failures);
}

/** Add `entities` into the merge-key bucket for `name`, unioned with whatever
 *  other exact spellings already sharing that bucket contributed. Additive
 *  only — a name written with fewer entities than before (e.g. a rollback's
 *  survivor list) never removes another spelling's candidates from the shared
 *  bucket. That is a smaller staleness cost than the exact index already
 *  accepts, and self-heals the same way: a stale candidate that no longer
 *  resolves to a live entity simply is not adopted. */
async function writeMergeIndex(
  name: string,
  entities: KgNameCandidate[],
  ns: KgNamespaces,
  dbPath: string | undefined,
  failures: FailureLog,
): Promise<void> {
  const key = mergeIndexKey(name);
  const existing = await bridgeGetEntry({ key, namespace: ns.names, dbPath });
  const prior = (existing?.entry?.metadata as Record<string, unknown> | undefined)?.entities;
  const merged = new Map<string, KgNameCandidate>();
  if (Array.isArray(prior))
    for (const c of prior as KgNameCandidate[])
      if (c && typeof c.id === 'string') merged.set(c.id, c);
  for (const c of entities) merged.set(c.id, c);
  const res = await bridgeStoreEntry({
    key,
    value: mergeKey(name),
    namespace: ns.names,
    dbPath,
    upsert: true,
    generateEmbeddingFlag: false,
    tags: ['kg', 'name-merge-index'],
    metadata: { kg: 'name-merge', mergeKey: mergeKey(name), entities: [...merged.values()] },
  });
  failures.add(res, `merge index ${key}`);
}

/** @returns candidates from the merge-key bucket, or null on a read failure —
 *  same null-is-load-bearing contract as `readNameIndex`. */
async function readMergeIndex(
  name: string,
  ns: KgNamespaces,
  dbPath: string | undefined,
): Promise<KgNameCandidate[] | null> {
  const res = await bridgeGetEntry({ key: mergeIndexKey(name), namespace: ns.names, dbPath });
  if (!res) return null;
  const raw = (res.entry?.metadata as Record<string, unknown> | undefined)?.entities;
  if (!Array.isArray(raw)) return [];
  return (raw as KgNameCandidate[]).filter((c) => c && typeof c.id === 'string');
}

/** What resolving a name against the index produced. */
interface ResolvedEntity {
  id: string;
  /** Same-name entities this assertion did NOT merge with. Reported, never
   *  merged away — "Alex the person" and "Alex the service" are candidates for
   *  a human or a consolidation pass to judge, not a merge the graph may do on
   *  its own. */
  candidates: KgNameCandidate[];
  /** Index content to persist for this name, or null when it is already
   *  correct. Written only after the entity write lands, so a refused write
   *  never leaves the index pointing at an entity that does not exist. */
  index: KgNameCandidate[] | null;
}

/**
 * Resolve (type, name) to the entity that should carry the assertion.
 *
 * Identity is the (type, name) tuple, so distinct types are distinct entities.
 * The one thing name-only identity got right — a generic label must not fork an
 * entity away from its typed self — is preserved here instead of in the key:
 *
 *  - exact type-bucket match  → that entity
 *  - generic assertion, exactly one same-name entity → adopt it
 *  - typed assertion, exactly one same-name entity and it is untyped → adopt it
 *    and promote its type (its ID does not change, so references stay valid)
 *  - anything else            → a new entity, with the alternatives as candidates
 *
 * @returns null when the name index could not be read — the caller must refuse
 * the assertion rather than resolve it against an index it could not see.
 */
export async function resolveEntity(
  name: string,
  type: string,
  ns: KgNamespaces,
  dbPath: string | undefined,
): Promise<ResolvedEntity | null> {
  const bucket = typeBucket(type);
  let known = await readNameIndex(name, ns, dbPath);
  if (known === null) return null;
  /** True when the index row already holds exactly `known` — the only case in
   *  which an unchanged resolution needs no index write. */
  let indexed = known.length > 0;

  if (!indexed) {
    // Nothing indexed. Before minting, probe the pre-KG_ID_VERSION key: an
    // existing graph's rows are adopted IN PLACE (keeping their key, and so
    // keeping the edges whose keys embed it) rather than re-keyed or orphaned.
    const legacyKey = legacyNodeKey(name);
    const legacy = await bridgeGetEntry({ key: legacyKey, namespace: ns.nodes, dbPath });
    if (legacy?.found && legacy.entry) {
      const md = legacy.entry.metadata as Record<string, unknown>;
      known = [{ id: legacyKey, type: typeBucket(typeof md.type === 'string' ? md.type : '') }];
      indexed = false;
    }
  }

  if (!indexed && known.length === 0) {
    // Still nothing under this exact spelling — check for a spelling variant
    // (case, separators, a plain plural) already known under the same
    // merge-key bucket. A hit is only a CANDIDATE: it still goes through the
    // exact/promote/mint rules below, so it can never merge across types.
    const merged = await readMergeIndex(name, ns, dbPath);
    if (merged && merged.length > 0) known = merged;
  }

  const exact = known.find((c) => c.type === bucket);
  if (exact)
    return { id: exact.id, candidates: others(known, exact.id), index: indexed ? null : known };

  // A generic assertion adopts the one entity that bears this name; a typed
  // assertion adopts a lone UNTYPED entity and PROMOTES it — same id, so every
  // edge and returned reference to it stays valid. A typed assertion never
  // absorbs a differently-typed entity, and neither adopts when the name is
  // already ambiguous.
  if (known.length === 1 && (!bucket || !known[0].type)) {
    const only = known[0];
    const promoted = { id: only.id, type: bucket || only.type };
    return { id: only.id, candidates: [], index: [promoted] };
  }

  const minted = { id: mintEntityId(type, name, known), type: bucket };
  return { id: minted.id, candidates: known, index: [...known, minted] };
}

/** An ID for a new entity that no entity under this name already uses.
 *
 *  `nodeKey(type, name)` alone is not sufficient, because promotion decouples
 *  an entity's ID from its current type: an entity minted untyped keeps the
 *  `''`-bucket ID after a typed assertion promotes it, so a LATER untyped
 *  assertion would re-derive that same ID and write its claims into the
 *  promoted entity — while simultaneously reporting that entity as one it had
 *  "kept separate from". The discriminator is bumped only on collision, so the
 *  first entity of a (type, name) still gets exactly `nodeKey(type, name)`. */
function mintEntityId(type: string, name: string, known: KgNameCandidate[]): string {
  const taken = new Set(known.map((c) => c.id));
  let id = nodeKey(type, name);
  for (let n = 1; taken.has(id); n++)
    id = `n:${hashTuple([String(KG_ID_VERSION), typeBucket(type), canonicalName(name), String(n)])}`;
  return id;
}

function others(known: KgNameCandidate[], id: string): KgNameCandidate[] {
  return known.filter((c) => c.id !== id);
}
