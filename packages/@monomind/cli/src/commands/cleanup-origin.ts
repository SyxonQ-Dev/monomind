/**
 * Deleted-vs-unmounted rule for `cleanup --data` (#347): decides whether a
 * recorded project path is gone because it was deleted, or only because the
 * volume holding it is not attached right now.
 */

import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';

/** The two filesystem questions the rule asks; injectable for tests. */
export interface OriginFs {
  exists(p: string): boolean;
  /** st_dev of `p`; throws when it cannot be stat-ed. */
  dev(p: string): number;
}

const nodeOriginFs: OriginFs = {
  exists: existsSync,
  dev: (p) => statSync(p).dev,
};

/** Where removable volumes appear; a missing path under one may just be unplugged. */
const MEDIA_ROOTS = ['/Volumes', '/media', '/mnt', '/run/media'];

/** Home, /tmp, /var/tmp and the OS temp dir, as given and with symlinks resolved. */
function defaultLocalRoots(): string[] {
  const roots = new Set<string>();
  for (const r of [homedir(), '/tmp', '/var/tmp', tmpdir()]) {
    roots.add(resolve(r));
    try {
      roots.add(realpathSync(r));
    } catch {
      /* missing root — nothing to add */
    }
  }
  return [...roots];
}

function isMountPoint(dir: string, fs: OriginFs): boolean {
  const parent = dirname(dir);
  if (parent === dir) return true; // filesystem root
  try {
    return fs.dev(dir) !== fs.dev(parent);
  } catch {
    return true; // cannot tell — stay cautious
  }
}

/**
 * True when a recorded project path is gone because it was deleted, not
 * because the volume holding it is unmounted. Walks up to the nearest existing
 * ancestor: when that is the path's own parent (the old rule), a well-known
 * local root (home, /tmp, /var/tmp, the OS temp dir — a tmpfs /tmp is a mount,
 * but its children vanishing means deletion) or a directory on the same device
 * as its own parent, the path was deleted — this covers a whole deleted test
 * root. When it is a mount point (`/`, a network share's mount) or a
 * removable-media directory, the missing piece may be a volume that is not
 * attached right now, so the path is kept.
 */
export function isProvablyDeleted(
  p: string,
  fs: OriginFs = nodeOriginFs,
  localRoots: readonly string[] = defaultLocalRoots(),
): boolean {
  const target = resolve(p);
  if (fs.exists(target)) return false;
  const parent = dirname(target);
  let nearest = parent;
  while (!fs.exists(nearest) && dirname(nearest) !== nearest) nearest = dirname(nearest);
  if (nearest === parent) return true;
  if (localRoots.includes(nearest)) return true;
  if (MEDIA_ROOTS.includes(nearest) || MEDIA_ROOTS.includes(dirname(nearest))) return false;
  return !isMountPoint(nearest, fs);
}
