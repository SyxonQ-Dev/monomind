// Live server session state: config, the shared `state` object, the pending
// event/poll queue, manual-edit coordination, and small request-auth helpers.
// Split out of live-server.mjs (file-size sweep — pure move, no behaviour
// change). Imported by live-server-routes.mjs, live-server-poll.mjs and
// live-server.mjs itself.

import path from 'node:path';
import fs from 'node:fs';
import net from 'node:net';
import { loadContext } from './context.mjs';
import { getLiveDir } from './lib/monodesign-paths.mjs';
import { countByPage as countPendingByPage } from './live/manual-edits-buffer.mjs';
import { createManualApplyController } from './live/manual-apply.mjs';
import { createManualEditRoutes } from './live/manual-edit-routes.mjs';

// PRODUCT.md / DESIGN.md live wherever context.mjs resolves. The generated
// DESIGN sidecar is project-local at .monodesign/design.json, with legacy
// DESIGN.json fallback for existing projects.
const PROJECT_CONTEXT = loadContext(process.cwd());
const CONTEXT_DIR = PROJECT_CONTEXT.contextDir;
const DESIGN_MD_PATH = PROJECT_CONTEXT.designPath
  ? path.resolve(process.cwd(), PROJECT_CONTEXT.designPath)
  : null;
const DEFAULT_POLL_TIMEOUT = 600_000;   // 10 min — agent re-polls on timeout anyway
const SSE_HEARTBEAT_INTERVAL = 30_000;  // keepalive ping every 30s
// Query param name every protected route checks against the per-process credential.
const AUTH_QUERY_KEY = 'token';

// ---------------------------------------------------------------------------
// Port detection
// ---------------------------------------------------------------------------

async function findOpenPort(start = 8400) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(start, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', () => resolve(findOpenPort(start + 1)));
  });
}

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

const state = {
  token: null,
  port: null,
  sseClients: new Set(),   // SSE response objects (server→browser push)
  pendingEvents: [],        // browser events waiting for agent ack ({ event, leaseUntil })
  pendingPolls: [],         // agent poll callbacks waiting for browser events
  nextEventSeq: 1,
  lastAgentPollingBroadcast: null,
  exitTimer: null,
  sessionDir: null,         // per-session tmp dir for annotation screenshots
  sessionStore: null,
  leaseTimer: null,
  manualEditActivity: null,
  nextManualEditSeq: 1,
  // Deferreds for in-flight chat-routed Apply events. Keyed by event id; each
  // entry is resolved when the chat agent POSTs an ack carrying the batch
  // result, or rejected when the hard timeout fires.
  pendingApplyDeferreds: new Map(),
  // Updated whenever a /poll long-poll request arrives or is resolved with an
  // event. Used to detect "a chat agent is likely attached" without requiring
  // a poll to be parked at the exact moment we dispatch.
  lastPollAt: 0,
  timedOutApplyIds: new Map(),
};

const CHAT_POLL_FRESHNESS_MS = 60_000;
const POLL_LEASE_EXPIRY_TIMER_GRACE_MS = 2;
const DEBUG_MANUAL_EDIT_EVENTS = /^(1|true|yes)$/i.test(process.env.MONODESIGN_LIVE_DEBUG_EVENTS || '');

const manualApply = createManualApplyController({
  pendingEvents: state.pendingEvents,
  pendingApplyDeferreds: state.pendingApplyDeferreds,
  timedOutApplyIds: state.timedOutApplyIds,
  enqueueEvent,
  acknowledgePendingEvent,
  flushPendingPolls,
  recordManualEditActivity,
  cwd: () => process.cwd(),
});

const manualEditRoutes = createManualEditRoutes({
  getToken: () => state.token,
  manualApply,
  recordManualEditActivity,
  getManualEditStatus,
  chatAgentLikelyActive,
  cwd: () => process.cwd(),
  env: () => process.env,
});

function chatAgentLikelyActive() {
  if (state.pendingPolls.length > 0) return true;
  if (!state.lastPollAt) return false;
  return Date.now() - state.lastPollAt < CHAT_POLL_FRESHNESS_MS;
}

// Cap per-annotation upload size. A full 1920×1080 PNG is typically <1 MB;
// cap at 10 MB to guard against runaway writes from a misbehaving client.
const MAX_ANNOTATION_BYTES = 10 * 1024 * 1024;

