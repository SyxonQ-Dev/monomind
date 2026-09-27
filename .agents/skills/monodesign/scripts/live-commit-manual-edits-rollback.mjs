/**
 * Filesystem snapshot/rollback helpers for live-commit-manual-edits.mjs:
 * scanning candidate rollback files, snapshotting their content, detecting
 * what changed, and restoring them when an apply attempt must be undone.
 *
 * Split out of live-commit-manual-edits.mjs. See that file for context.
 */

import { isGeneratedFile } from './lib/is-generated.mjs';
import { readBuffer, writeBuffer } from './live/manual-edits-buffer.mjs';
import { uniqueStrings } from './live-commit-manual-edits-utils.mjs';
import { normalizeRollbackPath } from './live-commit-manual-edits-paths.mjs';
import fs from 'node:fs';
import path from 'node:path';

const ROLLBACK_EXTENSIONS = new Set([
  '.astro',
  '.cjs',
  '.css',
  '.htm',
  '.html',
  '.js',
  '.json',
  '.jsx',
  '.md',
  '.mdx',
  '.mjs',
  '.scss',
  '.svelte',
  '.svg',
  '.ts',
  '.tsx',
  '.txt',
  '.vue',
  '.yaml',
  '.yml',
]);
const ROLLBACK_SKIP_DIRS = new Set([
  '.astro',
  '.git',
  '.monodesign',
  '.next',
  '.nuxt',
  '.svelte-kit',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
]);

export function clearAppliedEntries(cwd, appliedEntryIds) {
  const ids = new Set(appliedEntryIds);
  if (ids.size === 0) return 0;
  const buffer = readBuffer(cwd);
  let cleared = 0;
  const kept = [];
  for (const entry of buffer.entries || []) {
    if (ids.has(entry.id)) {
      cleared += Array.isArray(entry.ops) ? entry.ops.length : 0;
    } else {
      kept.push(entry);
    }
  }
  writeBuffer(cwd, { version: buffer.version || 1, entries: kept });
  return cleared;
}

export function snapshotRollbackFiles(cwd, files = null) {
  const snapshot = new Map();
  const rollbackFiles = Array.isArray(files) && files.length > 0
    ? uniqueStrings(files).map((file) => normalizeRollbackPath(cwd, file)).filter(Boolean)
    : collectRollbackFiles(cwd);
  for (const relativeFile of rollbackFiles) {
    const absolute = path.resolve(cwd, relativeFile);
    try {
      snapshot.set(relativeFile, {
        existed: true,
        content: fs.readFileSync(absolute, 'utf-8'),
      });
    } catch (err) {
      if (err?.code === 'ENOENT') {
        snapshot.set(relativeFile, { existed: false });
      }
      // Other read failures are not safe to roll back.
    }
  }
  return snapshot;
}

function collectRollbackFiles(cwd) {
  const out = [];
  const seenDirs = new Set();
  const seenFiles = new Set();
  scanRollbackDir(cwd, cwd, out, seenDirs, seenFiles, 0);
  return out;
}

function scanRollbackDir(dir, cwd, out, seenDirs, seenFiles, depth) {
  if (depth > 10) return;
  let realDir;
  try { realDir = fs.realpathSync(dir); } catch { return; }
  if (seenDirs.has(realDir)) return;
  seenDirs.add(realDir);

  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (ROLLBACK_SKIP_DIRS.has(entry.name)) continue;
      scanRollbackDir(path.join(dir, entry.name), cwd, out, seenDirs, seenFiles, depth + 1);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!ROLLBACK_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
    const absolute = path.join(dir, entry.name);
    if (isGeneratedFile(absolute, { cwd })) continue;
    let realFile;
    try { realFile = fs.realpathSync(absolute); } catch { continue; }
    if (seenFiles.has(realFile)) continue;
    seenFiles.add(realFile);
    const relative = path.relative(cwd, absolute).split(path.sep).join('/');
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue;
    out.push(relative);
  }
}

