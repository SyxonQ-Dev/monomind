// Live server agent-poll endpoints: long-poll GET (agent waits for the next
// browser event) and POST (agent replies with a result). Split out of
// live-server.mjs (file-size sweep — pure move, no behaviour change).

import fs from 'node:fs';
import path from 'node:path';
import { summarizeManualApplyFailures } from './live/manual-apply.mjs';
import {
  state,
  DEFAULT_POLL_TIMEOUT,
  manualApply,
  findAvailablePendingEvent,
  leaseEvent,
  acknowledgePendingEvent,
  findPendingEventById,
  scheduleLeaseFlush,
  flushPendingPolls,
  broadcastAgentPollingIfChanged,
  broadcast,
  recordManualEditActivity,
} from './live-server-state.mjs';

// ---------------------------------------------------------------------------
// Agent poll endpoints (unchanged from WS version)
// ---------------------------------------------------------------------------

function handlePollGet(req, res, url) {
  const token = url.searchParams.get('token');
  if (token !== state.token) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }
  state.lastPollAt = Date.now();
  const timeout = parseInt(url.searchParams.get('timeout') || DEFAULT_POLL_TIMEOUT, 10);
  const leaseMs = parseInt(url.searchParams.get('leaseMs') || '30000', 10);
  const available = findAvailablePendingEvent();
  if (available) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(leaseEvent(available, leaseMs)));
    return;
  }
  const poll = { resolve, leaseMs };
  const timer = setTimeout(() => {
    const idx = state.pendingPolls.indexOf(poll);
    if (idx !== -1) state.pendingPolls.splice(idx, 1);
    broadcastAgentPollingIfChanged();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'timeout' }));
  }, timeout);
  function resolve(event) {
    clearTimeout(timer);
    state.lastPollAt = Date.now();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(event));
  }
  state.pendingPolls.push(poll);
  broadcastAgentPollingIfChanged();
  scheduleLeaseFlush();
  req.on('close', () => {
    clearTimeout(timer);
    const idx = state.pendingPolls.indexOf(poll);
    if (idx !== -1) state.pendingPolls.splice(idx, 1);
    broadcastAgentPollingIfChanged();
  });
}

function sessionFileMetadataFromPollReply(file) {
  if (!file || typeof file !== 'string') return { file };
  const normalized = file.split(path.sep).join('/');
  const base = { file: normalized };
  if (!normalized.endsWith('/manifest.json') && normalized !== 'manifest.json') return base;
  if (!normalized.includes('node_modules/.monodesign-live/') && !normalized.includes('src/lib/monodesign/')) return base;

  let full;
  try {
    full = path.resolve(process.cwd(), normalized);
    const rel = path.relative(process.cwd(), full).split(path.sep).join('/');
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return base;
  } catch {
    return base;
  }

  try {
    const manifest = JSON.parse(fs.readFileSync(full, 'utf-8'));
    if (manifest?.previewMode !== 'svelte-component' || !manifest.sourceFile) return base;
    return {
      file: String(manifest.sourceFile).split(path.sep).join('/'),
      sourceFile: String(manifest.sourceFile).split(path.sep).join('/'),
      previewFile: normalized,
      previewMode: 'svelte-component',
    };
  } catch {
    return base;
  }
}