function enqueueEvent(event) {
  if (!event || (event.id && state.pendingEvents.some((entry) => entry.event?.id === event.id && entry.event?.type === event.type))) return;
  state.pendingEvents.push({ event, leaseUntil: 0, seq: state.nextEventSeq++ });
  flushPendingPolls();
}

function restorePendingEventsFromStore() {
  if (!state.sessionStore) return;
  for (const snapshot of state.sessionStore.listActiveSessions()) {
    if (snapshot.pendingEvent) enqueueEvent(snapshot.pendingEvent);
  }
}

function findAvailablePendingEvent(now = Date.now()) {
  for (const entry of state.pendingEvents) {
    if (entry.leaseUntil && entry.leaseUntil > now) continue;
    return entry;
  }
  return null;
}

function leaseEvent(entry, leaseMs) {
  if (!entry.event?.id) {
    const idx = state.pendingEvents.indexOf(entry);
    if (idx !== -1) state.pendingEvents.splice(idx, 1);
    return entry.event;
  }
  entry.leaseUntil = Date.now() + leaseMs;
  scheduleLeaseFlush();
  broadcastAgentPollingIfChanged();
  return entry.event;
}

function acknowledgePendingEvent(id) {
  if (!id) return false;
  const idx = state.pendingEvents.findIndex((entry) => entry.event?.id === id);
  if (idx === -1) return false;
  const acknowledged = state.pendingEvents[idx].event;
  state.pendingEvents.splice(idx, 1);
  scheduleLeaseFlush();
  broadcastAgentPollingIfChanged();
  return acknowledged;
}

function findPendingEventById(id) {
  if (!id) return null;
  const entry = state.pendingEvents.find((item) => item.event?.id === id);
  return entry?.event || null;
}

function summarizePendingEventForStatus(entry) {
  const event = entry.event || {};
  const summary = {
    id: event.id,
    type: event.type,
    leased: !!(entry.leaseUntil && entry.leaseUntil > Date.now()),
    leaseUntil: entry.leaseUntil || null,
  };
  if (event.type === 'manual_edit_apply') {
    summary.pageUrl = event.pageUrl || null;
    summary.chunk = event.chunk || null;
    summary.repair = event.repair || null;
    summary.evidencePath = event.evidencePath || null;
    summary.agentAction = event.agentAction || manualApply.buildAgentAction(event);
    summary.manualApplySummary = manualApply.summarizeEvent(event, manualApply.getDeferred(event.id)?.batch || event.batch);
  }
  return summary;
}

function summarizeActiveSessionForClient(snapshot = {}) {
  return {
    id: snapshot.id,
    phase: snapshot.phase,
    pageUrl: snapshot.pageUrl ?? null,
    sourceFile: snapshot.sourceFile ?? null,
    previewFile: snapshot.previewFile ?? null,
    previewMode: snapshot.previewMode ?? null,
    expectedVariants: snapshot.expectedVariants ?? 0,
    arrivedVariants: snapshot.arrivedVariants ?? 0,
    visibleVariant: snapshot.visibleVariant ?? null,
    checkpointRevision: snapshot.checkpointRevision ?? 0,
    paramValues: snapshot.paramValues || {},
  };
}

function activeSessionSummaries() {
  if (!state.sessionStore) return [];
  return state.sessionStore.listActiveSessions().map((snapshot) => summarizeActiveSessionForClient(snapshot));
}

function cancelQueuedAnonymousExitEvents() {
  let removed = 0;
  for (let i = state.pendingEvents.length - 1; i >= 0; i -= 1) {
    const event = state.pendingEvents[i]?.event;
    if (event?.type !== 'exit' || event.id) continue;
    state.pendingEvents.splice(i, 1);
    removed += 1;
  }
  if (removed > 0) {
    scheduleLeaseFlush();
    broadcastAgentPollingIfChanged();
  }
  return removed;
}

function scheduleLeaseFlush() {
  if (state.leaseTimer) {
    clearTimeout(state.leaseTimer);
    state.leaseTimer = null;
  }
  const now = Date.now();
  const nextLeaseUntil = state.pendingEvents
    .map((entry) => entry.leaseUntil || 0)
    .filter((leaseUntil) => leaseUntil > now)
    .sort((a, b) => a - b)[0];
  if (!nextLeaseUntil) return;
  state.leaseTimer = setTimeout(() => {
    state.leaseTimer = null;
    flushPendingPolls();
    broadcastAgentPollingIfChanged();
  }, Math.max(0, nextLeaseUntil - now + POLL_LEASE_EXPIRY_TIMER_GRACE_MS));
}

