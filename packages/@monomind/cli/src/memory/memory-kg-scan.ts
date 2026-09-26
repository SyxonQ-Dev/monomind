/**
 * Memory Knowledge Graph — exhaustive paged namespace scans, write-failure
 * reporting and CAS retry, per-origin collection, and the K7 reference edge
 * lookup. Split out of memory-kg.ts, which re-exports the public symbols.
 */

import { bridgeDeleteEntry, bridgeListEntries, type bridgeStoreEntry } from './memory-bridge.js';
import type { KgScope } from './memory-kg-model.js';
import { kgNamespaces, kgQualifyOrigin } from './memory-kg-model.js';

/** Rows per `bridgeListEntries` call while scanning a namespace.
 *
 *  A single list call cannot return more than the backend's own 10,000-row
 *  ceiling (`MAX_QUERY_LIMIT` in sql-backend.ts), so the old `limit: MAX_LIST`
 *  scans were not "large enough to be safe" — they were exactly the point past
 *  which the graph goes silently invisible. Everything below pages instead.
 *
 *  1,000 balances the two costs: one page is at most ~1 MB even at the bridge's
 *  16 KB value cap (typical KG entries are far smaller), and it takes a tenth
 *  of the round trips a 100-row page would. */
export const SCAN_PAGE = 1_000;

/** Edge rows `kgSearch` will read before giving up and reporting `truncated`.
 *  Search is interactive and runs a full scan per query, so unlike rollback it
 *  keeps a ceiling — five times the old silent one, and now stated in the
 *  result rather than hidden. */
export const SEARCH_EDGE_SCAN_MAX = 50_000;

export type ScannedEntry = NonNullable<
  Awaited<ReturnType<typeof bridgeListEntries>>
>['entries'][number];

/** Page through an entire namespace, handing each page to `onPage` so callers
 *  fold as they go instead of materializing the namespace.
 *
 *  `onPage` returning exactly `false` stops the scan early (only `kgSearch`
 *  does that); any other return value continues. Returns false when the backend
 *  was unavailable — an unreadable namespace must never be mistaken for an
 *  empty one.
 *
 *  Callers that MUTATE what they find must collect during the scan and mutate
 *  afterwards: deleting a row pulls every later row back one position, so under
 *  an advancing offset the row that slid into the gap is never read. (The
 *  bridge's upsert no longer reorders — it reuses the existing entry id and
 *  preserves `createdAt` — so rewrites alone are safe; deletes are not, and
 *  both callers here delete.) */
export async function scanNamespace(
  namespace: string,
  dbPath: string | undefined,
  onPage: (entries: ScannedEntry[]) => unknown,
): Promise<boolean> {
  for (let offset = 0; ; offset += SCAN_PAGE) {
    const res = await bridgeListEntries({ namespace, limit: SCAN_PAGE, offset, dbPath });
    if (!res) return false;
    if (res.entries.length && onPage(res.entries) === false) return true;
    if (res.entries.length < SCAN_PAGE) return true;
  }
}

/** Delete every entry in `namespace`. Used only to reset a DERIVED-index
 *  namespace (`kg:adj`/`kg:origin-idx`) before a fresh `kgRebuildIndex` —
 *  never a canonical one. Collect-then-delete, same reason `kgRollback`
 *  does: deleting mid-scan pulls later rows back under an advancing offset.
 *  Returns false (nothing deleted) on an unreadable or partially-deletable
 *  namespace, so the caller never proceeds as if a clear that didn't fully
 *  happen did. */
export async function clearNamespace(
  namespace: string,
  dbPath: string | undefined,
): Promise<boolean> {
  const doomed: ScannedEntry[] = [];
  const covered = await scanNamespace(namespace, dbPath, (page) => {
    for (const e of page) doomed.push(e);
  });
  if (!covered) return false;
  let ok = true;
  for (const e of doomed) {
    const del = await bridgeDeleteEntry({ id: e.id, namespace, dbPath });
    if (!del?.deleted) ok = false;
  }
  return ok;
}

/** Cap on reported failure messages — a dead backend fails every write, and a
 *  500-entry failure list is noise, not signal. `error` carries the true count. */
export const MAX_FAILURES = 20;

/** `bridgeStoreEntry` never throws: it returns `null` when no backend is
 *  reachable and `{ success: false, error }` when the write itself failed.
 *  Both look like success to an `await` that ignores the result, which is how
 *  the graph came to claim knowledge it had not persisted. Every write in this
 *  module goes through here.
 *
 *  @returns a failure message, or null when the write landed. */
function storeFailure(
  res: Awaited<ReturnType<typeof bridgeStoreEntry>>,
  what: string,
): string | null {
  if (!res) return `${what}: memory backend unavailable`;
  if (!res.success) return `${what}: ${res.error ?? 'store rejected'}`;
  return null;
}

/** Accumulates write failures across a multi-write operation. The memory
 *  bridge exposes no transaction primitive, so ingest CANNOT be atomic: some
 *  writes land and some do not. Rather than hide that, callers get exact
 *  counters for what persisted plus the failure list for what did not. */
export class FailureLog {
  readonly messages: string[] = [];
  private count = 0;

