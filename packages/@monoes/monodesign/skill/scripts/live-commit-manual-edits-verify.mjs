/**
 * Source-verification helpers for live-commit-manual-edits.mjs: checking
 * whether a staged copy-edit op's newText actually landed in a plausible
 * source location, and rolling that up per entry.
 *
 * Split out of live-commit-manual-edits.mjs. See that file for context.
 */

import { candidatesForEntry, uniqueStrings } from './live-commit-manual-edits-utils.mjs';
import { normalizeRelativeFile } from './live-commit-manual-edits-paths.mjs';
import fs from 'node:fs';
import path from 'node:path';

function sourceHintWindowFailure(cwd, op) {
  const hint = op?.sourceHint;
  if (!hint?.file || !hint.line) return null;
  const relative = normalizeRelativeFile(cwd, hint.file);
  if (!relative) return null;
  const absolute = path.resolve(cwd, relative);
  let content;
  try { content = fs.readFileSync(absolute, 'utf-8'); } catch { return null; }
  const lines = content.split('\n');
  const line = Math.max(1, Number(hint.line) || 1);
  const lineText = lines[line - 1] || '';
  const start = Math.max(0, line - 5);
  const end = Math.min(lines.length, line + 4);
  if (
    typeof op.originalText === 'string'
    && op.originalText
    && lineText.includes(op.originalText)
    && !lineShowsAppliedOp(lineText, op)
  ) {
    return {
      file: relative,
      line,
      reason: 'source_hint_still_contains_original_text',
    };
  }
  if (lines.slice(start, end).some((candidateLine) => lineShowsAppliedOp(candidateLine, op))) return null;
  return null;
}