function changedFilesSinceSnapshot(cwd, snapshot, scopeFiles = null) {
  const changed = new Map();
  const scopedFiles = Array.isArray(scopeFiles) && scopeFiles.length > 0
    ? scopeFiles.map((file) => normalizeRollbackPath(cwd, file)).filter(Boolean)
    : null;
  const currentFiles = new Set(scopedFiles || collectRollbackFiles(cwd));
  for (const [relativeFile, before] of snapshot.entries()) {
    if (scopedFiles && !currentFiles.has(relativeFile)) continue;
    const absolute = path.resolve(cwd, relativeFile);
    if (before?.existed === false) {
      if (fs.existsSync(absolute)) changed.set(relativeFile, { file: relativeFile, kind: 'added' });
      continue;
    }
    if (!fs.existsSync(absolute)) {
      changed.set(relativeFile, { file: relativeFile, kind: 'deleted' });
      continue;
    }
    let content;
    try { content = fs.readFileSync(absolute, 'utf-8'); } catch { continue; }
    if (content !== before.content) {
      changed.set(relativeFile, { file: relativeFile, kind: 'modified' });
    }
  }
  for (const relativeFile of currentFiles) {
    if (!snapshot.has(relativeFile)) {
      changed.set(relativeFile, { file: relativeFile, kind: 'unknown' });
    }
  }
  return [...changed.values()];
}

export function rollbackChangedFiles(cwd, snapshot, extraFiles = [], scopeFiles = []) {
  const scope = new Set(
    [...(scopeFiles || []), ...(extraFiles || [])]
      .map((file) => normalizeRollbackPath(cwd, file))
      .filter(Boolean),
  );
  const changed = changedFilesSinceSnapshot(cwd, snapshot, [...scope]);
  const byFile = new Map(changed.map((item) => [item.file, item]));
  for (const file of extraFiles || []) {
    const relative = normalizeRollbackPath(cwd, file);
    if (relative && !byFile.has(relative)) {
      byFile.set(relative, { file: relative, kind: snapshot.has(relative) ? 'reported' : 'unknown' });
    }
  }

  const rolledBackFiles = [];
  const rollbackFailures = [];
  for (const item of byFile.values()) {
    if (!scope.has(item.file)) continue;
    const absolute = path.resolve(cwd, item.file);
    const before = snapshot.get(item.file);
    try {
      if (before?.existed !== false && typeof before?.content === 'string') {
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        fs.writeFileSync(absolute, before.content, 'utf-8');
      } else if (before?.existed === false && item.kind === 'added' && fs.existsSync(absolute)) {
        fs.rmSync(absolute);
      } else {
        rollbackFailures.push({ file: item.file, reason: 'no_snapshot' });
        continue;
      }
      rolledBackFiles.push(item.file);
    } catch (err) {
      rollbackFailures.push({ file: item.file, reason: 'restore_failed', message: err.message || String(err) });
    }
  }
  return { rolledBackFiles, rollbackFailures };
}

export function collectApplyOwnedFiles(batch, cwd, extraFiles = []) {
  const files = [];
  for (const entry of batch?.entries || []) {
    for (const op of entry.ops || []) files.push(op.sourceHint?.file);
  }
  for (const candidate of batch?.candidates || []) {
    files.push(candidate.sourceHint?.relativeFile, candidate.sourceHint?.file);
    for (const item of candidate.textMatches || []) files.push(item.file);
    for (const item of candidate.objectKeyMatches || []) files.push(item.file);
    for (const item of candidate.locatorMatches || []) files.push(item.file);
    for (const item of candidate.contextTextMatches || []) files.push(item.file);
  }
  files.push(...(extraFiles || []));
  return uniqueStrings(files)
    .map((file) => normalizeRollbackPath(cwd, file))
    .filter(Boolean);
}

export function unreportedChangedFiles(cwd, snapshot, reportedFiles, scopeFiles = []) {
  const reported = new Set(
    (reportedFiles || [])
      .map((file) => normalizeRollbackPath(cwd, file))
      .filter(Boolean),
  );
  const scope = new Set(
    (scopeFiles || [])
      .map((file) => normalizeRollbackPath(cwd, file))
      .filter(Boolean),
  );
  return changedFilesSinceSnapshot(cwd, snapshot, [...scope])
    .map((item) => item.file)
    .filter((file) => scope.has(file))
    .filter((file) => !reported.has(file));
}
