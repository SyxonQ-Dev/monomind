/**
 * Result validation and activity-log summarizing for manual-apply.mjs: the
 * shape the chat agent's reply must match, and compacting file paths/text
 * for readable activity log entries.
 *
 * Split out of manual-apply.mjs. See that file for context.
 */
import path from 'node:path';
import { countManualApplyOps } from './manual-apply-chunk.mjs';
import { collectManualApplyFiles } from './manual-apply-evidence.mjs';

function manualApplyResultShapeHint(eventId = 'EVENT_ID') {
  return `Use live-poll.mjs --reply ${eventId} done --data '{"status":"done","appliedEntryIds":["ENTRY_ID"],"failed":[],"files":["src/page.html"],"notes":[]}'`;
}

function invalidManualApplyResult(reason, eventId, extra = {}) {
  return {
    ok: false,
    body: {
      error: 'invalid_manual_apply_result',
      reason,
      hint: manualApplyResultShapeHint(eventId),
      ...extra,
    },
  };
}

export function validateManualApplyResultMessage(msg, deferred) {
  const data = msg?.data;
  const eventId = msg?.id || deferred?.event?.id || 'EVENT_ID';
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return invalidManualApplyResult('missing_result_data', eventId);
  }
  if ('entries' in data || 'ops' in data) {
    return invalidManualApplyResult('summary_result_not_allowed', eventId);
  }
  if (!['done', 'partial', 'error'].includes(data.status)) {
    return invalidManualApplyResult('invalid_status', eventId, { status: data.status ?? null });
  }

  for (const key of ['appliedEntryIds', 'failed', 'files', 'notes']) {
    if (!Array.isArray(data[key])) {
      return invalidManualApplyResult(`${key}_must_be_array`, eventId);
    }
  }

  for (const [index, value] of data.appliedEntryIds.entries()) {
    if (typeof value !== 'string' || !value) {
      return invalidManualApplyResult('appliedEntryIds_must_contain_strings', eventId, { index });
    }
  }
  for (const [index, value] of data.files.entries()) {
    if (typeof value !== 'string' || !value) {
      return invalidManualApplyResult('files_must_contain_strings', eventId, { index });
    }
  }
  for (const [index, value] of data.notes.entries()) {
    if (typeof value !== 'string') {
      return invalidManualApplyResult('notes_must_contain_strings', eventId, { index });
    }
  }
  for (const [index, item] of data.failed.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return invalidManualApplyResult('failed_must_contain_objects', eventId, { index });
    }
    if (typeof item.entryId !== 'string' || !item.entryId) {
      return invalidManualApplyResult('failed_entryId_required', eventId, { index });
    }
    if (typeof item.reason !== 'string' || !item.reason) {
      return invalidManualApplyResult('failed_reason_required', eventId, { index });
    }
  }

  const eventEntryIds = new Set((deferred?.batch?.entries || []).map((entry) => entry.id).filter(Boolean));
  for (const entryId of data.appliedEntryIds) {
    if (eventEntryIds.size > 0 && !eventEntryIds.has(entryId)) {
      return invalidManualApplyResult('applied_entry_id_not_in_event', eventId, { entryId });
    }
  }
  for (const item of data.failed) {
    if (eventEntryIds.size > 0 && !eventEntryIds.has(item.entryId)) {
      return invalidManualApplyResult('failed_entry_id_not_in_event', eventId, { entryId: item.entryId });
    }
  }

  if (data.status === 'done') {
    if (data.failed.length > 0) {
      return invalidManualApplyResult('done_result_has_failed_entries', eventId);
    }
    if (countManualApplyOps(deferred?.batch) > 0 && data.appliedEntryIds.length === 0) {
      return invalidManualApplyResult('done_result_missing_applied_entry_ids', eventId);
    }
  }
  if (data.status === 'partial' && data.appliedEntryIds.length === 0 && data.failed.length === 0) {
    return invalidManualApplyResult('partial_result_has_no_entries', eventId);
  }
  if (data.status === 'error' && data.appliedEntryIds.length > 0) {
    return invalidManualApplyResult('error_result_has_applied_entries', eventId);
  }

  return {
    ok: true,
    result: {
      status: data.status,
      message: typeof data.message === 'string' ? data.message : undefined,
      appliedEntryIds: data.appliedEntryIds,
      failed: data.failed,
      files: data.files,
      notes: data.notes,
    },
  };
}

function manualApplyReplyCommand(eventOrId = 'EVENT_ID') {
  const id = typeof eventOrId === 'string' ? eventOrId : eventOrId?.id || 'EVENT_ID';
  return `live-poll.mjs --reply ${id} done --data '<json>'`;
}

export function buildManualApplyAgentAction(eventOrId = 'EVENT_ID') {
  return {
    kind: 'manual_edit_apply',
    required: 'apply_source_edits_then_reply',
    replyCommand: manualApplyReplyCommand(eventOrId),
    warning: 'Polling only leases this work item; it does not commit source edits.',
  };
}

export function summarizeManualApplyEvent(event = {}, batch = event.batch, cwd = process.cwd()) {
  const entries = Array.isArray(batch?.entries) ? batch.entries : [];
  const opCount = entries.reduce((sum, entry) => sum + (Array.isArray(entry.ops) ? entry.ops.length : 0), 0);
  return {
    pageUrl: event.pageUrl || null,
    chunk: event.chunk || null,
    entryCount: entries.length,
    opCount,
    files: collectManualApplyFiles(batch, [], cwd),
  };
}

export function summarizeManualApplyFailures(failed, cwd = process.cwd()) {
  if (!Array.isArray(failed)) return [];
  return failed.slice(0, 20).map((item) => ({
    id: item.id || item.entryId || null,
    reason: item.reason || item.message || 'failed',
    message: compactManualLogText(item.message, 300),
    files: Array.isArray(item.files) ? item.files.slice(0, 12).map((file) => summarizeManualLogFile(file, cwd)).filter(Boolean) : undefined,
    checks: summarizeManualDiagnostics(item.checks, cwd),
    failures: summarizeManualDiagnostics(item.failures, cwd),
    candidates: summarizeManualDiagnostics(item.candidates, cwd),
  }));
}

export function summarizeManualDiagnostics(items, cwd = process.cwd()) {
  if (!Array.isArray(items) || items.length === 0) return undefined;
  return items.slice(0, 12).map((item) => ({
    reason: item.reason || item.kind || undefined,
    detail: compactManualLogText(item.detail, 220),
    message: compactManualLogText(item.message, 300),
    file: summarizeManualLogFile(item.file || item.relativeFile, cwd),
    line: item.line || undefined,
    ref: compactManualLogText(item.ref, 180),
    marker: compactManualLogText(item.marker, 120),
    files: Array.isArray(item.files) ? item.files.slice(0, 8).map((file) => summarizeManualLogFile(file, cwd)).filter(Boolean) : undefined,
  }));
}

export function summarizeManualLogFile(file, cwd = process.cwd()) {
  if (!file || typeof file !== 'string') return undefined;
  if (!path.isAbsolute(file)) return file;
  const relative = path.relative(cwd, file).split(path.sep).join('/');
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : file;
}

export function compactManualLogText(value, max = 200) {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max)}... [truncated ${normalized.length - max} chars]`;
}
