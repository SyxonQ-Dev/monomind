import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
const APPLY_EVENT_HARD_TIMEOUT_MS = Number(process.env.MONODESIGN_LIVE_APPLY_EVENT_HARD_TIMEOUT_MS || 150_000);
const APPLY_EVENT_SOFT_DEADLINE_MS = Number(process.env.MONODESIGN_LIVE_APPLY_EVENT_SOFT_DEADLINE_MS || 120_000);

import {
  collectManualApplyFiles,
  manualApplyEvidenceDir,
  normalizeManualApplyEvidencePath,
  removeManualApplyEvidence,
  rollbackApplySnapshot,
  snapshotApplyEventFiles,
  writeManualApplyEvidence,
} from './manual-apply-evidence.mjs';
import { compactManualApplyBatch } from './manual-apply-compact.mjs';
import {
  countManualApplyOps,
  firstFailureReason,
  manualEditApplyChunkSize,
  markChunkEntriesFailed,
  normalizeApplyChunkResult,
  splitManualApplyBatch,
} from './manual-apply-chunk.mjs';
import {
  buildManualApplyAgentAction,
  summarizeManualApplyEvent,
  validateManualApplyResultMessage,
} from './manual-apply-log.mjs';
import {
  clearManualApplyTransaction,
  readManualApplyTransaction,
  rollbackManualApplyTransaction,
  writeManualApplyTransaction,
} from './manual-apply-transaction.mjs';

export {
  collectManualApplyFiles,
  manualApplyEvidenceDir,
  normalizeManualApplyEvidencePath,
  removeManualApplyEvidence,
  rollbackApplySnapshot,
  snapshotApplyEventFiles,
  writeManualApplyEvidence,
} from './manual-apply-evidence.mjs';
export {
  compactManualApplyBatch,
  compactManualApplyCandidates,
} from './manual-apply-compact.mjs';
export {
  countManualApplyOps,
  manualEditApplyChunkSize,
  splitManualApplyBatch,
} from './manual-apply-chunk.mjs';
export {
  buildManualApplyAgentAction,
  compactManualLogText,
  summarizeManualApplyEvent,
  summarizeManualApplyFailures,
  summarizeManualDiagnostics,
  summarizeManualLogFile,
  validateManualApplyResultMessage,
} from './manual-apply-log.mjs';
export {
  clearManualApplyTransaction,
  manualApplyTransactionPath,
  readManualApplyTransaction,
  rollbackManualApplyTransaction,
  writeManualApplyTransaction,
} from './manual-apply-transaction.mjs';

