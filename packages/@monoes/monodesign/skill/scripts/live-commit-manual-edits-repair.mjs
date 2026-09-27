/**
 * Repair-attempt loop for live-commit-manual-edits.mjs: when a batched AI
 * apply fails post-apply validation, re-invoke the copy-edit agent with the
 * failure detail attached, up to a bounded number of attempts.
 *
 * Split out of live-commit-manual-edits.mjs. See that file for context.
 */

import { countByPage } from './live/manual-edits-buffer.mjs';
import {
  runCopyEditBatchAgent,
  runCopyEditPostApplyChecks,
} from './live-copy-edit-agent.mjs';
import {
  candidatesForEntry,
  mergeFailedEntries,
  mergeUniqueStrings,
  normalizeFailedEntries,
  repairAttemptLimit,
  summarizeAppliedEntries,
  summarizeRepairFailures,
  buildRepairBatch,
} from './live-commit-manual-edits-utils.mjs';
import {
  verifyEntriesAfterRepair,
  verificationFailuresForEntries,
} from './live-commit-manual-edits-verify.mjs';
import { clearAppliedEntries } from './live-commit-manual-edits-rollback.mjs';

export async function repairPostApplyValidation({
  batch,
  cwd,
  pageUrl,
  count,
  provider,
  env,
  timeoutMs,
  applyBatchToSource,
  chatAvailable,
  transactionId,
  appliedEntryIds,
  files,
  failed,
  notes,
  warnings,
  postChecks,
  repairReason = 'post_apply_validation_failed',
  repairFailures = null,
}) {
  const maxAttempts = repairAttemptLimit(env);
  let currentFiles = mergeUniqueStrings(files || []);
  let currentAppliedIds = mergeUniqueStrings(appliedEntryIds || []);
  let currentFailed = Array.isArray(failed) ? failed : [];
  let currentNotes = Array.isArray(notes) ? notes : [];
  let currentWarnings = Array.isArray(warnings) ? warnings : [];
  let currentFailures = Array.isArray(repairFailures) ? repairFailures : (postChecks?.failures || []);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const repair = {
      attempt,
      maxAttempts,
      transactionId: transactionId || null,
      reason: repairReason,
      failures: summarizeRepairFailures(currentFailures),
      files: currentFiles,
      pageUrl,
    };
    let repairResult;
    try {
      repairResult = await runCopyEditBatchAgent(buildRepairBatch(batch, repair), {
        cwd,
        provider,
        env,
        timeoutMs,
        applyBatchToSource,
        chatAvailable,
      });
    } catch (err) {
      currentFailures = [{
        reason: 'repair_agent_failed',
        message: err.message || String(err),
      }];
      continue;
    }

    currentFiles = mergeUniqueStrings(currentFiles, repairResult.files || []);
    currentNotes = [...currentNotes, ...(repairResult.notes || [])];
    currentWarnings = [...currentWarnings, ...(repairResult.warnings || [])];
    currentAppliedIds = mergeUniqueStrings(currentAppliedIds, repairResult.appliedEntryIds || []);
    currentFailed = mergeFailedEntries(
      currentFailed,
      normalizeFailedEntries(batch, repairResult, 'repair_failed'),
    );

    const verified = verifyEntriesAfterRepair({
      batch,
      appliedEntryIds: currentAppliedIds,
      files: currentFiles,
      cwd,
    });
    if (verified.failed.length > 0) {
      currentFailures = verified.failed;
      continue;
    }

    const repairedChecks = runCopyEditPostApplyChecks({ cwd, files: currentFiles });
    currentWarnings = [...currentWarnings, ...(repairedChecks.warnings || [])];
    if (!repairedChecks.ok) {
      currentFailures = repairedChecks.failures || [];
      continue;
    }

    const cleared = clearAppliedEntries(cwd, verified.verifiedIds);
    const counts = countByPage(cwd);
    const verifiedIdSet = new Set(verified.verifiedIds);
    return {
      applied: summarizeAppliedEntries(batch.entries, verified.verifiedIds),
      failed: mergeFailedEntries(currentFailed).filter((item) => !verifiedIdSet.has(item.id)),
      files: currentFiles,
      cleared,
      count,
      pageUrl,
      warnings: currentWarnings,
      notes: currentNotes,
      repair: {
        status: 'repaired',
        attempts: attempt,
        maxAttempts,
        transactionId: transactionId || null,
      },
      ...counts,
    };
  }

  const decisionFailedEntries = currentAppliedIds.length > 0
    ? (batch.entries || [])
        .filter((entry) => currentAppliedIds.includes(entry.id))
        .map((entry) => ({
          id: entry.id,
          reason: repairReason,
          checks: currentFailures,
          candidates: candidatesForEntry(batch, entry.id),
        }))
    : verificationFailuresForEntries(batch, batch.entries || [], repairReason, { checks: currentFailures });
  return {
    applied: [],
    failed: mergeFailedEntries(decisionFailedEntries, currentFailed),
    files: currentFiles,
    cleared: 0,
    count,
    pageUrl,
    warnings: currentWarnings,
    notes: currentNotes,
    reason: 'manual_edit_repair_needs_decision',
    needsManualDecision: true,
    repair: {
      status: 'needs_decision',
      attempts: maxAttempts,
      maxAttempts,
      transactionId: transactionId || null,
      failures: summarizeRepairFailures(currentFailures),
      files: currentFiles,
    },
    ...countByPage(cwd),
  };
}
