// packages/@monomind/cli/src/orgrt/fs-case.ts
/**
 * #496: does the filesystem a path lives on compare names case-insensitively?
 * Used only to let a GRANT fold case (policy-paths.ts's pathFolds); deny
 * checks fold unconditionally and never ask.
 *
 * Two probes of the nearest existing directory `dir` of the path, which must
 * agree, or the answer is `unknown`:
 *   - outer: `dir`'s own name with its case swapped, looked up in its parent
 *     — directories only (a directory cannot be hard-linked);
 *   - inner: one entry of `dir` with its case swapped, looked up in `dir` —
 *     what a not-yet-existing name below `dir` will be compared as. A Linux
 *     casefold flag, or a Windows per-directory case-sensitivity flag,
 *     governs a directory's entries, not its own name, and a mount root has
 *     no parent on the same filesystem, so the outer probe alone can be
 *     wrong.
 * Each compares dev and inode through `lstat`, so a planted symlink never
 * counts as the same entry. Results are cached per directory.
 */
import { lstatSync, readdirSync, type Stats } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** `unknown`: the probes disagree, or have nothing to test (no existing
 *  directory, no name with a letter whose case can be swapped). */
export type CaseSensitivity = 'insensitive' | 'sensitive' | 'unknown';

const cache = new Map<string, CaseSensitivity>();
const CACHE_MAX = 512;

const lstatOf = (p: string): Stats | undefined => {
  try {
    return lstatSync(p);
  } catch {
    return undefined;
  }
};

const swapCase = (s: string): string => {
  const up = s.toUpperCase();
  return up !== s ? up : s.toLowerCase();
};

/** Whether `name` and its case-swapped spelling are one entry of `parent`. */
function sameEntry(parent: string, name: string, dirsOnly: boolean): CaseSensitivity {
  const a = lstatOf(join(parent, name));
  if (!a || a.isSymbolicLink() || (dirsOnly && !a.isDirectory())) return 'unknown';
  const b = lstatOf(join(parent, swapCase(name)));
  return b && !b.isSymbolicLink() && b.ino === a.ino && b.dev === a.dev
    ? 'insensitive'
    : 'sensitive';
}

function outerProbe(dir: string): CaseSensitivity {
  for (let cur = dir; dirname(cur) !== cur; cur = dirname(cur)) {
    const name = basename(cur);
    if (swapCase(name) !== name) return sameEntry(dirname(cur), name, true);
  }
  return 'unknown';
}

function innerProbe(dir: string): CaseSensitivity {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 'unknown';
  }
  for (const name of names) {
    if (swapCase(name) === name) continue;
    const r = sameEntry(dir, name, false);
    if (r !== 'unknown') return r;
  }
  return 'unknown';
}

/** How the filesystem holding `p` (an absolute, resolved path) compares
 *  names below its nearest existing directory. `p` itself need not exist. */
export function probeCase(p: string): CaseSensitivity {
  let dir = p;
  while (!lstatOf(dir)?.isDirectory()) {
    const parent = dirname(dir);
    if (parent === dir) return 'unknown';
    dir = parent;
  }
  const hit = cache.get(dir);
  if (hit) return hit;
  const outer = outerProbe(dir);
  const value = outer === innerProbe(dir) ? outer : 'unknown';
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(dir, value);
  return value;
}
