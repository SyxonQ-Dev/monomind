import fs from 'node:fs';
import path from 'node:path';

const _slugPathCache = new Map();
const _MAX_SLUG_CACHE = 200;

// Inverse of resolveSlugToPath: absolute path -> ~/.claude/projects/<slug>
// dir name. Claude Code's slug replaces every path separator AND the
// Windows drive-letter colon with '-' (e.g. "C:\Users\x" -> "C--Users-x")
// — replacing only '/' leaves Windows paths (all-backslash) completely
// untouched, so every dir= lookup 404s and every project shows 0 sessions.
function pathToSlug(d) {
  return String(d).replace(/[\\/:]/g, '-');
}

function resolveSlugToPath(slug, projDir) {
  if (_slugPathCache.has(slug)) return _slugPathCache.get(slug);
  const resolved = _resolveSlugToPathUncached(slug, projDir);
  if (_slugPathCache.size >= _MAX_SLUG_CACHE) {
    const oldest = _slugPathCache.keys().next().value;
    _slugPathCache.delete(oldest);
  }
  _slugPathCache.set(slug, resolved);
  return resolved;
}

function _resolveSlugToPathUncached(slug, projDir) {
  // 1. Try filesystem BFS (most reliable). Branching is O(2^hyphens) in the
  // worst case (a slug with N hyphens can require exploring both "new path
  // segment" and "hyphen is part of this segment's name" at each of the N
  // positions) — bound total exploration so a slug with many hyphens (e.g.
  // a UUID-embedded temp/scratchpad dir) can't hang the event loop.
  const parts = slug.replace(/^-/, '').split('-');
  const MAX_CALLS = 20000;
  let calls = 0;
  function tryPaths(idx, current) {
    if (++calls > MAX_CALLS) return null;
    if (idx === parts.length) return fs.existsSync(current) ? current : null;
    // Option A: next part is a new path component
    const asDir = path.join(current, parts[idx]);
    const r1 = tryPaths(idx + 1, asDir);
    if (r1) return r1;
    // Option B: combine with hyphen into current basename
    if (current !== '/') {
      const combined = path.join(path.dirname(current), `${path.basename(current)}-${parts[idx]}`);
      const r2 = tryPaths(idx + 1, combined);
      if (r2) return r2;
    }
    return null;
  }
  const fsResolved = parts.length ? tryPaths(1, `/${parts[0]}`) : null;
  if (fsResolved) return fsResolved;

  // 2. Try reading cwd from a session file
  try {
    const sfiles = fs
      .readdirSync(projDir)
      .filter((f) => f.endsWith('.jsonl') && !f.startsWith('._'));
    for (const sf of sfiles) {
      try {
        const line = fs
          .readFileSync(path.join(projDir, sf), 'utf-8')
          .split('\n')
          .find((l) => l.includes('"cwd"'));
        if (line) {
          const m = line.match(/"cwd"\s*:\s*"([^"]+)"/);
          // m[1] is the raw JSON-escaped text between the quotes (e.g. a
          // Windows path's backslashes still escaped as \\) — unescape it
          // properly instead of returning the escaped literal.
          if (m?.[1]) {
            try {
              return JSON.parse(`"${m[1]}"`);
            } catch {
              return m[1];
            }
          }
        }
      } catch {}
    }
  } catch {}

  // 3. Dumb fallback (known-broken for hyphenated dirs, but last resort)
  return slug.replace(/-/g, '/');
}

export { pathToSlug, resolveSlugToPath };
