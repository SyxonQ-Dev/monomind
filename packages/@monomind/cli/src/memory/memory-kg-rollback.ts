/**
 * Memory Knowledge Graph — per-origin rollback: kgRollback withdraws an
 * origin's support, re-derives the survivors and removes edges left
 * without endpoints. Split out of memory-kg.ts, which re-exports
 * kgRollback.
 */

import { bridgeDeleteEntry, bridgeStoreEntry } from './memory-bridge.js';
import { withoutOrigin } from './memory-kg-claims.js';
import {
  kgIndexedByOrigin,
  onEntryDeleted,
  onOriginWithdrawn,
  readIndexStatus,
} from './memory-kg-index.js';
import type { KgNamespaces, KgScope } from './memory-kg-model.js';
import { kgNamespaces, kgQualifyOrigin } from './memory-kg-model.js';
import { readNameIndex, writeNameIndex } from './memory-kg-names.js';
import type { ScannedEntry } from './memory-kg-scan.js';
import { collectByOrigin, FailureLog, scanNamespace } from './memory-kg-scan.js';

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
