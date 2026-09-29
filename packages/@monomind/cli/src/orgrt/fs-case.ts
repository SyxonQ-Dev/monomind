// packages/@monomind/cli/src/orgrt/fs-case.ts
/**
 * #496: does the filesystem a path lives on compare names case-insensitively?
 *
 * Probed, not assumed from the platform: Linux mounts can fold case (vfat,
 * exfat, SMB, ext4 casefold dirs) and a macOS or Windows volume can be
 * case-sensitive. The probe takes the nearest existing ancestor of the path,
 * picks the deepest segment of it that has letters, swaps that segment's
 * case and `lstat`s the variant: the same directory (dev and inode) means
 * the filesystem folds case there. Only directories are compared, since a
 * directory cannot be hard-linked, and `lstat` does not follow a symlink, so
 * a role cannot plant a look-alike that fakes the answer. Results are cached
 * per probed directory.
 */
import { lstatSync, type Stats } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** `unknown`: nothing on the path exists, or no existing segment has a
 *  letter whose case can be swapped (e.g. `/`). */
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

function probeDir(dir: string): CaseSensitivity {
  for (let cur = dir; ; cur = dirname(cur)) {
    const name = basename(cur);
    const swapped = swapCase(name);
    if (name && swapped !== name) {
      const a = lstatOf(cur);
      if (!a?.isDirectory()) return 'unknown';
      const b = lstatOf(join(dirname(cur), swapped));
      return b?.isDirectory() && b.ino === a.ino && b.dev === a.dev ? 'insensitive' : 'sensitive';
    }
    if (dirname(cur) === cur) return 'unknown';
  }
}

/** How the filesystem holding `p` (an absolute, resolved path) compares
 *  names. `p` itself need not exist. */
export function probeCase(p: string): CaseSensitivity {
  let dir = p;
  for (;;) {
    const st = lstatOf(dir);
    if (st?.isDirectory()) break;
    const parent = dirname(dir);
    if (parent === dir) return 'unknown';
    dir = parent;
  }
  const hit = cache.get(dir);
  if (hit) return hit;
  const value = probeDir(dir);
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(dir, value);
  return value;
}