function flushPendingPolls() {
  let changed = false;
  while (state.pendingPolls.length > 0) {
    const entry = findAvailablePendingEvent();
    if (!entry) {
      scheduleLeaseFlush();
      broadcastAgentPollingIfChanged();
      return;
    }
    const poll = state.pendingPolls.shift();
    poll.resolve(leaseEvent(entry, poll.leaseMs));
    changed = true;
  }
  scheduleLeaseFlush();
  if (changed) broadcastAgentPollingIfChanged();
}

function agentPollingConnected() {
  const now = Date.now();
  return state.pendingPolls.length > 0
    || state.pendingEvents.some((entry) => entry.leaseUntil && entry.leaseUntil > now);
}

function broadcastAgentPollingIfChanged() {
  const connected = agentPollingConnected();
  if (state.lastAgentPollingBroadcast === connected) return;
  state.lastAgentPollingBroadcast = connected;
  broadcast({ type: 'agent_polling', connected });
}

/** Push a message to all connected SSE clients. */
function broadcast(msg) {
  const data = `data: ${JSON.stringify(msg)}\n\n`;
  for (const res of state.sseClients) {
    try { res.write(data); } catch { /* client gone */ }
  }
}

function recordManualEditActivity(type, details = {}) {
  const entry = {
    seq: state.nextManualEditSeq++,
    type,
    ts: new Date().toISOString(),
    ...details,
  };
  state.manualEditActivity = entry;
  if (DEBUG_MANUAL_EDIT_EVENTS) {
    try {
      const filePath = path.join(getLiveDir(process.cwd()), 'manual-edit-events.jsonl');
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`);
    } catch {
      /* diagnostics are best-effort; never block live mode on observability */
    }
  }
  broadcast(entry);
  return entry;
}

function getManualEditStatus() {
  try {
    const { totalCount, perPage } = countPendingByPage(process.cwd());
    return { totalCount, perPage, lastActivity: state.manualEditActivity };
  } catch (err) {
    return {
      totalCount: null,
      perPage: {},
      lastActivity: state.manualEditActivity,
      error: err.message,
    };
  }
}
function hasProjectContext() {
  // PRODUCT.md carries brand voice / anti-references — that's what determines
  // whether variants are brand-aware. DESIGN.md (visual tokens) is a separate
  // concern, surfaced by the design panel's own empty state.
  return !!PROJECT_CONTEXT.hasProduct;
}

function statOrNull(filePath) {
  try { return fs.statSync(filePath); } catch { return null; }
}

// Shared gate for every protected route, including /live.js (see its call
// site for why that one needs it too). Writes the 401 itself and returns
// false so callers can `if (!requireAuthQueryCred(url, res)) return;`.
function requireAuthQueryCred(url, res) {
  const provided = url.searchParams.get(AUTH_QUERY_KEY);
  const expected = state[AUTH_QUERY_KEY];
  if (provided !== expected) {
    res.writeHead(401);
    res.end('Unauthorized');
    return false;
  }
  return true;
}

export {
  PROJECT_CONTEXT,
  CONTEXT_DIR,
  DESIGN_MD_PATH,
  DEFAULT_POLL_TIMEOUT,
  SSE_HEARTBEAT_INTERVAL,
  AUTH_QUERY_KEY,
  findOpenPort,
  state,
  MAX_ANNOTATION_BYTES,
  manualApply,
  manualEditRoutes,
  chatAgentLikelyActive,
  enqueueEvent,
  restorePendingEventsFromStore,
  findAvailablePendingEvent,
  leaseEvent,
  acknowledgePendingEvent,
  findPendingEventById,
  summarizePendingEventForStatus,
  summarizeActiveSessionForClient,
  activeSessionSummaries,
  cancelQueuedAnonymousExitEvents,
  scheduleLeaseFlush,
  flushPendingPolls,
  agentPollingConnected,
  broadcastAgentPollingIfChanged,
  broadcast,
  recordManualEditActivity,
  getManualEditStatus,
  hasProjectContext,
  statOrNull,
  requireAuthQueryCred,
};
