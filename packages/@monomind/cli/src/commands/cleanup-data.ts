/**
 * Cleanup — orphaned per-project data pruning (--data): ~/.monomind/projects
 * dirs and ~/.monomind-projects.json registry entries whose project is gone.
 * Extracted from cleanup.ts.
 */

import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFile } from '../init/fs-helpers.js';
import { isProvablyDeleted } from './cleanup-origin.js';
import type { StaleScratchItem } from './cleanup-scratch.js';

/** Orphaned per-project data (--data): ~/.monomind/projects/<slug> dirs whose
 * source project is gone, plus dead lancedb/ dirs left by the pre-2.3.1 engine. */
const UNKNOWN_DIR_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Entries of the project registry (~/.monomind-projects.json, written by
 * `init` for `init upgrade --all`) whose project was deleted, by the same rule
 * as project-data dirs. Exported for tests; unreadable registry → none.
 */
export function findStaleRegistryEntries(registryPath: string): string[] {
  try {
    const reg = JSON.parse(readFileSync(registryPath, 'utf-8')) as { projects?: unknown };
    if (!Array.isArray(reg.projects)) return [];
    return reg.projects.filter(
      (p): p is string => typeof p === 'string' && p.length > 0 && isProvablyDeleted(p),
    );
  } catch {
    return [];
  }
}

/** Rewrite the registry without `stale`, re-read first so a concurrent `init` registration survives. */
export function pruneRegistryEntries(registryPath: string, stale: string[]): number {
  const reg = JSON.parse(readFileSync(registryPath, 'utf-8')) as { projects: unknown[] };
  const drop = new Set(stale);
  const kept = reg.projects.filter((p) => !(typeof p === 'string' && drop.has(p)));
  const removed = reg.projects.length - kept.length;
  if (removed > 0) {
    reg.projects = kept;
    atomicWriteFile(registryPath, JSON.stringify(reg, null, 2), 'utf-8');
  }
  return removed;
}

/**
 * Find prunable entries under the per-project data base (default
 * ~/.monomind/projects). Exported for tests — `baseDir`/`now` injectable.
 *
 * Classification per dir:
 * - `origin.json` present and its recorded path still exists → keep the dir,
 *   but flag a leftover `lancedb/` subdir (dead since the SQLite engine swap).
 * - `origin.json` present, recorded path provably deleted (not merely on an
 *   unmounted volume, see {@link isProvablyDeleted}) → orphaned → prune.
 * - no `origin.json` (pre-2.3.1 dirs can't prove their origin) → prune only
 *   when untouched for {@link UNKNOWN_DIR_MAX_AGE_MS} — or immediately with
 *   `--aggressive`, which treats unprovable dirs as junk (safe: every live
 *   project rewrites origin.json on its next memory access).
 */
export function findOrphanedProjectData(
  baseDir: string,
  now: number,
  aggressive: boolean,
): StaleScratchItem[] {
  const out: StaleScratchItem[] = [];
  if (!existsSync(baseDir)) return out;
  for (const name of readdirSync(baseDir)) {
    if (name.startsWith('.')) continue;
    const dir = join(baseDir, name);
    try {
      if (!lstatSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    // Staleness must consider the files writes actually touch: appends to
    // lancedb/memory.db and origin.json refreshes do NOT bump the slug dir's
    // own mtime, so an actively-used project would otherwise look 30d stale.
    const mtimeOf = (p: string): number => {
      try {
        return lstatSync(p).mtimeMs;
      } catch {
        return 0;
      }
    };
    const mtime = Math.max(
      mtimeOf(dir),
      mtimeOf(join(dir, 'origin.json')),
      mtimeOf(join(dir, 'lancedb', 'memory.db')),
      mtimeOf(join(dir, 'memory.db')),
    );
    const originFile = join(dir, 'origin.json');
    let originPath: string | null = null;
    let hasOrigin = false;
    try {
      originPath = String(JSON.parse(readFileSync(originFile, 'utf-8')).path ?? '');
      hasOrigin = originPath.length > 0;
    } catch {
      /* no/corrupt marker */
    }
    if (hasOrigin && originPath && existsSync(originPath)) {
      // NOTE: the directory is *named* lancedb for historical reasons, but the
      // current SQLite engine keeps its LIVE memory.db inside it. Only genuine
      // LanceDB leftovers (*.lance datasets, no memory.db) are dead weight.
      const lance = join(dir, 'lancedb');
      if (existsSync(lance) && !existsSync(join(lance, 'memory.db'))) {
        let hasLanceData = false;
        try {
          hasLanceData = readdirSync(lance).some((f) => f.endsWith('.lance') || f === '__manifest');
        } catch {
          /* unreadable — leave it */
        }
        if (hasLanceData)
          out.push({
            path: lance,
            description: `dead lancedb store (project: ${originPath})`,
            size: 0,
          });
      }
      continue;
    }
    if (hasOrigin && originPath) {
      // An unmounted volume / disconnected network share makes the whole
      // subtree vanish temporarily, and that must never count as "project
      // deleted" — see isProvablyDeleted.
      if (isProvablyDeleted(originPath)) {
        out.push({
          path: dir,
          description: `orphaned project data (origin gone: ${originPath})`,
          size: 0,
        });
      }
    } else if (aggressive || now - mtime > UNKNOWN_DIR_MAX_AGE_MS) {
      out.push({
        path: dir,
        description: aggressive
          ? 'unverifiable project data (no origin marker)'
          : 'unverifiable project data (untouched >30d)',
        size: 0,
      });
    }
  }
  return out;
}
