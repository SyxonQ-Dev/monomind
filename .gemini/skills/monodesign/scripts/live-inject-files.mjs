// Config file resolution (glob expansion + exclude filtering) and the
// project .gitignore / git info-exclude management for monodesign-live's
// own runtime files. Split out of live-inject.mjs (file-size sweep — pure
// move, no behaviour change).

import fs from 'node:fs';
import path from 'node:path';

const IGNORE_MARKER_OPEN = '# monodesign-live-ignore-start';
const IGNORE_MARKER_CLOSE = '# monodesign-live-ignore-end';

export const LIVE_IGNORE_PATTERNS = Object.freeze([
  '.monodesign/hook.cache.json',
  '.monodesign/hook.pending.json',
  '.monodesign/config.local.json',
  '.monodesign/live/server.json',
  '.monodesign/live/sessions/',
  '.monodesign/live/previews/',
  '.monodesign/live/annotations/',
  '.monodesign/live/cache/',
  '.monodesign/live/manual-edit-apply-transaction.json',
  '.monodesign/live/manual-edit-events.jsonl',
  '.monodesign/live/manual-edit-evidence/',
  '.monodesign/live/pending-manual-edits.json',
  '.monodesign/live/deferred-svelte-component-accepts.json',
  '.monodesign-live.json',
  '.monodesign-live/',
  'node_modules/.monodesign-live/',
  'src/lib/monodesign/MonodesignLiveRoot.svelte',
  'src/lib/monodesign/__runtime.js',
  'src/lib/monodesign/[0-9a-f]*/',
]);

/**
 * Hard-excluded directory patterns. These are NEVER user-facing pages and
 * matching them would silently inject tracking scripts into third-party
 * code. The user cannot turn these off via config — they are the floor.
 */
const HARD_EXCLUDES = [
  '**/node_modules/**',
  '**/.git/**',
];

export function ensureLiveGitIgnores(cwd = process.cwd()) {
  const target = resolveIgnoreTarget(cwd);
  const existing = fs.existsSync(target.path) ? fs.readFileSync(target.path, 'utf-8') : '';
  const block = [
    IGNORE_MARKER_OPEN,
    ...LIVE_IGNORE_PATTERNS,
    IGNORE_MARKER_CLOSE,
  ].join('\n');
  const markerRe = new RegExp(`${escapeRegExp(IGNORE_MARKER_OPEN)}[\\s\\S]*?${escapeRegExp(IGNORE_MARKER_CLOSE)}`);

  let updated;
  if (markerRe.test(existing)) {
    updated = existing.replace(markerRe, block);
  } else {
    const prefix = existing.length === 0 ? '' : existing.endsWith('\n') ? existing : `${existing}\n`;
    updated = `${prefix}${prefix.endsWith('\n\n') || prefix === '' ? '' : '\n'}${block}\n`;
  }

  if (updated !== existing) {
    fs.mkdirSync(path.dirname(target.path), { recursive: true });
    fs.writeFileSync(target.path, updated, 'utf-8');
  }

  return {
    file: path.relative(cwd, target.path).split(path.sep).join('/'),
    mode: target.mode,
    changed: updated !== existing,
    patterns: [...LIVE_IGNORE_PATTERNS],
  };
}

function resolveIgnoreTarget(cwd) {
  const gitExcludePath = resolveGitInfoExcludePath(cwd);
  if (gitExcludePath) {
    return { path: gitExcludePath, mode: 'git-info-exclude' };
  }
  return { path: path.join(cwd, '.gitignore'), mode: 'gitignore' };
}

