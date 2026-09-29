// packages/@monomind/cli/src/orgrt/policy-paths.ts
// Split out of policy.ts (file-size sweep) — glob matching, web-domain
// matching, and the real-path helpers PolicyEngine.decide() uses to resolve
// and scope file-tool paths.
import { realpathSync } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';

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
 *  falling back to the lexical path when nothing on it exists. */
export function realPath(p: string): string {
  const rest: string[] = [];
  let cur = p;
  for (;;) {
    try {
      return join(realpathSync(cur), ...rest);
    } catch {
      /* not there — try the parent */
    }
    const parent = dirname(cur);
    if (parent === cur) return p;
    rest.unshift(basename(cur));
    cur = parent;
  }
}

export function safeHost(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}
