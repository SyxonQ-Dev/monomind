// packages/@monomind/cli/src/orgrt/policy-paths.ts
// Split out of policy.ts (file-size sweep) — glob matching, web-domain
// matching, and the real-path helpers PolicyEngine.decide() uses to resolve
// and scope file-tool paths.
import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { probeCase } from './fs-case.js';

const REGEX_METACHARS = new Set('.+^${}()|[]\\'.split(''));

/**
 * tiny glob→RegExp: `**\/` matches zero-or-more leading directories (so
 * `**\/*.md` matches both `README.md` and `docs/README.md`, standard glob
 * semantics), bare `**` matches any depth, `*` matches one path segment.
 */
export function globToRegExp(glob: string, fold: SegmentFold = 'exact'): RegExp {
  let out = '';
  let i = 0;
  while (i < glob.length) {
    if (glob.startsWith('**/', i)) {
      out += '(?:.*/)?';
      i += 3;
      continue;
    }
    if (glob.startsWith('**', i)) {
      out += '.*';
      i += 2;
      continue;
    }
    const c = glob[i];
    if (c === '*') {
      out += '[^/]*';
      i++;
      continue;
    }
    if (REGEX_METACHARS.has(c)) {
      out += `\\${c}`;
      i++;
      continue;
    }
    out += c;
    i++;
  }
  // #496: a grant on a case-insensitive filesystem matches any case.
  return new RegExp(`^${out}$`, fold === 'exact' ? '' : 'i');
}

/** webAllow entry matcher. `*` allows any host (the intuitive "no
 *  restriction" value); `*.example.com` matches the bare domain and every
 *  subdomain; anything else is an exact host or subdomain suffix match. */
export function webDomainMatches(pattern: string, host: string): boolean {
  if (pattern === '*') return true;
  if (pattern.startsWith('*.')) {
    const base = pattern.slice(2);
    return host === base || host.endsWith(`.${base}`);
  }
  return host === pattern || host.endsWith(`.${pattern}`);
}

export const uniq = (xs: string[]): string[] => [...new Set(xs)];

/** #303: is `target` equal to, or nested under, `container`? Both must
 *  already be `realPath()`-resolved — this is a plain string comparison, not
 *  a filesystem check, so a symlink escape must be resolved before this
 *  runs, never lexically. #496: with a `fold` other than `exact` the paths
 *  compare segment by segment through normalizeSegment. */
export function isWithin(container: string, target: string, fold: SegmentFold = 'exact'): boolean {
  if (fold !== 'exact') return segmentsBelow(container, target, process.platform, fold) !== null;
  if (container === target) return true;
  const withSep = container.endsWith(sep) ? container : container + sep;
  return target.startsWith(withSep);
}

/** realpath of `p`, resolving through the nearest EXISTING ancestor when the
 *  target itself doesn't exist yet (a Write into a symlinked directory), and
 *  falling back to the lexical path when nothing on it exists. `.native`
 *  (#498): it returns the on-disk spelling of every existing part — the case
 *  on a case-insensitive filesystem, the long form of a Windows 8.3 name.
 *  A dangling symlink is followed to where a write through it would land. */
export function realPath(p: string): string {
  return resolveReal(p, 0);
}

function resolveReal(p: string, depth: number): string {
  const rest: string[] = [];
  let cur = p;
  for (;;) {
    try {
      return join(realpathSync.native(cur), ...rest);
    } catch {
      /* not there — try the parent */
    }
    try {
      if (depth < 40 && lstatSync(cur).isSymbolicLink())
        return resolveReal(join(resolve(dirname(cur), readlinkSync(cur)), ...rest), depth + 1);
    } catch {
      /* not a link either */
    }
    const parent = dirname(cur);
    if (parent === cur) return p;
    rest.unshift(basename(cur));
    cur = parent;
  }
}

/**
 * #496: how path segments compare.
 *   - `exact`: as written — a case-sensitive filesystem.
 *   - `case`: case-folded — for a GRANT, used only where the filesystem is
 *     known to fold case, so a grant never reaches a different file.
 *   - `deny`: case-folded and Unicode-NFC-normalized (macOS also ignores
 *     NFC/NFD differences) — for a DENY check wherever the filesystem might
 *     fold either, so a case or normalization variant cannot slip past.
 */
export type SegmentFold = 'exact' | 'case' | 'deny';

