/**
 * Splitting a staged manual-edit batch into op-count-bounded chunks for
 * manual-apply.mjs, and normalizing/aggregating chunked-apply results.
 *
 * Split out of manual-apply.mjs. See that file for context.
 */

const DEFAULT_MANUAL_EDIT_APPLY_CHUNK_SIZE = 3;
const MIN_MANUAL_EDIT_APPLY_CHUNK_SIZE = 1;
const MAX_MANUAL_EDIT_APPLY_CHUNK_SIZE = 20;

export function manualEditApplyChunkSize(env = process.env) {
  const raw = Number(env.MONODESIGN_LIVE_MANUAL_EDIT_CHUNK_SIZE);
  if (!Number.isFinite(raw)) return DEFAULT_MANUAL_EDIT_APPLY_CHUNK_SIZE;
  const size = Math.trunc(raw);
  return Math.max(MIN_MANUAL_EDIT_APPLY_CHUNK_SIZE, Math.min(MAX_MANUAL_EDIT_APPLY_CHUNK_SIZE, size));
}

export function countManualApplyOps(entriesOrBatch) {
  const entries = Array.isArray(entriesOrBatch)
    ? entriesOrBatch
    : Array.isArray(entriesOrBatch?.entries) ? entriesOrBatch.entries : [];
  let count = 0;
  for (const entry of entries) count += Array.isArray(entry.ops) ? entry.ops.length : 0;
  return count;
}

export function normalizeApplyChunkResult(result) {
  const status = result?.status === 'partial' ? 'partial' : result?.status === 'error' ? 'error' : 'done';
  return {
    status,
    message: typeof result?.message === 'string' ? result.message : null,
    appliedEntryIds: Array.isArray(result?.appliedEntryIds) ? result.appliedEntryIds.filter((id) => typeof id === 'string') : [],
    failed: Array.isArray(result?.failed) ? result.failed.filter(Boolean) : [],
    files: Array.isArray(result?.files) ? result.files.filter((file) => typeof file === 'string') : [],
    notes: Array.isArray(result?.notes) ? result.notes.filter((note) => typeof note === 'string') : [],
  };
}

export function firstFailureReason(result) {
  const first = Array.isArray(result?.failed) ? result.failed.find(Boolean) : null;
  return first?.reason || first?.message || null;
}

export function markChunkEntriesFailed(failedByEntry, chunk, reason) {
  for (const entryId of chunk.entryIds) {
    if (failedByEntry.has(entryId)) continue;
    failedByEntry.set(entryId, { entryId, reason, candidates: [] });
  }
}

export function splitManualApplyBatch(batch, maxOps) {
  const totalOpCount = countManualApplyOps(batch);
  if (totalOpCount <= maxOps) {
    return [{
      batch,
      meta: null,
      entryIds: new Set((batch?.entries || []).map((entry) => entry.id).filter(Boolean)),
      opCountsByEntry: new Map((batch?.entries || []).map((entry) => [entry.id, Array.isArray(entry.ops) ? entry.ops.length : 0])),
    }];
  }

  const rawChunks = [];
  let current = createManualApplyChunkBuilder();
  for (const entry of batch?.entries || []) {
    const ops = entry.ops || [];
    if (ops.length <= maxOps) {
      if (current.opCount > 0 && current.opCount + ops.length > maxOps) {
        rawChunks.push(current);
        current = createManualApplyChunkBuilder();
      }
      for (const op of ops) addOpToManualApplyChunk(current, entry, op);
      continue;
    }
    if (current.opCount > 0) {
      rawChunks.push(current);
      current = createManualApplyChunkBuilder();
    }
    for (const op of ops) {
      if (current.opCount >= maxOps) {
        rawChunks.push(current);
        current = createManualApplyChunkBuilder();
      }
      addOpToManualApplyChunk(current, entry, op);
    }
  }
  if (current.opCount > 0) rawChunks.push(current);

  return rawChunks.map((chunk, index) => ({
    batch: {
      ...batch,
      count: chunk.opCount,
      entries: chunk.entries,
      ops: chunk.ops,
      candidates: filterManualApplyChunkCandidates(batch, chunk.refsByEntry),
      context: {
        ...(batch?.context || {}),
        totalEntries: chunk.entries.length,
        totalOps: chunk.opCount,
        chunkIndex: index + 1,
        chunkTotal: rawChunks.length,
        totalApplyOps: totalOpCount,
      },
    },
    meta: {
      index: index + 1,
      total: rawChunks.length,
      opCount: chunk.opCount,
      totalOpCount,
    },
    entryIds: new Set(chunk.entries.map((entry) => entry.id).filter(Boolean)),
    opCountsByEntry: chunk.opCountsByEntry,
  }));
}

function createManualApplyChunkBuilder() {
  return {
    entries: [],
    entryById: new Map(),
    entryIds: new Set(),
    ops: [],
    refsByEntry: new Map(),
    opCountsByEntry: new Map(),
    opCount: 0,
  };
}

function addOpToManualApplyChunk(chunk, entry, op) {
  let chunkEntry = chunk.entryById.get(entry.id);
  if (!chunkEntry) {
    chunkEntry = { ...entry, ops: [] };
    chunk.entryById.set(entry.id, chunkEntry);
    chunk.entryIds.add(entry.id);
    chunk.entries.push(chunkEntry);
  }
  chunkEntry.ops.push(op);
  chunk.ops.push({ ...op, entryId: op.entryId || entry.id });
  if (!chunk.refsByEntry.has(entry.id)) chunk.refsByEntry.set(entry.id, new Set());
  if (op.ref) chunk.refsByEntry.get(entry.id).add(op.ref);
  chunk.opCountsByEntry.set(entry.id, (chunk.opCountsByEntry.get(entry.id) || 0) + 1);
  chunk.opCount += 1;
}

function filterManualApplyChunkCandidates(batch, refsByEntry) {
  return (batch?.candidates || []).filter((candidate) => {
    const refs = refsByEntry.get(candidate.entryId);
    if (!refs) return false;
    if (!candidate.ref) return true;
    return refs.has(candidate.ref);
  });
}
