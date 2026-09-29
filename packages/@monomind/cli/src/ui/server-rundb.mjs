import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

// SSE client registry and mastermind SSE clients are managed by sse-manager.mjs
// Active org run tracking: org -> runId (enables event routing for orgs without runId in payload)
const activeOrgRuns = new Map();
// Active session tracking: org -> {sessionId, ts} (enables linking agent events to sessions)
const activeSessionsByOrg = new Map();
// Phase 3: Per-org SSE clients for run streaming tail endpoint
const runStreamClients = new Map(); // orgName → Set<res>

// Design doc Issue 2: concurrent write safety. Since server.mjs is the sole writer
// (all hook processes POST via HTTP), in-process serialization is sufficient.
// SQLite WAL (Issue 2 Phase 1.5): run events are indexed in an in-memory sql.js database
// with WAL mode and persisted to .monomind/run-events.db every 1000ms. JSONL files are
// still written (bash lifecycle scripts write them directly), but SQLite is the query layer
// for streaming tail replay and startup gap-fill.
//
// Serializing write queue — prevents concurrent JSONL corruption (Issue 2 from design doc)
const _writeQueue = new Map(); // filePath → Promise (in-flight write)

// ── sql.js WAL run-event index (Phase 1.5) ──────────────────────────────────
let _runDb = null; // sql.js in-memory Database
let _runDbPath = null; // disk path for persistence
let _runDbPersistTimer = null;
let _runDbInsertStmt = null; // prepared INSERT statement

const _require = createRequire(import.meta.url);

/**
 * Guard against a stale PID file outliving its process and the OS recycling
 * that PID for an unrelated process — verify the live process actually looks
 * like ours (node/npx running something under this project or monomind)
 * before signaling it or reporting it as "running".
 */
function looksLikeOurProcess(pid, dir) {
  try {
    const { execSync } = _require('child_process');
    const cmd = execSync(`ps -p ${pid} -o command=`, { timeout: 2000, encoding: 'utf-8' }).trim();
    const looksLikeNode = cmd.includes('node') || cmd.includes('npx') || cmd.includes('npm exec');
    return (
      looksLikeNode && (cmd.includes('monomind') || cmd.includes('monograph') || cmd.includes(dir))
    );
  } catch {
    return false;
  }
}

async function _initRunDb(monoHome) {
  try {
    const initSqlJs = _require('sql.js');
    const SQL = await initSqlJs();
    _runDbPath = path.join(monoHome, '.monomind', 'run-events.db');
    fs.mkdirSync(path.dirname(_runDbPath), { recursive: true });
    let fileData;
    try {
      fileData = fs.readFileSync(_runDbPath);
    } catch (_) {}
    _runDb = fileData ? new SQL.Database(fileData) : new SQL.Database();
    _runDb.run('PRAGMA journal_mode=WAL');
    _runDb.run('PRAGMA synchronous=NORMAL');
    _runDb.run(`CREATE TABLE IF NOT EXISTS run_events (
      id    INTEGER PRIMARY KEY AUTOINCREMENT,
      org   TEXT    NOT NULL,
      run_id TEXT   NOT NULL,
      type  TEXT    NOT NULL,
      raw   TEXT    NOT NULL,
      ts    INTEGER NOT NULL,
      source TEXT   DEFAULT 'http',
      UNIQUE(org, run_id, ts, type, raw)
    )`);
    _runDb.run('CREATE INDEX IF NOT EXISTS idx_re_org_id ON run_events(org, id)');
    _runDb.run('CREATE INDEX IF NOT EXISTS idx_re_ts    ON run_events(ts)');
    _runDbInsertStmt = _runDb.prepare(
      'INSERT OR IGNORE INTO run_events (org, run_id, type, raw, ts, source) VALUES (?,?,?,?,?,?)',
    );
    // Compact old events at startup: keep last 30 days
    const _cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    _runDb.run('DELETE FROM run_events WHERE ts < ?', [_cutoff]);
    _persistRunDb();
  } catch (_) {
    _runDb = null; // graceful fallback — JSONL path continues to work
  }
}

