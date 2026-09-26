/**
 * Memory Knowledge Graph — K7 index rebuild/repair (kgRebuildIndex, with
 * resume and validation against the reference reads) and the graph
 * integrity check. Split out of memory-kg.ts, which re-exports the public
 * symbols.
 */

import { bridgeGetEntry, bridgeListEntries } from './memory-bridge.js';
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
import type { KgScope } from './memory-kg-model.js';
import { kgNamespaces } from './memory-kg-model.js';
import type { KgReferenceEdge } from './memory-kg-scan.js';
import {
  clearNamespace,
  collectByOrigin,
  kgReferenceEdges,
  originsOf,
  SCAN_PAGE,
  scanNamespace,
} from './memory-kg-scan.js';

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
