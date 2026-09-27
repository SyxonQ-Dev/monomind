/**
 * Small generic helpers for live-commit-manual-edits.mjs: CLI arg parsing,
 * batch/entry bookkeeping, and repair-attempt bookkeeping.
 *
 * Split out of live-commit-manual-edits.mjs. See that file for context.
 */

const DEFAULT_REPAIR_ATTEMPTS = 3;

export function argVal(args, name) {
  const prefix = `${name}=`;
  for (const arg of args) {
    if (arg === name) return true;
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  }
  return null;
}

export function countOps(entries) {
  let count = 0;
  for (const entry of entries || []) count += Array.isArray(entry.ops) ? entry.ops.length : 0;
  return count;
}

export function summarizeAppliedEntries(entries, appliedEntryIds) {
  const ids = new Set(appliedEntryIds);
  const out = [];
  for (const entry of entries || []) {
    if (!ids.has(entry.id)) continue;
    for (const op of entry.ops || []) {
      out.push({
        id: entry.id,
        ref: op.ref,
        originalText: op.originalText,
        newText: op.newText,
      });
    }
  }
  return out;
}

export function normalizeFailedEntries(batch, result, fallbackReason) {
  const failed = [];
  const failedByEntryId = new Map();
  for (const item of result?.failed || []) {
    const entryId = item.entryId || item.id || null;
    if (!entryId) continue;
    failedByEntryId.set(entryId, item);
  }

  for (const entry of batch.entries || []) {
    const item = failedByEntryId.get(entry.id);
    if (!item) continue;
    failed.push({
      id: entry.id,
      reason: item.reason || item.message || fallbackReason || 'failed',
      candidates: Array.isArray(item.candidates) && item.candidates.length > 0
        ? item.candidates
        : candidatesForEntry(batch, entry.id),
    });
  }
  return failed;
}

export function mergeFailedEntries(...groups) {
  const out = [];
  const indexById = new Map();
  for (const item of groups.flatMap((group) => Array.isArray(group) ? group : [])) {
    if (!item || typeof item !== 'object') continue;
    const id = typeof item.id === 'string' && item.id ? item.id : null;
    if (!id) {
      out.push(item);
      continue;
    }
    const existingIndex = indexById.get(id);
    if (existingIndex === undefined) {
      indexById.set(id, out.length);
      out.push(item);
      continue;
    }
    out[existingIndex] = {
      ...out[existingIndex],
      ...item,
      candidates: item.candidates || out[existingIndex].candidates,
      checks: item.checks || out[existingIndex].checks,
    };
  }
  return out;
}

export function candidatesForEntry(batch, entryId) {
  return (batch.candidates || [])
    .filter((candidate) => candidate.entryId === entryId)
    .flatMap((candidate) => [
      ...(candidate.sourceHint ? [candidate.sourceHint] : []),
      ...(candidate.textMatches || []),
      ...(candidate.objectKeyMatches || []),
      ...(candidate.locatorMatches || []),
      ...(candidate.contextTextMatches || []),
    ])
    .slice(0, 12);
}

export function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value.trim()))];
}

export function allEntryIds(batch) {
  return (batch?.entries || []).map((entry) => entry.id).filter(Boolean);
}

export function mergeUniqueStrings(...groups) {
  return uniqueStrings(groups.flatMap((group) => Array.isArray(group) ? group : []));
}

export function repairAttemptLimit(env = process.env) {
  const value = Number(env.MONODESIGN_LIVE_MANUAL_EDIT_REPAIR_ATTEMPTS || DEFAULT_REPAIR_ATTEMPTS);
  if (!Number.isFinite(value)) return DEFAULT_REPAIR_ATTEMPTS;
  return Math.max(1, Math.min(10, Math.trunc(value)));
}

export function summarizeRepairFailures(failures = []) {
  return failures.map((failure) => {
    const out = {
      reason: failure.reason || failure.detail || 'validation_failed',
    };
    if (failure.id || failure.entryId) out.entryId = failure.id || failure.entryId;
    if (failure.ref) out.ref = failure.ref;
    if (failure.detail) out.detail = failure.detail;
    if (failure.file) out.file = failure.file;
    if (failure.message) out.message = failure.message;
    if (failure.marker) out.marker = failure.marker;
    if (Array.isArray(failure.files)) out.files = failure.files.slice(0, 8);
    if (Array.isArray(failure.candidates)) {
      out.candidates = failure.candidates.slice(0, 8).map((candidate) => ({
        file: candidate.file,
        line: candidate.line,
        kind: candidate.kind,
        reason: candidate.reason,
      }));
    }
    if (Array.isArray(failure.failures)) {
      out.failures = failure.failures.slice(0, 8).map((item) => ({
        ref: item.ref,
        reason: item.reason || item.detail,
        detail: item.detail,
        candidates: Array.isArray(item.candidates)
          ? item.candidates.slice(0, 6).map((candidate) => ({
              file: candidate.file,
              line: candidate.line,
              kind: candidate.kind,
              reason: candidate.reason,
            }))
          : undefined,
      }));
    }
    if (failure.checks) out.checks = failure.checks;
    return out;
  }).slice(0, 20);
}

export function buildRepairBatch(batch, repair) {
  return {
    ...batch,
    repair,
  };
}