// Single-writer guard for the run-events.db snapshot persist: bindServer() can start a
// SECOND dashboard instance on port+1 when 4242 is already taken (two projects' dashboards
// running simultaneously, or a stale-but-still-bound old instance). Each instance holds an
// independent in-memory sql.js copy; without a lock, each instance's periodic full-snapshot
// overwrite silently clobbers the other's accumulated events (last writer wins, no error).
// Claiming this lock before every snapshot write ensures only ONE live instance actually
// persists at a time — the other still runs, just skips its write until it can claim the
// lock (e.g. after the current holder exits and its lock goes stale). This doesn't merge
// both instances' events into one file, but it stops them from destructively overwriting
// each other. Pattern mirrors .claude/helpers/utils/fs-helpers.cjs's claimLock/releaseLock
// (wx-create, rename-to-reclaim-stale) — replicated inline here since this file ships
// standalone in the published package and can't depend on repo-local dev tooling.
function _runDbLockPath() {
  return _runDbPath ? `${_runDbPath}.lock` : null;
}

function _claimRunDbLock(staleMs) {
  const lockPath = _runDbLockPath();
  if (!lockPath) return false;
  staleMs = staleMs || 5000;
  const tryCreate = () => {
    try {
      fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
      return true;
    } catch (_) {
      return false;
    }
  };
  if (tryCreate()) return true;
  try {
    const stat = fs.statSync(lockPath);
    if (Date.now() - stat.mtimeMs < staleMs) return false; // held by a live/fresh owner
    // Stale lock — reclaim via atomic rename so only one racing process wins it.
    const claimed = `${lockPath}.${process.pid}.${Date.now()}.stale`;
    try {
      fs.renameSync(lockPath, claimed);
    } catch (_) {
      return false; // another process already reclaimed it
    }
    try {
      fs.unlinkSync(claimed);
    } catch (_) {}
    return tryCreate();
  } catch (_) {
    // Lock vanished between our failed create and this stat — retry once.
    return tryCreate();
  }
}

function _releaseRunDbLock() {
  const lockPath = _runDbLockPath();
  if (!lockPath) return;
  try {
    if (Number(fs.readFileSync(lockPath, 'utf8')) === process.pid) fs.unlinkSync(lockPath);
  } catch (_) {}
}

function _writeRunDbSnapshot() {
  if (!_runDb || !_runDbPath) return;
  if (!_claimRunDbLock()) return; // another live instance owns the write right now
  try {
    fs.writeFileSync(_runDbPath, Buffer.from(_runDb.export()));
  } catch (_) {
    // best-effort — matches prior swallow-on-error behavior
  } finally {
    _releaseRunDbLock();
  }
}

function _persistRunDb() {
  if (!_runDb || !_runDbPath) return;
  clearTimeout(_runDbPersistTimer);
  _runDbPersistTimer = setTimeout(_writeRunDbSnapshot, 1000);
}

/**
 * Flush the pending snapshot and release the sql.js database (shutdown and a
 * failed start, #477). The debounce timer it clears would otherwise keep a
 * process that never bound a port alive for another second, and the WASM heap
 * holding the database is only returned by close().
 */
function _closeRunDb() {
  clearTimeout(_runDbPersistTimer);
  _runDbPersistTimer = null;
  if (!_runDb) return;
  _writeRunDbSnapshot();
  try {
    _runDbInsertStmt?.free();
  } catch (_) {}
  try {
    _runDb.close();
  } catch (_) {}
  _runDb = null;
  _runDbInsertStmt = null;
}

function _insertRunEvent(ev, source) {
  if (!_runDb || !_runDbInsertStmt) return;
  try {
    const org = String(ev.org || '').trim();
    const runId = String(ev.runId || '').trim();
    if (!org || !runId) return;
    _runDbInsertStmt.run([
      org,
      runId,
      String(ev.type || ''),
      JSON.stringify(ev),
      Number(ev.ts || Date.now()),
      source || 'http',
    ]);
    _persistRunDb();
  } catch (_) {
    // sql.js leaves the prepared statement in a dirty state after any error (step() throws but
    // reset() is never called). Reset it so subsequent inserts aren't permanently broken.
    try {
      _runDbInsertStmt.reset();
    } catch (_2) {}
  }
}

export {
  _closeRunDb,
  _initRunDb,
  _insertRunEvent,
  _persistRunDb,
  _require,
  _runDb,
  _runDbPersistTimer,
  _writeQueue,
  _writeRunDbSnapshot,
  activeOrgRuns,
  activeSessionsByOrg,
  looksLikeOurProcess,
  runStreamClients,
};
