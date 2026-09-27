/**
 * Whole-batch rollback transaction for manual-apply.mjs: snapshotting every
 * file a batch touches before dispatch and restoring them if the batch never
 * gets fully applied (e.g. the live server restarts mid-Apply).
 *
 * Split out of manual-apply.mjs. See that file for context.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getLiveDir } from '../lib/monodesign-paths.mjs';
import { readBuffer as readManualEditsBuffer } from './manual-edits-buffer.mjs';
import { collectManualApplyFiles, normalizeProjectFile } from './manual-apply-evidence.mjs';
import { summarizeManualDiagnostics, summarizeManualLogFile } from './manual-apply-log.mjs';

export function manualApplyTransactionPath(cwd = process.cwd()) {
  return path.join(getLiveDir(cwd), 'manual-edit-apply-transaction.json');
}

export function readManualApplyTransaction(cwd = process.cwd()) {
  const file = manualApplyTransactionPath(cwd);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

export function writeManualApplyTransaction({ cwd = process.cwd(), pageUrl = null, batch }) {
  const file = manualApplyTransactionPath(cwd);
  const files = collectManualApplyFiles(batch, [], cwd);
  const transaction = {
    version: 1,
    id: randomUUID().replace(/-/g, '').slice(0, 8),
    createdAt: new Date().toISOString(),
    pageUrl,
    entryIds: (batch?.entries || []).map((entry) => entry.id).filter(Boolean),
    files: files.map((relativeFile) => {
      const absolute = path.resolve(cwd, relativeFile);
      const exists = fs.existsSync(absolute);
      return {
        file: relativeFile,
        exists,
        content: exists ? fs.readFileSync(absolute, 'utf-8') : '',
      };
    }),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(transaction, null, 2)}\n`, 'utf-8');
  fs.renameSync(`${file}.tmp`, file);
  return transaction;
}

export function clearManualApplyTransaction(cwd = process.cwd(), transactionId = null) {
  const file = manualApplyTransactionPath(cwd);
  if (!fs.existsSync(file)) return false;
  if (transactionId) {
    const existing = readManualApplyTransaction(cwd);
    if (existing?.id && existing.id !== transactionId) return false;
  }
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}


export function rollbackManualApplyTransaction({
  cwd = process.cwd(),
  pageUrl = null,
  reason = 'manual_edit_transaction_rollback',
  recordManualEditActivity = null,
} = {}) {
  const transaction = readManualApplyTransaction(cwd);
  if (!transaction) return null;
  if (pageUrl && transaction.pageUrl && transaction.pageUrl !== pageUrl) return null;

  let pendingIds = new Set();
  try {
    const buffer = readManualEditsBuffer(cwd);
    pendingIds = new Set((buffer.entries || []).map((entry) => entry.id).filter(Boolean));
  } catch {
    pendingIds = new Set(transaction.entryIds || []);
  }
  const shouldRollback = (transaction.entryIds || []).some((id) => pendingIds.has(id));
  if (!shouldRollback) {
    clearManualApplyTransaction(cwd, transaction.id);
    return { id: transaction.id, reason, rolledBackFiles: [], rollbackFailures: [], skipped: 'entries_not_pending' };
  }

  const rolledBackFiles = [];
  const rollbackFailures = [];
  for (const item of transaction.files || []) {
    const relativeFile = normalizeProjectFile(item.file, cwd);
    if (!relativeFile) continue;
    const absolute = path.resolve(cwd, relativeFile);
    try {
      if (item.exists) {
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        fs.writeFileSync(absolute, item.content || '', 'utf-8');
      } else if (fs.existsSync(absolute)) {
        fs.rmSync(absolute);
      }
      rolledBackFiles.push(relativeFile);
    } catch (err) {
      rollbackFailures.push({ file: relativeFile, reason: 'restore_failed', message: err.message || String(err) });
    }
  }
  clearManualApplyTransaction(cwd, transaction.id);
  recordManualEditActivity?.('manual_edit_transaction_rolled_back', {
    id: transaction.id,
    pageUrl: transaction.pageUrl || null,
    reason,
    entryIds: transaction.entryIds || [],
    rolledBackFiles: rolledBackFiles.map((file) => summarizeManualLogFile(file, cwd)).filter(Boolean),
    rollbackFailures: summarizeManualDiagnostics(rollbackFailures, cwd),
  });
  return { id: transaction.id, reason, rolledBackFiles, rollbackFailures };
}
