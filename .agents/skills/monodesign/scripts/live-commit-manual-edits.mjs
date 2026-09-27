#!/usr/bin/env node
/**
 * CLI helper: apply pending live copy edits as one AI-owned batch.
 *
 * The browser Save path stages copy edits in .monodesign/live. This script is
 * called by /manual-edit-commit when the user clicks Apply copy edits. It gives
 * the local AI runner the full staged batch plus evidence, validates the files
 * the runner reports touching, and clears only entries reported as applied.
 *
 * Usage:
 *   node live-commit-manual-edits.mjs
 *   node live-commit-manual-edits.mjs --page-url=/
 *
 * Output JSON:
 *   { applied, failed, files, cleared, count, pageUrl }
 */

import { buildManualEditEvidence } from './live-manual-edit-evidence.mjs';
import { readBufferStrict, countByPage } from './live/manual-edits-buffer.mjs';
import {
  runCopyEditBatchAgent,
  runCopyEditPostApplyChecks,
} from './live-copy-edit-agent.mjs';
import {
  argVal,
  countOps,
  summarizeAppliedEntries,
  normalizeFailedEntries,
  candidatesForEntry,
  uniqueStrings,
  allEntryIds,
} from './live-commit-manual-edits-utils.mjs';
import { normalizeRelativeFile } from './live-commit-manual-edits-paths.mjs';
import {
  verifyAppliedEntry,
  findUnappliedEntrySourceChanges,
  verificationFailuresForEntries,
} from './live-commit-manual-edits-verify.mjs';
import {
  clearAppliedEntries,
  snapshotRollbackFiles,
  rollbackChangedFiles,
  collectApplyOwnedFiles,
  unreportedChangedFiles,
} from './live-commit-manual-edits-rollback.mjs';
import { repairPostApplyValidation } from './live-commit-manual-edits-repair.mjs';

