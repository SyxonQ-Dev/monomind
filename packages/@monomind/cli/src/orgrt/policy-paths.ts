// packages/@monomind/cli/src/orgrt/policy-paths.ts
// Split out of policy.ts (file-size sweep) — glob matching, web-domain
// matching, and the real-path helpers PolicyEngine.decide() uses to resolve
// and scope file-tool paths.
import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';

const REGEX_METACHARS = new Set('.+^${}()|[]\\'.split(''));

/**
 * tiny glob→RegExp: `**\/` matches zero-or-more leading directories (so
 * `**\/*.md` matches both `README.md` and `docs/README.md`, standard glob
 * semantics), bare `**` matches any depth, `*` matches one path segment.
 */
export function globToRegExp(glob: string): RegExp {
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
  return new RegExp(`^${out}$`);
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
 *  runs, never lexically. */
export function isWithin(container: string, target: string): boolean {
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
 * #498: the spelling of one path segment as the filesystem compares it. On
 * darwin and win32 (case-insensitive by default) it is lower-cased; on win32
 * a trailing run of dots and spaces and an alternate-data-stream suffix
 * (`bus.jsonl::$DATA`, `x.json:s`) are dropped too, as Windows drops them
 * when it opens the file. A drive segment (`C:`) keeps its colon. Compare
 * segments only after `realPath()`, which already turned any existing part
 * into its on-disk spelling (#496 can reuse this for the policy's globs).
 */
export function normalizeSegment(
  seg: string,
  platform: NodeJS.Platform = process.platform,
): string {
  let s = seg;
  if (platform === 'win32' && !/^[a-z]:$/i.test(s)) {
    s = s.replace(/:.*$/s, '');
    if (s !== '.' && s !== '..') s = s.replace(/[. ]+$/, '');
  }
  return platform === 'darwin' || platform === 'win32' ? s.toLowerCase() : s;
}

/** The normalized segments of an absolute path (see normalizeSegment), with
 *  `.` and `..` collapsed lexically, as `path.resolve()` would. */
export function pathSegments(p: string, platform: NodeJS.Platform = process.platform): string[] {
  const out: string[] = [];
  for (const raw of p.split(platform === 'win32' ? /[\\/]+/ : /\/+/)) {
    if (!raw) continue;
    const s = normalizeSegment(raw, platform);
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
): string[] | null {
  const b = pathSegments(base, platform);
  const t = pathSegments(target, platform);
  if (t.length < b.length || b.some((s, i) => s !== t[i])) return null;
  return t.slice(b.length);
}

/**
 * #258: a file-tool write into a `.git` dir that `policy.git` forbids, as the
 * `.git/...` path to name in the denial, or null when it is allowed. `real`
 * is the resolved target; segments compare case-insensitively where the
 * filesystem does (#498), so `.GIT/Config` is `.git/config` on darwin.
 */
export function gitWriteViolation(
  real: string,
  gitLevel: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (gitLevel === 'push') return null;
  const segments = pathSegments(real, platform);
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