function verificationTargetsForOp(batch, op, reportedFiles, cwd) {
  const candidate = (batch.candidates || []).find((item) => item.entryId === op.entryId && item.ref === op.ref);
  const out = [];
  const reportedFileSet = new Set(reportedFiles || []);
  const add = (file, line, kind) => {
    const relativeFile = normalizeRelativeFile(cwd, file);
    const lineNumber = Number(line);
    if (!relativeFile || !Number.isFinite(lineNumber) || lineNumber < 1) return;
    out.push({ file: relativeFile, line: lineNumber, kind, reported: reportedFileSet.has(relativeFile) });
  };

  add(op.sourceHint?.file, op.sourceHint?.line, 'source_hint');
  add(candidate?.sourceHint?.relativeFile || candidate?.sourceHint?.file, candidate?.sourceHint?.line, 'candidate_source_hint');
  for (const item of candidate?.textMatches || []) add(item.file, item.line, 'text_match');
  for (const item of candidate?.objectKeyMatches || []) add(item.file, item.line, 'object_key_match');
  for (const item of candidate?.locatorMatches || []) add(item.file, item.line, 'locator_match');
  for (const item of candidate?.contextTextMatches || []) add(item.file, item.line, 'context_text_match');

  // Manual copy edits often stage coupled leaves from the same UI object, e.g.
  // a card label plus its count. Dynamic source stores both on the label/key
  // line, so the count op may need the sibling label's data candidates.
  for (const siblingCandidate of siblingCandidatesForEntry(batch, op)) {
    add(siblingCandidate.sourceHint?.relativeFile || siblingCandidate.sourceHint?.file, siblingCandidate.sourceHint?.line, 'entry_source_hint');
    for (const item of siblingCandidate.textMatches || []) add(item.file, item.line, 'entry_text_match');
    for (const item of siblingCandidate.objectKeyMatches || []) add(item.file, item.line, 'entry_object_key_match');
    for (const item of siblingCandidate.contextTextMatches || []) add(item.file, item.line, 'entry_context_text_match');
  }

  for (const relativeFile of reportedFiles || []) {
    for (const target of locatorTargetsInFile(cwd, relativeFile, op)) {
      out.push(target);
    }
  }

  const seen = new Set();
  return out.filter((target) => {
    const key = `${target.file}:${target.line}:${target.kind}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function objectKeyCandidatesForOp(batch, op) {
  const candidates = (batch.candidates || [])
    .filter((item) => item.entryId === op.entryId && item.ref === op.ref);
  return candidates.flatMap((candidate) => candidate.objectKeyMatches || []);
}

function lineHasObjectKey(line, text) {
  if (typeof text !== 'string' || text.length === 0) return false;
  const quotedKey = new RegExp(`(^|[\\s,{])(['"\`])${escapeRegExp(text)}\\2\\s*:`);
  if (quotedKey.test(line)) return true;
  const identifierSafe = /^[A-Za-z_$][\w$]*$/.test(text);
  if (!identifierSafe) return false;
  const bareKey = new RegExp(`(^|[\\s,{])${escapeRegExp(text)}\\s*:`);
  return bareKey.test(line);
}

function objectKeyMatchStillUsesOriginal(cwd, match, op) {
  const relative = normalizeRelativeFile(cwd, match?.file);
  const lineNumber = Number(match?.line);
  if (!relative || !Number.isFinite(lineNumber) || lineNumber < 1) return false;
  let lines;
  try { lines = fs.readFileSync(path.resolve(cwd, relative), 'utf-8').split('\n'); } catch { return false; }
  const start = Math.max(0, lineNumber - 4);
  const end = Math.min(lines.length, lineNumber + 3);
  const windowLines = lines.slice(start, end);
  if (windowLines.some((line) => lineHasObjectKey(line, op.newText))) return false;
  return windowLines.some((line) => lineHasObjectKey(line, op.originalText));
}

function coupledObjectKeyFailuresForOp(batch, op, cwd) {
  if (
    typeof op?.originalText !== 'string'
    || typeof op?.newText !== 'string'
    || op.originalText === op.newText
  ) return [];
  return objectKeyCandidatesForOp(batch, op)
    .filter((match) => objectKeyMatchStillUsesOriginal(cwd, match, op))
    .map((match) => ({
      ref: op.ref,
      reason: 'source_verification_failed',
      detail: 'edited_text_source_key_dependency_not_updated',
      candidates: [{
        file: normalizeRelativeFile(cwd, match.file) || match.file,
        line: match.line,
        kind: 'object_key_match',
        reason: 'edited text is also a source key; update the coupled key to newText or fail the entry',
      }],
    }));
}

function siblingCandidatesForEntry(batch, op) {
  if (!op?.entryId) return [];
  return (batch.candidates || []).filter((item) => item.entryId === op.entryId && item.ref !== op.ref);
}

function locatorTargetsInFile(cwd, relativeFile, op) {
  if (!opHasLocator(op)) return [];
  const absolute = path.resolve(cwd, relativeFile);
  let lines;
  try { lines = fs.readFileSync(absolute, 'utf-8').split('\n'); } catch { return []; }
  const out = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!lineMatchesManualEditLocator(lines[index], op)) continue;
    out.push({ file: relativeFile, line: index + 1, kind: 'reported_locator_match' });
    if (out.length >= 20) break;
  }
  return out;
}

function verificationTargetPasses(cwd, target, op) {
  let lines;
  try { lines = fs.readFileSync(path.resolve(cwd, target.file), 'utf-8').split('\n'); } catch { return false; }
  return verificationTargetPassesLines(lines, target, op);
}

function verificationTargetPassesLines(lines, target, op) {
  const line = lines[target.line - 1] || '';
  if (lineShowsAppliedOp(line, op)) return true;
  const originalText = typeof op?.originalText === 'string' ? op.originalText : '';
  if (originalText && line.includes(originalText)) return false;
  const kind = String(target.kind || '');
  const canSearchWindow = target.reported
    || kind.includes('context_text_match')
    || kind.includes('object_key_match')
    || kind.includes('text_match');
  if (!canSearchWindow) return false;
  const radius = kind.includes('context_text_match') ? 20 : 4;
  const start = Math.max(0, target.line - radius - 1);
  const end = Math.min(lines.length, target.line + radius);
  const windowLines = lines.slice(start, end);
  if (windowLines.some((candidateLine) => lineShowsAppliedOp(candidateLine, op))) return true;
  if (windowShowsAppliedOp(windowLines, op)) return true;
  return false;
}

function windowShowsAppliedOp(lines, op) {
  const newText = typeof op?.newText === 'string' ? op.newText : '';
  if (!newText) return false;
  const originalText = typeof op?.originalText === 'string' ? op.originalText : '';
  const normalizedNew = normalizeVerificationText(newText);
  const normalizedOriginal = normalizeVerificationText(originalText);
  const normalizedWindow = normalizeVerificationText(lines.join('\n'));
  if (!normalizedNew || !normalizedWindow.includes(normalizedNew)) return false;
  if (normalizedOriginal && !normalizedNew.includes(normalizedOriginal) && normalizedWindow.includes(normalizedOriginal)) return false;
  return true;
}

function normalizeVerificationText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function lineShowsAppliedOp(line, op) {
  const originalText = typeof op?.originalText === 'string' ? op.originalText : '';
  const newText = typeof op?.newText === 'string' ? op.newText : '';
  const deletion = op?.deleted === true || newText.length === 0;
  if (deletion) return !!originalText && !line.includes(originalText);
  if (!line.includes(newText)) return false;
  if (originalText && !newText.includes(originalText) && line.includes(originalText)) return false;
  return true;
}

function opHasLocator(op) {
  return !!(
    op?.tag
    || op?.elementId
    || (Array.isArray(op?.classes) && op.classes.filter(Boolean).length > 0)
  );
}

function lineMatchesManualEditLocator(line, op) {
  if (op.tag) {
    const tagRe = new RegExp(`<\\s*${escapeRegExp(op.tag)}(?=[\\s>/]|$)`, 'i');
    if (!tagRe.test(line)) return false;
  }

  if (op.elementId) {
    const idRe = new RegExp(`\\bid\\s*=\\s*["']${escapeRegExp(op.elementId)}["']`);
    if (!idRe.test(line)) return false;
  }

  const classes = Array.isArray(op.classes) ? op.classes.filter(Boolean) : [];
  for (const className of classes) {
    if (!line.includes(className)) return false;
  }

  return true;
}

export function verifyAppliedEntry({ batch, entry, reportedFiles, cwd }) {
  const failures = [];
  for (const rawOp of entry.ops || []) {
    const op = { ...rawOp, entryId: entry.id };
    if (op.deleted === true && typeof op.newText !== 'string') op.newText = '';
    if (typeof op.newText !== 'string') {
      failures.push({
        ref: op.ref,
        reason: 'source_verification_failed',
        detail: 'missing_newText',
        candidates: candidatesForEntry(batch, entry.id).slice(0, 12),
      });
      continue;
    }
    const targets = verificationTargetsForOp(batch, op, reportedFiles, cwd);
    const coupledObjectKeyFailures = coupledObjectKeyFailuresForOp(batch, op, cwd);
    if (
      coupledObjectKeyFailures.length === 0
      && targets.some((target) => verificationTargetPasses(cwd, target, op))
    ) continue;

    if (coupledObjectKeyFailures.length > 0) {
      failures.push(...coupledObjectKeyFailures.map((failure) => ({
        ...failure,
        candidates: [
          ...(failure.candidates || []),
          ...targets.map((target) => ({ file: target.file, line: target.line, kind: target.kind })),
          ...candidatesForEntry(batch, entry.id),
        ].slice(0, 12),
      })));
      continue;
    }

    const hintedOldText = sourceHintWindowFailure(cwd, op);
    if (hintedOldText) {
      failures.push({
        ref: op.ref,
        reason: 'source_verification_failed',
        detail: hintedOldText.reason,
        candidates: [hintedOldText, ...targets.map((target) => ({ file: target.file, line: target.line, kind: target.kind })), ...candidatesForEntry(batch, entry.id)].slice(0, 12),
      });
      continue;
    }

    failures.push({
      ref: op.ref,
      reason: 'source_verification_failed',
      detail: op.newText.length === 0 ? 'originalText_still_present_in_plausible_source_location' : 'newText_not_found_in_plausible_source_location',
      candidates: targets.map((target) => ({ file: target.file, line: target.line, kind: target.kind })).concat(candidatesForEntry(batch, entry.id)).slice(0, 12),
    });
  }
  return failures;
}

function snapshotTargetPasses(snapshot, target, op) {
  const before = snapshot.get(target.file)?.content;
  if (typeof before !== 'string') return false;
  return verificationTargetPassesLines(before.split('\n'), target, op);
}

export function findUnappliedEntrySourceChanges({ batch, entries, reportedFiles, cwd, rollbackSnapshot }) {
  const failures = [];
  for (const entry of entries || []) {
    for (const rawOp of entry.ops || []) {
      const op = { ...rawOp, entryId: entry.id };
      if (typeof op.newText !== 'string' || op.newText.length === 0) continue;
      const targets = verificationTargetsForOp(batch, op, reportedFiles, cwd);
      const leakedTargets = targets.filter((target) =>
        verificationTargetPasses(cwd, target, op)
        && !snapshotTargetPasses(rollbackSnapshot, target, op)
      );
      if (leakedTargets.length === 0) continue;
      failures.push({
        id: entry.id,
        reason: 'failed_entry_source_changed',
        ref: op.ref,
        newText: op.newText,
        candidates: leakedTargets
          .map((target) => ({ file: target.file, line: target.line, kind: target.kind }))
          .concat(candidatesForEntry(batch, entry.id))
          .slice(0, 12),
      });
      break;
    }
  }
  return failures;
}

export function verificationFailuresForEntries(batch, entries, reason, extra = {}) {
  return entries.map((entry) => ({
    id: entry.id,
    reason,
    candidates: candidatesForEntry(batch, entry.id),
    ...extra,
  }));
}

export function verifyEntriesAfterRepair({ batch, appliedEntryIds, files, cwd }) {
  const reportedFiles = uniqueStrings(files || [])
    .map((file) => normalizeRelativeFile(cwd, file))
    .filter(Boolean);
  const entries = (batch.entries || []).filter((entry) => appliedEntryIds.includes(entry.id));
  const verifiedIds = [];
  const failed = [];
  for (const entry of entries) {
    const failures = verifyAppliedEntry({ batch, entry, reportedFiles, cwd });
    if (failures.length === 0) {
      verifiedIds.push(entry.id);
    } else {
      failed.push({
        id: entry.id,
        reason: 'source_verification_failed',
        failures,
        candidates: candidatesForEntry(batch, entry.id),
      });
    }
  }
  return { verifiedIds, failed, reportedFiles };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
