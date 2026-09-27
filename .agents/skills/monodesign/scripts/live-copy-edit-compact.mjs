// Compacting a staged copy-edit batch down to what's worth sending an AI
// runner, normalizing its reply shape, and the mock provider used in tests.
// Split out of live-copy-edit-agent.mjs (file-size sweep — pure move, no
// behaviour change).

import fs from 'node:fs';
import path from 'node:path';
import { truncate, isPathInsideOrEqual, tryParseJson } from './live-copy-edit-runners.mjs';
import { parseCopyEditBatchResult } from './live-copy-edit-agent.mjs';

function compactBatchForPrompt(batch) {
  return {
    pageUrl: batch?.pageUrl || null,
    repair: batch?.repair || undefined,
    entries: (batch?.entries || []).map((entry) => ({
      id: entry.id,
      pageUrl: entry.pageUrl,
      stagedAt: entry.stagedAt || null,
      element: compactContextForBatch(entry.element),
      ops: (entry.ops || []).map(compactBatchOp),
    })),
    candidates: batch?.candidates || [],
  };
}

function compactBatchOp(op) {
  return {
    entryId: op.entryId,
    ref: op.ref,
    contextRef: op.contextRef,
    tag: op.tag,
    elementId: op.elementId,
    classes: op.classes,
    originalText: op.originalText,
    newText: op.newText,
    deleted: op.deleted === true || undefined,
    sourceHint: op.sourceHint,
    leaf: compactContextForBatch(op.leaf),
    nearbyEditableTexts: Array.isArray(op.nearbyEditableTexts) ? op.nearbyEditableTexts.slice(0, 8) : [],
    container: compactContextForBatch(op.container),
    contextHints: Array.isArray(op.contextHints) ? op.contextHints.slice(0, 12) : [],
  };
}

function compactContextForBatch(value) {
  if (!value || typeof value !== 'object') return value || null;
  return {
    ref: value.ref,
    tagName: value.tagName,
    id: value.id,
    classes: value.classes,
    textContent: truncate(value.textContent, 900),
    outerHTML: truncate(stripLiveRuntimeHtml(value.outerHTML), 1800),
  };
}

function stripLiveRuntimeHtml(html) {
  if (typeof html !== 'string') return html || null;
  return html
    .replace(/\sdata-monodesign-(?:original-text|editable|text-wrap)(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?/g, '')
    .replace(/\scontenteditable(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?/g, '')
    .replace(/\sstyle=(["'])(?:(?!\1)[\s\S])*(?:-webkit-user-modify|user-select:\s*text|cursor:\s*text)(?:(?!\1)[\s\S])*\1/g, '');
}

function normalizeBatchResult(result) {
  const status = result.status === 'partial' ? 'partial' : result.status === 'error' ? 'error' : 'done';
  const appliedEntryIds = Array.isArray(result.appliedEntryIds)
    ? result.appliedEntryIds.filter((id) => typeof id === 'string')
    : [];
  const failed = Array.isArray(result.failed)
    ? result.failed.filter(Boolean).map((item) => ({
        entryId: item.entryId || item.id || null,
        reason: item.reason || item.message || 'failed',
        candidates: Array.isArray(item.candidates) ? item.candidates : [],
      }))
    : [];
  const files = Array.isArray(result.files) ? result.files.filter((file) => typeof file === 'string') : [];
  const notes = Array.isArray(result.notes) ? result.notes.filter((note) => typeof note === 'string') : [];
  const warnings = Array.isArray(result.warnings)
    ? result.warnings
        .filter(Boolean)
        .map((warning) => typeof warning === 'string' ? { message: warning } : warning)
        .filter((warning) => warning && typeof warning === 'object')
    : [];
  return {
    status,
    message: result.message || null,
    appliedEntryIds,
    failed,
    files,
    notes,
    warnings,
  };
}

function mockBatchResult(batch, env, cwd = process.cwd()) {
  applyMockWrites(env, cwd);
  const raw = env.MONODESIGN_LIVE_COPY_AGENT_MOCK_RESULT;
  if (raw) {
    const parsed = parseCopyEditBatchResult(raw);
    if (parsed) return parsed;
    throw new Error('Invalid MONODESIGN_LIVE_COPY_AGENT_MOCK_RESULT JSON');
  }
  return {
    status: 'done',
    appliedEntryIds: (batch?.entries || []).map((entry) => entry.id).filter(Boolean),
    failed: [],
    files: [],
    notes: ['mock copy-edit batch result'],
  };
}

function applyMockWrites(env, cwd) {
  const raw = env.MONODESIGN_LIVE_COPY_AGENT_MOCK_WRITES;
  if (!raw) return;
  const writes = tryParseJson(raw);
  if (!writes || typeof writes !== 'object' || Array.isArray(writes)) {
    throw new Error('Invalid MONODESIGN_LIVE_COPY_AGENT_MOCK_WRITES JSON');
  }
  for (const [relativeFile, content] of Object.entries(writes)) {
    if (typeof relativeFile !== 'string' || typeof content !== 'string') continue;
    const absolute = path.resolve(cwd, relativeFile);
    if (!isPathInsideOrEqual(cwd, absolute)) continue;
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content, 'utf-8');
  }
}

export {
  compactBatchForPrompt,
  compactBatchOp,
  compactContextForBatch,
  stripLiveRuntimeHtml,
  normalizeBatchResult,
  mockBatchResult,
  applyMockWrites,
};
