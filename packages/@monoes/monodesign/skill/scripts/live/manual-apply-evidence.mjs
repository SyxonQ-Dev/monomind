/**
 * Evidence-file and rollback-snapshot helpers for manual-apply.mjs: writing
 * the staged batch to disk for the chat agent to read, collecting the source
 * files a batch touches, and snapshotting/restoring them around an Apply
 * attempt.
 *
 * Split out of manual-apply.mjs. See that file for context.
 */
import fs from 'node:fs';
import path from 'node:path';
import { getLiveDir } from '../lib/monodesign-paths.mjs';

export function writeManualApplyEvidence(eventId, batch, cwd = process.cwd()) {
  const dir = manualApplyEvidenceDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const evidencePath = path.join(dir, `${eventId}.json`);
  fs.writeFileSync(evidencePath, `${JSON.stringify(batch, null, 2)}\n`, 'utf-8');
  return evidencePath;
}

export function manualApplyEvidenceDir(cwd = process.cwd()) {
  return path.join(getLiveDir(cwd), 'manual-edit-evidence');
}

export function normalizeManualApplyEvidencePath(evidencePath, cwd = process.cwd()) {
  if (!evidencePath || typeof evidencePath !== 'string') return null;
  const fullPath = path.isAbsolute(evidencePath) ? evidencePath : path.resolve(cwd, evidencePath);
  const evidenceDir = manualApplyEvidenceDir(cwd);
  const relative = path.relative(evidenceDir, fullPath).split(path.sep).join('/');
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  if (path.extname(relative) !== '.json') return null;
  return fullPath;
}

export function removeManualApplyEvidence(evidencePath, cwd = process.cwd()) {
  const fullPath = normalizeManualApplyEvidencePath(evidencePath, cwd);
  if (!fullPath) return false;
  try {
    fs.unlinkSync(fullPath);
    return true;
  } catch {
    return false;
  }
}

export function collectManualApplyFiles(batch, extraFiles = [], cwd = process.cwd()) {
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
  return [...new Set(files)]
    .map((file) => normalizeProjectFile(file, cwd))
    .filter(Boolean);
}

export function normalizeProjectFile(file, cwd = process.cwd()) {
  if (!file || typeof file !== 'string') return null;
  const absolute = path.isAbsolute(file) ? file : path.resolve(cwd, file);
  const relative = path.relative(cwd, absolute).split(path.sep).join('/');
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return relative;
}

export function rollbackApplySnapshot(
  batch,
  rollbackSnapshot,
  extraFiles = [],
  _reason = 'manual_edit_apply_snapshot_rollback',
  cwd = process.cwd(),
) {
  const scope = collectManualApplyFiles(batch, extraFiles, cwd);
  const rolledBackFiles = [];
  const rollbackFailures = [];
  for (const relativeFile of scope) {
    const before = rollbackSnapshot?.get(relativeFile);
    if (!before) continue;
    const absolute = path.resolve(cwd, relativeFile);
    try {
      if (before.exists) {
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        fs.writeFileSync(absolute, before.content, 'utf-8');
      } else if (fs.existsSync(absolute)) {
        fs.rmSync(absolute);
      }
      rolledBackFiles.push(relativeFile);
    } catch (err) {
      rollbackFailures.push({ file: relativeFile, reason: 'restore_failed', message: err.message || String(err) });
    }
  }
  return { rolledBackFiles, rollbackFailures };
}

export function snapshotApplyEventFiles(batch, cwd = process.cwd()) {
  const snapshot = new Map();
  for (const relativeFile of collectManualApplyFiles(batch, [], cwd)) {
    const absolute = path.resolve(cwd, relativeFile);
    try {
      snapshot.set(relativeFile, {
        exists: fs.existsSync(absolute),
        content: fs.existsSync(absolute) ? fs.readFileSync(absolute, 'utf-8') : '',
      });
    } catch {
      // If a file cannot be read before dispatch, do not attempt late rollback.
    }
  }
  return snapshot;
}