export async function commitManualEdits({
  cwd = process.cwd(),
  pageUrl = null,
  provider = undefined,
  env = process.env,
  timeoutMs = undefined,
  applyBatchToSource = undefined,
  chatAvailable = undefined,
  repairOnly = false,
  transactionId = null,
  batch: providedBatch = null,
} = {}) {
  try {
    readBufferStrict(cwd);
  } catch (err) {
    return {
      applied: [],
      failed: [],
      files: [],
      cleared: 0,
      count: 0,
      pageUrl,
      reason: 'manual_edit_buffer_invalid',
      message: err.message || String(err),
      ...countByPage(cwd),
    };
  }

  const batch = providedBatch || buildManualEditEvidence({ cwd, pageUrl });
  const count = countOps(batch.entries);
  if (count === 0) {
    return {
      applied: [],
      failed: [],
      files: [],
      cleared: 0,
      count: 0,
      pageUrl,
      reason: 'no_pending_edits',
      ...countByPage(cwd),
    };
  }

  const baseRollbackScope = collectApplyOwnedFiles(batch, cwd);
  const rollbackSnapshot = snapshotRollbackFiles(cwd, baseRollbackScope);
  let result;
  try {
    result = repairOnly
      ? {
          status: 'done',
          appliedEntryIds: allEntryIds(batch),
          failed: [],
          files: collectApplyOwnedFiles(batch, cwd),
          notes: ['repair-only validation pass'],
        }
      : await runCopyEditBatchAgent(batch, {
          cwd,
          provider,
          env,
          timeoutMs,
          applyBatchToSource,
          chatAvailable,
        });
  } catch (err) {
    const rollback = rollbackChangedFiles(cwd, rollbackSnapshot, [], baseRollbackScope);
    return {
      applied: [],
      failed: batch.entries.map((entry) => ({
        id: entry.id,
        reason: err.message || String(err),
        candidates: candidatesForEntry(batch, entry.id),
      })),
      files: [],
      cleared: 0,
      count,
      pageUrl,
      rolledBackFiles: rollback.rolledBackFiles,
      rollbackFailures: rollback.rollbackFailures,
      ...countByPage(cwd),
    };
  }

  if (result.status === 'error') {
    const rollbackScope = collectApplyOwnedFiles(batch, cwd, result.files || []);
    const rollback = rollbackChangedFiles(cwd, rollbackSnapshot, result.files || [], rollbackScope);
    const failed = normalizeFailedEntries(batch, result, result.message || 'AI copy edit failed');
    return {
      applied: [],
      failed: failed.length > 0
        ? failed
        : verificationFailuresForEntries(batch, batch.entries, result.message || 'AI copy edit failed'),
      files: result.files || [],
      cleared: 0,
      count,
      pageUrl,
      notes: result.notes || [],
      rolledBackFiles: rollback.rolledBackFiles,
      rollbackFailures: rollback.rollbackFailures,
      ...countByPage(cwd),
    };
  }

  const reportedAppliedIds = uniqueStrings(result.appliedEntryIds || []);
  const reportedFiles = uniqueStrings(result.files || [])
    .map((file) => normalizeRelativeFile(cwd, file))
    .filter(Boolean);
  const aiFailed = normalizeFailedEntries(batch, result, 'AI copy edit failed');
  const rollbackScope = collectApplyOwnedFiles(batch, cwd, result.files || []);
  const failedIds = new Set(aiFailed.map((item) => item.id).filter(Boolean));
  const conflictingAppliedIds = reportedAppliedIds.filter((id) => failedIds.has(id));

  if (conflictingAppliedIds.length > 0) {
    const rollback = rollbackChangedFiles(cwd, rollbackSnapshot, result.files || [], rollbackScope);
    const conflictingEntries = batch.entries.filter((entry) => conflictingAppliedIds.includes(entry.id));
    return {
      applied: [],
      failed: [
        ...verificationFailuresForEntries(batch, conflictingEntries, 'conflicting_apply_result'),
        ...aiFailed.filter((item) => !conflictingAppliedIds.includes(item.id)),
      ],
      files: result.files || [],
      cleared: 0,
      count,
      pageUrl,
      notes: result.notes || [],
      rolledBackFiles: rollback.rolledBackFiles,
      rollbackFailures: rollback.rollbackFailures,
      ...countByPage(cwd),
    };
  }

  const unreportedFiles = unreportedChangedFiles(cwd, rollbackSnapshot, result.files || [], rollbackScope);
  if (unreportedFiles.length > 0) {
    const rollback = rollbackChangedFiles(cwd, rollbackSnapshot, result.files || [], [...rollbackScope, ...unreportedFiles]);
    return {
      applied: [],
      failed: verificationFailuresForEntries(batch, batch.entries, 'unreported_source_changes', { files: unreportedFiles }),
      files: result.files || [],
      unreportedFiles,
      cleared: 0,
      count,
      pageUrl,
      notes: result.notes || [],
      rolledBackFiles: rollback.rolledBackFiles,
      rollbackFailures: rollback.rollbackFailures,
      ...countByPage(cwd),
    };
  }

  if (result.status === 'done' && reportedAppliedIds.length === 0) {
    const rollback = rollbackChangedFiles(cwd, rollbackSnapshot, result.files || [], rollbackScope);
    return {
      applied: [],
      failed: verificationFailuresForEntries(batch, batch.entries, 'missing_applied_entry_ids'),
      files: result.files || [],
      cleared: 0,
      count,
      pageUrl,
      notes: result.notes || [],
      rolledBackFiles: rollback.rolledBackFiles,
      rollbackFailures: rollback.rollbackFailures,
      ...countByPage(cwd),
    };
  }

  const reportedAppliedEntries = batch.entries.filter((entry) => reportedAppliedIds.includes(entry.id));
  if (reportedAppliedIds.length > 0 && reportedFiles.length === 0) {
    return repairPostApplyValidation({
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
      appliedEntryIds: reportedAppliedIds,
      files: result.files || [],
      failed: aiFailed,
      notes: result.notes || [],
      warnings: result.warnings || [],
      repairReason: 'missing_touched_files',
      repairFailures: verificationFailuresForEntries(batch, reportedAppliedEntries, 'missing_touched_files'),
    });
  }

  const verifiedAppliedIds = [];
  const verificationFailed = [];
  for (const entry of reportedAppliedEntries) {
    const failures = verifyAppliedEntry({ batch, entry, reportedFiles, cwd });
    if (failures.length === 0) {
      verifiedAppliedIds.push(entry.id);
    } else {
      verificationFailed.push({
        id: entry.id,
        reason: 'source_verification_failed',
        failures,
        candidates: candidatesForEntry(batch, entry.id),
      });
    }
  }
  const unreportedEntries = result.status === 'done' || result.status === 'partial'
    ? batch.entries.filter((entry) => !reportedAppliedIds.includes(entry.id) && !aiFailed.some((item) => item.id === entry.id))
    : [];
  const nonRepairFailed = [
    ...verificationFailuresForEntries(batch, unreportedEntries, 'not_reported_applied'),
    ...aiFailed,
  ];
  const failed = [
    ...verificationFailed,
    ...nonRepairFailed,
  ];

  const unappliedEntries = batch.entries.filter((entry) => !reportedAppliedIds.includes(entry.id));
  const leakedUnapplied = findUnappliedEntrySourceChanges({
    batch,
    entries: unappliedEntries,
    reportedFiles,
    cwd,
    rollbackSnapshot,
  });
  if (leakedUnapplied.length > 0) {
    const leakedIds = new Set(leakedUnapplied.map((item) => item.id).filter(Boolean));
    const rolledBackVerified = reportedAppliedEntries
      .filter((entry) => verifiedAppliedIds.includes(entry.id))
      .map((entry) => ({
        id: entry.id,
        reason: 'rolled_back_due_to_failed_entry_source_changed',
        candidates: candidatesForEntry(batch, entry.id),
      }));
    const rollback = rollbackChangedFiles(cwd, rollbackSnapshot, result.files || [], rollbackScope);
    return {
      applied: [],
      failed: [
        ...leakedUnapplied,
        ...failed.filter((item) => !leakedIds.has(item.id)),
        ...rolledBackVerified,
      ],
      files: result.files || [],
      cleared: 0,
      count,
      pageUrl,
      rolledBackFiles: rollback.rolledBackFiles,
      rollbackFailures: rollback.rollbackFailures,
      notes: result.notes || [],
      ...countByPage(cwd),
    };
  }

  if (verificationFailed.length > 0) {
    return repairPostApplyValidation({
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
      appliedEntryIds: reportedAppliedIds,
      files: result.files || [],
      failed: nonRepairFailed,
      notes: result.notes || [],
      warnings: result.warnings || [],
      repairReason: 'source_verification_failed',
      repairFailures: verificationFailed,
    });
  }

  const postChecks = runCopyEditPostApplyChecks({ cwd, files: result.files || [] });
  if (!postChecks.ok) {
    const postCheckEntries = verifiedAppliedIds.length > 0
      ? reportedAppliedEntries.filter((entry) => verifiedAppliedIds.includes(entry.id))
      : batch.entries;
    return repairPostApplyValidation({
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
      appliedEntryIds: verifiedAppliedIds.length > 0
        ? verifiedAppliedIds
        : postCheckEntries.map((entry) => entry.id).filter(Boolean),
      files: result.files || [],
      failed,
      notes: result.notes || [],
      warnings: [...(result.warnings || []), ...(postChecks.warnings || [])],
      postChecks,
    });
  }

  const cleared = clearAppliedEntries(cwd, verifiedAppliedIds);
  const counts = countByPage(cwd);
  return {
    applied: summarizeAppliedEntries(batch.entries, verifiedAppliedIds),
    failed,
    files: result.files || [],
    cleared,
    count,
    pageUrl,
    warnings: [...(result.warnings || []), ...(postChecks.warnings || [])],
    notes: result.notes || [],
    ...counts,
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: node live-commit-manual-edits.mjs [--page-url=<url>] [--provider=auto|codex|claude|mock]');
    process.exit(0);
  }

  const result = await commitManualEdits({
    cwd: process.cwd(),
    pageUrl: argVal(args, '--page-url'),
    provider: argVal(args, '--provider') || undefined,
    timeoutMs: Number(process.env.MONODESIGN_LIVE_COPY_AGENT_TIMEOUT_MS || 120000),
  });
  console.log(JSON.stringify(result));
}

if (process.argv[1]?.endsWith('live-commit-manual-edits.mjs')) {
  main().catch((err) => {
    console.error(JSON.stringify({ error: 'commit_failed', message: err.message || String(err) }));
    process.exit(1);
  });
}