function handlePollPost(req, res) {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let msg;
    try { msg = JSON.parse(body); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }
    if (msg.token !== state.token) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    const pendingApplyDeferred = manualApply.getDeferred(msg.id);
    if (pendingApplyDeferred) {
      const validation = manualApply.validateResultMessage(msg, pendingApplyDeferred);
      if (!validation.ok) {
        recordManualEditActivity('manual_edit_apply_reply_invalid', {
          id: msg.id,
          pageUrl: pendingApplyDeferred.pageUrl,
          chunk: pendingApplyDeferred.event?.chunk || null,
          repair: pendingApplyDeferred.event?.repair || null,
          reason: validation.body?.reason || validation.body?.error || 'invalid_manual_apply_result',
          status: msg.data?.status || null,
        });
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(validation.body));
        return;
      }
      recordManualEditActivity('manual_edit_apply_reply_received', {
        id: msg.id,
        pageUrl: pendingApplyDeferred.pageUrl,
        chunk: pendingApplyDeferred.event?.chunk || null,
        repair: pendingApplyDeferred.event?.repair || null,
        status: validation.result.status,
        appliedCount: validation.result.appliedEntryIds.length,
        failed: summarizeManualApplyFailures(validation.result.failed),
        fileCount: validation.result.files.length,
        noteCount: validation.result.notes.length,
      });
      manualApply.resolveDeferred(msg.id, validation.result);
      acknowledgePendingEvent(msg.id);
      flushPendingPolls();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (manualApply.hasTimedOutId(msg.id)) {
      const rollback = manualApply.rollbackTimedOutReply(msg);
      recordManualEditActivity('manual_edit_apply_stale_reply_rejected', {
        id: msg.id,
        rolledBackFileCount: rollback.rolledBackFiles?.length || 0,
        rollbackFailureCount: rollback.rollbackFailures?.length || 0,
      });
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'stale_manual_edit_apply_reply', ...rollback }));
      return;
    }
    const pendingEventBeforeAck = findPendingEventById(msg.id);
    if (pendingEventBeforeAck?.type === 'steer' && msg.type === 'steer_done'
        && !msg.file && !(typeof msg.message === 'string' && msg.message.trim())) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'steer_done_requires_file_or_message',
        hint: 'Reply with --file after writing source, or include a message explaining an intentional no-op.',
      }));
      return;
    }
    const acknowledgedEvent = acknowledgePendingEvent(msg.id);
    let skipJournalReply = false;
    let existingSession = null;
    if (!acknowledgedEvent && state.sessionStore && msg.id) {
      try {
        existingSession = state.sessionStore.getSnapshot(msg.id, { includeCompleted: true });
        if (!existingSession?.updatedAt) existingSession = null;
        skipJournalReply = existingSession?.phase === 'completed' || existingSession?.phase === 'discarded';
      } catch { /* fall through and record the reply normally */ }
    }
    if (!acknowledgedEvent && !existingSession) {
      recordManualEditActivity('manual_edit_poll_reply_unknown', {
        id: msg.id || null,
        type: msg.type || null,
      });
      res.writeHead(msg.id ? 404 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: msg.id ? 'unknown_poll_reply_id' : 'missing_poll_reply_id',
        id: msg.id,
      }));
      return;
    }
    const replyFileMeta = sessionFileMetadataFromPollReply(msg.file);
    if (state.sessionStore && msg.id && !skipJournalReply) {
      try {
        const eventType = msg.type === 'steer_done'
          ? 'steer_done'
          : msg.type === 'discard' || msg.type === 'discarded'
            ? 'discarded'
            : msg.type === 'complete'
              ? 'complete'
              : msg.type === 'error'
                ? 'agent_error'
                : 'agent_done';
        state.sessionStore.appendEvent({
          type: eventType,
          id: msg.id,
          file: replyFileMeta.file,
          sourceFile: replyFileMeta.sourceFile,
          previewFile: replyFileMeta.previewFile,
          previewMode: replyFileMeta.previewMode,
          message: msg.message,
          sourceEventType: acknowledgedEvent?.type,
          carbonize: msg.data?.carbonize === true,
        });
      } catch { /* keep reply path best-effort; browser still needs SSE */ }
    }
    flushPendingPolls();
    // Forward the reply to the browser via SSE
    broadcast({
      type: msg.type || 'done',
      id: msg.id,
      message: msg.message,
      file: msg.file,
      sourceFile: replyFileMeta.sourceFile,
      previewFile: replyFileMeta.previewFile,
      previewMode: replyFileMeta.previewMode,
      data: msg.data,
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
}

export { handlePollGet, handlePollPost };