function resolveGitInfoExcludePath(cwd) {
  const dotGit = path.join(cwd, '.git');
  if (!fs.existsSync(dotGit)) return null;

  const stat = fs.statSync(dotGit);
  if (stat.isDirectory()) return path.join(dotGit, 'info', 'exclude');
  if (!stat.isFile()) return null;

  const body = fs.readFileSync(dotGit, 'utf-8').trim();
  const match = body.match(/^gitdir:\s*(.+)$/i);
  if (!match) return null;
  const gitDir = path.isAbsolute(match[1]) ? match[1] : path.resolve(cwd, match[1]);
  return path.join(gitDir, 'info', 'exclude');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Expand config.files (which may contain glob patterns) into a literal list
 * of existing file paths relative to rootDir. Literal entries pass through;
 * glob patterns are expanded via fs.globSync. HARD_EXCLUDES and config.exclude
 * are applied as filters. Duplicates are removed. Order is preserved by
 * first appearance.
 */
export function resolveFiles(rootDir, config) {
  const patterns = config.files;
  const userExcludes = Array.isArray(config.exclude) ? config.exclude : [];
  const allExcludes = [...HARD_EXCLUDES, ...userExcludes];
  const excludeRegexes = allExcludes.map(globToRegex);

  const isExcluded = (relPath) => excludeRegexes.some((re) => re.test(relPath));
  const isGlob = (s) => /[*?[]/.test(s);

  const seen = new Set();
  const out = [];
  for (const pat of patterns) {
    if (!isGlob(pat)) {
      // Literal path — include even if it doesn't exist yet; the caller
      // reports file_not_found per-entry. Exclude list doesn't apply to
      // explicit literal entries (user named it on purpose).
      if (!seen.has(pat)) {
        seen.add(pat);
        out.push(pat);
      }
      continue;
    }
    let matches;
    try {
      matches = fs.globSync(pat, { cwd: rootDir, withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of matches) {
      if (!ent.isFile?.()) continue;
      const abs = path.join(ent.parentPath || ent.path || rootDir, ent.name);
      const rel = path.relative(rootDir, abs).split(path.sep).join('/');
      if (isExcluded(rel)) continue;
      if (seen.has(rel)) continue;
      seen.add(rel);
      out.push(rel);
    }
  }
  return out;
}

/**
 * Convert a glob pattern to a RegExp. Supports:
 *   **  → any number of path segments (including zero)
 *   *   → any chars except `/`
 *   ?   → any single char except `/`
 * Paths are normalized to forward slashes before matching.
 */
function globToRegex(pattern) {
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // ** — any number of segments, including zero. Handle the common
        // **/ and /** forms so `a/**/b` matches `a/b` as well as `a/x/y/b`.
        if (pattern[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 3;
        } else {
          re += '.*';
          i += 2;
        }
      } else {
        re += '[^/]*';
        i += 1;
      }
    } else if (c === '?') {
      re += '[^/]';
      i += 1;
    } else if (/[.+^${}()|[\]\\]/.test(c)) {
      re += `\\${c}`;
      i += 1;
    } else {
      re += c;
      i += 1;
    }
  }
  return new RegExp(`^${re}$`);
}

// ---------------------------------------------------------------------------
// Core operations
// ---------------------------------------------------------------------------

function validateConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') throw new Error('config.json must be an object');
  if (!Array.isArray(cfg.files) || cfg.files.length === 0) {
    throw new Error('config.files (non-empty string array) required');
  }
  if (!cfg.files.every((f) => typeof f === 'string' && f.length > 0)) {
    throw new Error('config.files must contain only non-empty strings');
  }
  if (cfg.exclude !== undefined) {
    if (!Array.isArray(cfg.exclude)) {
      throw new Error('config.exclude, if present, must be a string array');
    }
    if (!cfg.exclude.every((f) => typeof f === 'string' && f.length > 0)) {
      throw new Error('config.exclude must contain only non-empty strings');
    }
  }
  if (typeof cfg.insertBefore !== 'string' && typeof cfg.insertAfter !== 'string') {
    throw new Error('config.insertBefore or config.insertAfter (string) required');
  }
  if (cfg.commentSyntax !== 'html' && cfg.commentSyntax !== 'jsx') {
    throw new Error("config.commentSyntax must be 'html' or 'jsx'");
  }
  if (cfg.cspChecked !== undefined && typeof cfg.cspChecked !== 'boolean') {
    throw new Error("config.cspChecked, if present, must be a boolean");
  }
}


export {
  resolveIgnoreTarget,
  resolveGitInfoExcludePath,
  escapeRegExp,
  globToRegex,
  validateConfig,
};