  /** @returns true when the write failed (caller should not count it). */
  add(res: Awaited<ReturnType<typeof bridgeStoreEntry>>, what: string): boolean {
    const msg = storeFailure(res, what);
    if (!msg) return false;
    this.count++;
    if (this.messages.length < MAX_FAILURES) this.messages.push(msg);
    return true;
  }

  note(message: string): void {
    this.count++;
    if (this.messages.length < MAX_FAILURES) this.messages.push(message);
  }

  get failed(): boolean {
    return this.count > 0;
  }

  /** Summary for the result's `error` field; undefined when everything landed. */
  summary(): string | undefined {
    if (!this.count) return undefined;
    return `${this.count} bridge operation(s) failed; graph state is partial`;
  }
}

/** Attempts a compare-and-swap claim write, retrying while the bridge reports
 *  a version conflict (K5): a concurrent writer applied its own claim to the
 *  same row between our read and our write. `attempt()` must re-read,
 *  re-merge (via `applyClaim`), and re-attempt the write itself on every call
 *  — retrying with the SAME stale write would just lose the update again,
 *  the exact bug this exists to close.
 *
 *  Exhausting `maxAttempts` under sustained contention is returned as-is (the
 *  last conflict response) rather than retried forever: the caller's
 *  `FailureLog` reports it as a real, visible failure — never a silent lost
 *  update — same as any other write the bridge refused. */
export async function withCasRetry(
  attempt: () => Promise<Awaited<ReturnType<typeof bridgeStoreEntry>>>,
  maxAttempts = 3,
): Promise<Awaited<ReturnType<typeof bridgeStoreEntry>>> {
  let res: Awaited<ReturnType<typeof bridgeStoreEntry>> = null;
  for (let i = 0; i < maxAttempts; i++) {
    res = await attempt();
    if (!res?.conflict) return res;
  }
  return res;
}

export function originsOf(entry: ScannedEntry): string[] {
  const origins = ((entry.metadata ?? {}) as Record<string, unknown>).origin_refs;
  return Array.isArray(origins) ? (origins as string[]) : [];
}

/** Every entry in `namespace` that `originRef` supports, collected by an
 *  EXHAUSTIVE paged scan. `covered` is false when the backend became
 *  unreadable partway — an incomplete answer, never an empty one.
 *
 *  Collecting rather than streaming is required by the callers that mutate:
 *  deleting a row pulls later rows back, so an advancing offset would skip
 *  whatever slid into the gap. Only origin-carrying entries are retained, so
 *  memory tracks the operation's own footprint, not the namespace size. */
export async function collectByOrigin(
  namespace: string,
  originRef: string,
  dbPath: string | undefined,
): Promise<{ entries: ScannedEntry[]; covered: boolean }> {
  const entries: ScannedEntry[] = [];
  const covered = await scanNamespace(namespace, dbPath, (page) => {
    for (const e of page) if (originsOf(e).includes(originRef)) entries.push(e);
  });
  return { entries, covered };
}

// ── Reference lookup (K7 ground truth) ───────────────────────────────

export interface KgReferenceEdge {
  key: string;
  src: string;
  dst: string;
  relation: string;
  originRefs: string[];
}

/** Complete, uncapped read of every edge touching `endpointId` (as either
 *  src or dst) and/or asserted by `originRef` — at least one filter is
 *  required. This is the ground truth an indexed adjacency/origin lookup
 *  (K7) must agree with once one exists: an exhaustive paged scan, the same
 *  mechanism `kgRollback` already trusts for origin withdrawal, so it never
 *  depends on an index and never inherits the old first-page cap.
 *
 *  `truncated: true` means the scan did not finish — an incomplete answer,
 *  never an empty one. Callers comparing this against a future index must
 *  treat a truncated reference read as "unknown", not as "no matches". */
export async function kgReferenceEdges(options: {
  endpointId?: string;
  originRef?: string;
  scope?: KgScope;
  dbPath?: string;
}): Promise<{ success: boolean; edges: KgReferenceEdge[]; truncated?: boolean; error?: string }> {
  if (!options.endpointId && !options.originRef) {
    return { success: false, edges: [], error: 'endpointId or originRef is required' };
  }
  const ns = kgNamespaces(options.scope);
  const originRef = options.originRef
    ? kgQualifyOrigin(options.originRef, options.scope)
    : undefined;
  const edges: KgReferenceEdge[] = [];
  try {
    const covered = await scanNamespace(ns.edges, options.dbPath, (page) => {
      for (const e of page) {
        const md = (e.metadata ?? {}) as Record<string, unknown>;
        if (md.kg !== 'edge') continue;
        const src = String(md.src ?? '');
        const dst = String(md.dst ?? '');
        if (options.endpointId && src !== options.endpointId && dst !== options.endpointId)
          continue;
        const originRefs = originsOf(e);
        if (originRef && !originRefs.includes(originRef)) continue;
        edges.push({
          key: e.key,
          src,
          dst,
          relation: String(md.relation ?? 'related_to'),
          originRefs,
        });
      }
    });
    return { success: true, edges, ...(covered ? {} : { truncated: true }) };
  } catch (err) {
    return { success: false, edges, error: err instanceof Error ? err.message : String(err) };
  }
}
