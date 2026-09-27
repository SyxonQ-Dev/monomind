/**
 * Compacting a staged manual-edit batch into the smaller shape sent to the
 * chat agent (dropping evidence the agent doesn't need, truncating long
 * text) for manual-apply.mjs.
 *
 * Split out of manual-apply.mjs. See that file for context.
 */
import { summarizeManualLogFile } from './manual-apply-log.mjs';

const MANUAL_APPLY_COMPACT_TEXT_LIMIT = 240;
const MANUAL_APPLY_COMPACT_NEARBY_LIMIT = 4;

export function compactManualApplyBatch(batch = {}, cwd = process.cwd()) {
  const entries = (batch.entries || []).map(compactManualApplyEntry);
  const candidates = compactManualApplyCandidates(batch.candidates || [], cwd);
  return {
    version: batch.version,
    pageUrl: batch.pageUrl || null,
    count: batch.count,
    entries,
    ops: entries.flatMap((entry) => entry.ops.map((op) => ({ ...op, entryId: entry.id }))),
    candidates: candidates.length > 0 ? candidates : undefined,
    context: batch.context ? {
      bufferPath: batch.context.bufferPath,
      totalEntries: batch.context.totalEntries,
      totalOps: batch.context.totalOps,
      chunkIndex: batch.context.chunkIndex,
      chunkTotal: batch.context.chunkTotal,
      totalApplyOps: batch.context.totalApplyOps,
    } : undefined,
  };
}

export function compactManualApplyCandidates(candidates, cwd = process.cwd()) {
  return (Array.isArray(candidates) ? candidates : [])
    .slice(0, 24)
    .map((candidate) => ({
      entryId: candidate.entryId,
      ref: candidate.ref,
      sourceHint: compactManualApplySourceMatch(candidate.sourceHint, cwd),
      textMatches: compactManualApplySourceMatches(candidate.textMatches, 8, cwd),
      objectKeyMatches: compactManualApplySourceMatches(candidate.objectKeyMatches, 8, cwd),
      contextTextMatches: compactManualApplySourceMatches(candidate.contextTextMatches, 8, cwd),
      locatorMatches: compactManualApplySourceMatches(candidate.locatorMatches, 6, cwd),
    }));
}

function compactManualApplySourceMatches(matches, limit, cwd) {
  return (Array.isArray(matches) ? matches : [])
    .slice(0, limit)
    .map((match) => compactManualApplySourceMatch(match, cwd))
    .filter(Boolean);
}

function compactManualApplySourceMatch(match, cwd) {
  if (!match || typeof match !== 'object') return null;
  const file = match.relativeFile || match.file;
  if (!file && !match.line) return null;
  return {
    file: summarizeManualLogFile(file, cwd),
    line: match.line || null,
    column: match.column || null,
    reason: match.reason || match.kind || undefined,
    status: match.status || undefined,
  };
}

function compactManualApplyEntry(entry = {}) {
  return {
    id: entry.id,
    pageUrl: entry.pageUrl,
    stagedAt: entry.stagedAt || null,
    element: compactManualApplyContext(entry.element),
    ops: (entry.ops || []).map(compactManualApplyOp),
  };
}

function compactManualApplyOp(op = {}) {
  return {
    entryId: op.entryId,
    ref: op.ref,
    contextRef: op.contextRef,
    tag: op.tag,
    elementId: op.elementId,
    classes: Array.isArray(op.classes) ? op.classes : [],
    originalText: op.originalText,
    newText: op.newText,
    deleted: op.deleted === true || undefined,
    sourceHint: op.sourceHint || null,
    leaf: compactManualApplyContext(op.leaf),
    nearbyEditableTexts: compactNearbyManualEditTexts(op.nearbyEditableTexts),
    container: compactManualApplyContext(op.container),
    contextHints: Array.isArray(op.contextHints) ? op.contextHints.slice(0, 8) : undefined,
  };
}

function compactManualApplyContext(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    ref: value.ref,
    tagName: value.tagName || value.tag || null,
    id: value.id || null,
    classes: Array.isArray(value.classes) ? value.classes : [],
    textContent: truncateManualApplyText(value.textContent, MANUAL_APPLY_COMPACT_TEXT_LIMIT),
  };
}

function compactNearbyManualEditTexts(items) {
  return (Array.isArray(items) ? items : [])
    .slice(0, MANUAL_APPLY_COMPACT_NEARBY_LIMIT)
    .map((item) => typeof item === 'string' ? { text: truncateManualApplyText(item, MANUAL_APPLY_COMPACT_TEXT_LIMIT) } : {
      ref: item?.ref,
      tag: item?.tag,
      classes: Array.isArray(item?.classes) ? item.classes : [],
      text: truncateManualApplyText(item?.text, MANUAL_APPLY_COMPACT_TEXT_LIMIT),
    });
}

function truncateManualApplyText(value, max) {
  if (typeof value !== 'string') return value || null;
  return value.length > max ? value.slice(0, max) : value;
}