export function createManualApplyController({
  pendingEvents,
  pendingApplyDeferreds,
  timedOutApplyIds,
  enqueueEvent,
  acknowledgePendingEvent,
  flushPendingPolls,
  recordManualEditActivity,
  cwd = () => process.cwd(),
} = {}) {
  const projectCwd = () => typeof cwd === 'function' ? cwd() : cwd || process.cwd();

  function tombstoneTimedOutApplyId(eventId, details = {}) {
    if (!eventId) return;
    timedOutApplyIds.set(eventId, details);
    if (timedOutApplyIds.size <= 200) return;
    const oldest = timedOutApplyIds.keys().next().value;
    timedOutApplyIds.delete(oldest);
  }

  function pushApplyEventAndWait(batch, pageUrl, chunk = null, repair = null) {
    const cwdValue = projectCwd();
    const eventId = randomUUID().replace(/-/g, '').slice(0, 8);
    const evidencePath = writeManualApplyEvidence(eventId, batch, cwdValue);
    const event = {
      type: 'manual_edit_apply',
      id: eventId,
      pageUrl,
      batch: compactManualApplyBatch(batch, cwdValue),
      evidencePath,
      agentAction: buildManualApplyAgentAction(eventId),
      schemaVersion: 1,
      deadlineMs: APPLY_EVENT_SOFT_DEADLINE_MS,
    };
    if (chunk) event.chunk = chunk;
    if (repair) event.repair = repair;
    const rollbackSnapshot = snapshotApplyEventFiles(batch, cwdValue);
    recordManualEditActivity('manual_edit_apply_dispatched', {
      id: eventId,
      pageUrl,
      chunk,
      repair,
      entryCount: Array.isArray(batch.entries) ? batch.entries.length : 0,
      opCount: countManualApplyOps(batch),
      fileCount: collectManualApplyFiles(batch, [], cwdValue).length,
    });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingApplyDeferreds.delete(eventId);
        tombstoneTimedOutApplyId(eventId, { batch, rollbackSnapshot, cwd: cwdValue });
        acknowledgePendingEvent(eventId);
        removeManualApplyEvidence(evidencePath, cwdValue);
        recordManualEditActivity('manual_edit_apply_timeout', {
          id: eventId,
          pageUrl,
          chunk,
          entryCount: Array.isArray(batch.entries) ? batch.entries.length : 0,
          opCount: countManualApplyOps(batch),
        });
        reject(new Error('chat_agent_timeout'));
      }, APPLY_EVENT_HARD_TIMEOUT_MS);
      pendingApplyDeferreds.set(eventId, { resolve, reject, timer, event, batch, pageUrl, rollbackSnapshot, cwd: cwdValue });
      enqueueEvent(event);
    });
  }

  async function pushBatchInChunksAndWait(batch, pageUrl, context = {}) {
    const repair = context?.repair || batch?.repair || null;
    if (repair) return pushApplyEventAndWait(batch, pageUrl, null, repair);
    const chunks = splitManualApplyBatch(batch, manualEditApplyChunkSize());
    if (chunks.length <= 1) return pushApplyEventAndWait(batch, pageUrl);

    const expectedOpsByEntry = new Map();
    for (const entry of batch?.entries || []) {
      expectedOpsByEntry.set(entry.id, Array.isArray(entry.ops) ? entry.ops.length : 0);
    }

    const appliedOpsByEntry = new Map();
    const failedByEntry = new Map();
    const files = new Set();
    const notes = [];
    let aborted = false;

    for (const chunk of chunks) {
      if (aborted) {
        markChunkEntriesFailed(failedByEntry, chunk, 'manual_edit_chunk_aborted');
        continue;
      }

      let result;
      try {
        result = normalizeApplyChunkResult(await pushApplyEventAndWait(chunk.batch, pageUrl, chunk.meta));
      } catch (err) {
        markChunkEntriesFailed(failedByEntry, chunk, err.message || 'chat_agent_error');
        aborted = true;
        continue;
      }

      for (const file of result.files) files.add(file);
      notes.push(...result.notes);

      const chunkFailedIds = new Set();
      for (const item of result.failed) {
        const entryId = item.entryId || item.id;
        if (!entryId) continue;
        chunkFailedIds.add(entryId);
        if (!failedByEntry.has(entryId)) {
          failedByEntry.set(entryId, {
            entryId,
            reason: item.reason || item.message || 'failed',
            candidates: Array.isArray(item.candidates) ? item.candidates : [],
          });
        }
      }

      if (result.status === 'error') {
        markChunkEntriesFailed(failedByEntry, chunk, result.message || firstFailureReason(result) || 'chat_agent_error');
        aborted = true;
        continue;
      }

      const reportedAppliedIds = new Set(result.appliedEntryIds);
      for (const entryId of reportedAppliedIds) {
        if (!chunk.entryIds.has(entryId) || chunkFailedIds.has(entryId)) continue;
        appliedOpsByEntry.set(entryId, (appliedOpsByEntry.get(entryId) || 0) + (chunk.opCountsByEntry.get(entryId) || 0));
      }

      for (const entryId of chunk.entryIds) {
        if (reportedAppliedIds.has(entryId) || chunkFailedIds.has(entryId)) continue;
        if (!failedByEntry.has(entryId)) {
          failedByEntry.set(entryId, { entryId, reason: 'not_reported_applied', candidates: [] });
        }
      }
    }

    const appliedEntryIds = [];
    for (const [entryId, expectedOps] of expectedOpsByEntry.entries()) {
      if (failedByEntry.has(entryId)) continue;
      if ((appliedOpsByEntry.get(entryId) || 0) === expectedOps && expectedOps > 0) {
        appliedEntryIds.push(entryId);
      } else if (!failedByEntry.has(entryId)) {
        failedByEntry.set(entryId, { entryId, reason: 'not_reported_applied', candidates: [] });
      }
    }

    const failed = [...failedByEntry.values()];
    return {
      status: failed.length === 0 ? 'done' : appliedEntryIds.length > 0 ? 'partial' : 'error',
      appliedEntryIds,
      failed,
      files: [...files],
      notes,
    };
  }

  function getDeferred(eventId) {
    return pendingApplyDeferreds.get(eventId) || null;
  }

  function hasTimedOutId(eventId) {
    return timedOutApplyIds.has(eventId);
  }

  function resolveDeferred(eventId, body) {
    const deferred = pendingApplyDeferreds.get(eventId);
    if (!deferred) return false;
    pendingApplyDeferreds.delete(eventId);
    clearTimeout(deferred.timer);
    removeManualApplyEvidence(deferred.event?.evidencePath, deferred.cwd || projectCwd());
    deferred.resolve(body);
    return true;
  }

  function rejectDeferred(eventId, reason) {
    const deferred = pendingApplyDeferreds.get(eventId);
    if (!deferred) return false;
    pendingApplyDeferreds.delete(eventId);
    clearTimeout(deferred.timer);
    removeManualApplyEvidence(deferred.event?.evidencePath, deferred.cwd || projectCwd());
    deferred.reject(new Error(reason || 'chat_agent_error'));
    return true;
  }

  function referencedManualApplyEvidencePaths(cwdValue = projectCwd()) {
    const referenced = new Set();
    const add = (event) => {
      const fullPath = normalizeManualApplyEvidencePath(event?.evidencePath, cwdValue);
      if (fullPath) referenced.add(fullPath);
    };
    for (const entry of pendingEvents) add(entry.event);
    for (const deferred of pendingApplyDeferreds.values()) add(deferred.event);
    return referenced;
  }

  function pruneStaleEvidence(cwdValue = projectCwd()) {
    const dir = manualApplyEvidenceDir(cwdValue);
    if (!fs.existsSync(dir)) return [];
    const referenced = referencedManualApplyEvidencePaths(cwdValue);
    const removed = [];
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const fullPath = path.join(dir, name);
      if (referenced.has(fullPath)) continue;
      try {
        fs.unlinkSync(fullPath);
        removed.push(fullPath);
      } catch {
        // Stale evidence cleanup is best-effort; Apply verification never relies
        // on deleting these files.
      }
    }
    return removed;
  }

  function rollbackTimedOutReply(msg) {
    const details = timedOutApplyIds.get(msg.id);
    if (!details) return { rolledBackFiles: [], rollbackFailures: [] };
    timedOutApplyIds.delete(msg.id);
    return rollbackApplySnapshot(
      details.batch,
      details.rollbackSnapshot,
      msg.data?.files || [],
      'stale_manual_edit_apply_reply',
      details.cwd || projectCwd(),
    );
  }

  function cancelPendingEvents(pageUrl, reason = 'manual_edit_discarded') {
    const canceledById = new Map();
    const shouldCancel = (event) => event?.type === 'manual_edit_apply' && (!pageUrl || event.pageUrl === pageUrl);

    for (let i = pendingEvents.length - 1; i >= 0; i -= 1) {
      const event = pendingEvents[i]?.event;
      if (!shouldCancel(event)) continue;
      pendingEvents.splice(i, 1);
      removeManualApplyEvidence(event.evidencePath, projectCwd());
      canceledById.set(event.id, {
        id: event.id,
        pageUrl: event.pageUrl,
        entryCount: event.batch?.entries?.length || 0,
      });
    }

    for (const [eventId, deferred] of [...pendingApplyDeferreds.entries()]) {
      if (!shouldCancel(deferred.event)) continue;
      pendingApplyDeferreds.delete(eventId);
      clearTimeout(deferred.timer);
      const cwdValue = deferred.cwd || projectCwd();
      const rollback = rollbackApplySnapshot(deferred.batch, deferred.rollbackSnapshot, [], reason, cwdValue);
      tombstoneTimedOutApplyId(eventId, {
        batch: deferred.batch,
        rollbackSnapshot: deferred.rollbackSnapshot,
        reason,
        cwd: cwdValue,
      });
      removeManualApplyEvidence(deferred.event?.evidencePath, cwdValue);
      canceledById.set(eventId, {
        id: eventId,
        pageUrl: deferred.pageUrl,
        entryCount: deferred.batch?.entries?.length || 0,
        rolledBackFiles: rollback.rolledBackFiles,
        rollbackFailures: rollback.rollbackFailures,
      });
      deferred.reject(new Error(reason));
    }

    if (canceledById.size > 0) flushPendingPolls();
    return [...canceledById.values()];
  }

  return {
    buildAgentAction: buildManualApplyAgentAction,
    cancelPendingEvents,
    clearTransaction: (transactionId = null) => clearManualApplyTransaction(projectCwd(), transactionId),
    countOps: countManualApplyOps,
    getDeferred,
    hasTimedOutId,
    pruneStaleEvidence,
    pushBatchInChunksAndWait,
    readTransaction: () => readManualApplyTransaction(projectCwd()),
    rejectDeferred,
    resolveDeferred,
    rollbackTimedOutReply,
    rollbackTransaction: (opts = {}) => rollbackManualApplyTransaction({
      cwd: projectCwd(),
      recordManualEditActivity,
      ...opts,
    }),
    summarizeEvent: (event = {}, batch = event.batch) => summarizeManualApplyEvent(event, batch, projectCwd()),
    validateResultMessage: validateManualApplyResultMessage,
    writeTransaction: (opts = {}) => writeManualApplyTransaction({ cwd: projectCwd(), ...opts }),
  };
}
