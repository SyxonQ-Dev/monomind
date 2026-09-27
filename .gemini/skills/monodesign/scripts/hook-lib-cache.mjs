import fs from 'node:fs';
import path from 'node:path';
import { MONODESIGN_COMMAND } from './lib/provider.mjs';
import { ENVELOPE_PREFIX, HOOK_LOCAL_IGNORE_PATTERNS, EDIT_COUNT_THRESHOLD, safeReadJson, getCachePath } from './hook-lib-config.mjs';

const HOOK_IGNORE_MARKER_OPEN = '# monodesign-hook-ignore-start';
const HOOK_IGNORE_MARKER_CLOSE = '# monodesign-hook-ignore-end';
const CACHE_MAX_SESSIONS = 8;

export function readCache(cwd) {
  const raw = safeReadJson(getCachePath(cwd));
  if (!raw || typeof raw !== 'object' || raw.version !== 1) {
    return { version: 1, sessions: {} };
  }
  return {
    version: 1,
    sessions: raw.sessions && typeof raw.sessions === 'object' ? raw.sessions : {},
  };
}

export function persistCache(cwd, cache) {
  const sessions = cache.sessions || {};
  const ids = Object.keys(sessions);
  if (ids.length > CACHE_MAX_SESSIONS) {
    // Garbage-collect oldest sessions by updatedAt.
    const ordered = ids
      .map((id) => [id, sessions[id]?.updatedAt || 0])
      .sort((a, b) => b[1] - a[1])
      .slice(0, CACHE_MAX_SESSIONS);
    const next = {};
    for (const [id] of ordered) next[id] = sessions[id];
    cache = { ...cache, sessions: next };
  }
  const target = getCachePath(cwd);
  try {
    ensureHookGitExcludes(cwd);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(cache));
    return true;
  } catch {
    return false;
  }
}

export function ensureHookGitExcludes(cwd = process.cwd()) {
  try {
    const target = resolveHookGitExcludeTarget(cwd);
    if (!target) {
      return { mode: 'none', changed: false, patterns: [...HOOK_LOCAL_IGNORE_PATTERNS] };
    }

    const patterns = target.patternPrefix
      ? HOOK_LOCAL_IGNORE_PATTERNS.map((pattern) => `${target.patternPrefix}/${pattern}`)
      : [...HOOK_LOCAL_IGNORE_PATTERNS];
    const markerSuffix = target.patternPrefix || '.';
    const markerOpen = `${HOOK_IGNORE_MARKER_OPEN} ${markerSuffix}`;
    const markerClose = `${HOOK_IGNORE_MARKER_CLOSE} ${markerSuffix}`;
    const existing = fs.existsSync(target.path) ? fs.readFileSync(target.path, 'utf-8') : '';
    const block = [markerOpen, ...patterns, markerClose].join('\n');
    const markerRe = new RegExp(`${escapeRegExp(markerOpen)}[\\s\\S]*?${escapeRegExp(markerClose)}`);

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
      mode: 'git-info-exclude',
      file: path.relative(path.resolve(cwd), target.path).split(path.sep).join('/'),
      changed: updated !== existing,
      patterns,
    };
  } catch {
    return { mode: 'error', changed: false, patterns: [...HOOK_LOCAL_IGNORE_PATTERNS] };
  }
}

function resolveHookGitExcludeTarget(cwd) {
  const start = path.resolve(cwd);
  let dir = start;
  while (true) {
    const dotGit = path.join(dir, '.git');
    if (fs.existsSync(dotGit)) {
      const gitDir = resolveGitDir(dotGit, dir);
      if (!gitDir) return null;
      const relPrefix = path.relative(dir, start).split(path.sep).join('/');
      return {
        path: path.join(gitDir, 'info', 'exclude'),
        patternPrefix: relPrefix && relPrefix !== '.' ? relPrefix : '',
      };
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function resolveGitDir(dotGit, worktreeDir) {
  const stat = fs.statSync(dotGit);
  if (stat.isDirectory()) return dotGit;
  if (!stat.isFile()) return null;

  const body = fs.readFileSync(dotGit, 'utf-8').trim();
  const match = body.match(/^gitdir:\s*(.+)$/i);
  if (!match) return null;
  return path.isAbsolute(match[1]) ? match[1] : path.resolve(worktreeDir, match[1]);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function ensureSession(cache, sessionId) {
  if (!cache.sessions[sessionId]) {
    cache.sessions[sessionId] = { updatedAt: Date.now(), files: {} };
  }
  return cache.sessions[sessionId];
}

export function ensureFile(cache, sessionId, filePath) {
  const session = ensureSession(cache, sessionId);
  if (!session.files[filePath]) {
    session.files[filePath] = { editCount: 0, findings: [] };
  }
  return session.files[filePath];
}

export function bumpEditCount(cache, sessionId, filePath) {
  const fileEntry = ensureFile(cache, sessionId, filePath);
  fileEntry.editCount = (fileEntry.editCount || 0) + 1;
  ensureSession(cache, sessionId).updatedAt = Date.now();
  return fileEntry.editCount;
}

export function suppressionNotice(filePath) {
  return `${ENVELOPE_PREFIX} Suppressing further design hints on ${filePath}. More than ${EDIT_COUNT_THRESHOLD} edits in this session reached. Run ${MONODESIGN_COMMAND} audit to revisit.`;
}