/** darwin and win32 volumes are case-insensitive by default. */
const platformFolds = (platform: NodeJS.Platform): boolean =>
  platform === 'darwin' || platform === 'win32';

/**
 * #496: the folds for the checks on one resolved path. The filesystem is
 * probed where the path lives (fs-case.ts). Deny checks fold on darwin and
 * win32 whatever the probe says, and anywhere the probe is not sure the
 * filesystem is case-sensitive: they fail closed. Grants fold only where the
 * probe saw the filesystem fold case, so on a case-sensitive one they match
 * exactly as before.
 */
export function pathFolds(
  real: string,
  platform: NodeJS.Platform = process.platform,
): { deny: SegmentFold; allow: SegmentFold } {
  const probed = probeCase(real);
  return {
    deny: platformFolds(platform) || probed !== 'sensitive' ? 'deny' : 'exact',
    allow: probed === 'insensitive' ? 'case' : 'exact',
  };
}

/**
 * #498: the spelling of one path segment as the filesystem compares it,
 * folded as `fold` says (#496; by default case-folded on darwin and win32,
 * which are case-insensitive by default). On win32 a trailing run of dots
 * and spaces and an alternate-data-stream suffix (`bus.jsonl::$DATA`,
 * `x.json:s`) are dropped too, as Windows drops them when it opens the file.
 * A drive segment (`C:`) keeps its colon. Compare segments only after
 * `realPath()`, which already turned any existing part into its on-disk
 * spelling.
 */
export function normalizeSegment(
  seg: string,
  platform: NodeJS.Platform = process.platform,
  fold: SegmentFold = platformFolds(platform) ? 'case' : 'exact',
): string {
  let s = seg;
  if (platform === 'win32' && !/^[a-z]:$/i.test(s)) {
    s = s.replace(/:.*$/s, '');
    if (s !== '.' && s !== '..') s = s.replace(/[. ]+$/, '');
  }
  if (fold === 'deny') s = s.normalize('NFC');
  return fold === 'exact' ? s : s.toLowerCase();
}

/** The normalized segments of an absolute path (see normalizeSegment), with
 *  `.` and `..` collapsed lexically, as `path.resolve()` would. */
export function pathSegments(
  p: string,
  platform: NodeJS.Platform = process.platform,
  fold?: SegmentFold,
): string[] {
  const out: string[] = [];
  for (const raw of p.split(platform === 'win32' ? /[\\/]+/ : /\/+/)) {
    if (!raw) continue;
    const s = normalizeSegment(raw, platform, fold);
    if (s === '.' || s === '') continue;
    if (s === '..') out.pop();
    else out.push(s);
  }
  return out;
}

/** The normalized segments of `target` below `base`, or null when `target`
 *  is not under it (`[]` when they are the same path). Both absolute. */
export function segmentsBelow(
  base: string,
  target: string,
  platform: NodeJS.Platform = process.platform,
  fold?: SegmentFold,
): string[] | null {
  const b = pathSegments(base, platform, fold);
  const t = pathSegments(target, platform, fold);
  if (t.length < b.length || b.some((s, i) => s !== t[i])) return null;
  return t.slice(b.length);
}

/** #496: `a` and `b` name the same path when compared as `fold` says. */
export function samePath(a: string, b: string, fold: SegmentFold = 'exact'): boolean {
  return fold === 'exact' ? a === b : isWithin(a, b, fold) && isWithin(b, a, fold);
}

/**
 * #258: a file-tool write into a `.git` dir that `policy.git` forbids, as the
 * `.git/...` path to name in the denial, or null when it is allowed. `real`
 * is the resolved target; segments compare case-insensitively where the
 * filesystem does (#498, #496: pass `pathFolds(real).deny`), so
 * `.GIT/Config` is `.git/config` on darwin.
 */
export function gitWriteViolation(
  real: string,
  gitLevel: string,
  platform: NodeJS.Platform = process.platform,
  fold?: SegmentFold,
): string | null {
  if (gitLevel === 'push') return null;
  const segments = pathSegments(real, platform, fold);
  const at = segments.lastIndexOf('.git');
  if (at === -1) return null;
  const inGit = segments[at + 1];
  if (gitLevel === 'commit' && inGit !== 'config' && inGit !== 'hooks') return null;
  return segments.slice(at).join('/');
}

export function safeHost(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}
