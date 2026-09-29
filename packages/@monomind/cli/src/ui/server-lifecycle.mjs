import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { SESSION_ID_RE } from './server-constants.mjs';
import { activeWatchers, watchSafely, watchTree } from './server-net.mjs';
import { _insertRunEvent, activeOrgRuns, runStreamClients } from './server-rundb.mjs';
import { pathToSections } from './server-session-utils.mjs';
import { broadcast, broadcastMm, writeSse } from './sse-manager.mjs';

// ── Phase 1: fs.watch orgs dir — pick up run events written directly to JSONL files
// without going through the HTTP endpoint (e.g. when runorg.md bash writes run:start directly).
// Also forwards new bytes to per-org SSE clients (runStreamClients) so the chat tab
// receives bash-written lifecycle events in real-time (Phase 3 gap-fill).
// Module-scope (not inside the factory below): server.mjs's watchOrgsDir — kept there
// because a source-pattern test asserts its chokidar.watch() call lives in server.mjs —
// shares this same Map to dedupe already-seen bytes when seeding initial file sizes.
const _orgsFileSizes = new Map(); // absPath → last known byte offset
const _MAX_ORGS_FILE_SIZES = 1000;
function _readNewOrgLines(absPath, orgName, runId) {
  try {
    const stat = fs.statSync(absPath);
    const prevSize = _orgsFileSizes.get(absPath) || 0;
    if (stat.size <= prevSize) return; // nothing new
    if (!_orgsFileSizes.has(absPath) && _orgsFileSizes.size >= _MAX_ORGS_FILE_SIZES) {
      const oldest = _orgsFileSizes.keys().next().value;
      _orgsFileSizes.delete(oldest);
    }
    _orgsFileSizes.set(absPath, stat.size);
    // Read only the new bytes to avoid re-processing existing lines
    const fd = fs.openSync(absPath, 'r');
    const newLen = stat.size - prevSize;
    const buf = Buffer.alloc(newLen);
    fs.readSync(fd, buf, 0, newLen, prevSize);
    fs.closeSync(fd);
    const newText = buf.toString('utf8');
    const newLines = newText.split('\n').filter(Boolean);
    const clients = runStreamClients.get(orgName);
    for (const _rawLine of newLines) {
      let ev;
      try {
        ev = JSON.parse(_rawLine);
      } catch {
        continue;
      }
      if (!ev?.type) continue;
      // Index in SQLite (watcher path — bash-written lifecycle events)
      if (!ev.org) ev.org = orgName;
      if (!ev.runId) ev.runId = runId;
      _insertRunEvent(ev, 'watcher');
      // Update activeOrgRuns based on file-watcher evidence
      if ((ev.type === 'run:start' || ev.type === 'org:start') && ev.runId) {
        activeOrgRuns.set(orgName, String(ev.runId).trim());
      } else if (
        ev.type === 'run:complete' ||
        ev.type === 'org:complete' ||
        ev.type === 'org:stop'
      ) {
        activeOrgRuns.delete(orgName);
      }
      // Forward to per-org SSE clients so the chat tab gets live bash-written events
      if (clients && clients.size > 0) {
        const _sseData = `data: ${_rawLine}\n\n`;
        for (const _cl of clients) writeSse(_cl, _sseData, clients);
      }
      // Also broadcast to mastermind-stream for the org activity strip
      if (ev.org && ev.org === orgName) broadcastMm({ ...ev, _fromWatcher: true });
    }
  } catch (_) {}
}

// server.mjs's watchOrgsDir helpers, extracted to keep that function (which stays in
// server.mjs for the chokidar.watch() source-pattern test) small. Pure move — same
// logic, called inline from watchOrgsDir.

// Orgs dir may not exist yet; watch parent and re-try when it appears.
function watchOrgsParentDir(_orgsDir, retry) {
  const _parentDir = path.dirname(_orgsDir);
  if (!fs.existsSync(_parentDir)) return;
  try {
    // One-shot (#477): it used to stay open after the retry — never closed on
    // shutdown, and every later event naming `orgs` started another orgs watcher.
    const _parentWatcher = watchSafely(
      fs.watch(_parentDir, (_evType, _fname) => {
        if (_fname !== 'orgs' || !fs.existsSync(_orgsDir)) return;
        _parentWatcher.close();
        const idx = activeWatchers.indexOf(_parentWatcher);
        if (idx !== -1) activeWatchers.splice(idx, 1);
        retry();
      }),
      'orgs-parent',
    );
    activeWatchers.push(_parentWatcher);
  } catch (_) {}
}

// Self-report the ACTUAL bound port for the spawner (control-start.cjs).
// An HTTP probe cannot distinguish this server from another project's server
// already answering on the requested port — this file is identity-proof.
function reportBoundPort(boundPort, pid = process.pid) {
  if (!process.env.MONOMIND_BOUND_REPORT) return;
  try {
    fs.mkdirSync(path.dirname(process.env.MONOMIND_BOUND_REPORT), { recursive: true });
    fs.writeFileSync(
      process.env.MONOMIND_BOUND_REPORT,
      JSON.stringify({ pid, port: boundPort, ts: Date.now() }),
    );
  } catch (_) {
    /* non-fatal — spawner falls back to pid-matched HTTP probe */
  }
}

// Seed initial file sizes so the watcher only forwards NEW bytes after startup.
function seedOrgsFileSizes(_orgsDir) {
  try {
    for (const _org of fs.readdirSync(_orgsDir)) {
      const _runsDir = path.join(_orgsDir, _org, 'runs');
      if (!fs.existsSync(_runsDir)) continue;
      for (const _f of fs
        .readdirSync(_runsDir)
        .filter(
          (f) =>
            f.endsWith('.jsonl') &&
            !f.startsWith('._') &&
            !f.endsWith('.warm.jsonl') &&
            !f.endsWith('.convs.jsonl'),
        )) {
        try {
          const _absF = path.join(_runsDir, _f);
          if (_orgsFileSizes.size >= _MAX_ORGS_FILE_SIZES) {
            const _k = _orgsFileSizes.keys().next().value;
            _orgsFileSizes.delete(_k);
          }
          _orgsFileSizes.set(_absF, fs.statSync(_absF).size);
        } catch (_) {}
      }
    }
  } catch (_) {}
}

// fs.watch fallback for when chokidar is unavailable.
function startOrgsFsWatchFallback(_orgsDir) {
  try {
    const _orgsWatcher = watchSafely(
      watchTree(
        _orgsDir,
        (_evType, _fname) => {
          if (
            !_fname?.endsWith('.jsonl') ||
            _fname.endsWith('.warm.jsonl') ||
            _fname.endsWith('.convs.jsonl')
          )
            return;
          const _parts = _fname.replace(/\\/g, '/').split('/');
          if (_parts.length >= 3 && _parts[1] === 'runs') {
            const _wOrgName = _parts[0];
            const _wRunId = _parts[2].replace('.jsonl', '');
            if (
              _wOrgName &&
              _wRunId &&
              /^[a-z0-9][a-z0-9_-]*$/i.test(_wOrgName) &&
              /^[a-z0-9][a-z0-9_-]*$/i.test(_wRunId)
            ) {
              _readNewOrgLines(path.join(_orgsDir, _fname.replace(/\\/g, '/')), _wOrgName, _wRunId);
            }
          }
        },
        { persistent: false },
      ),
      'orgs-fswatch',
    );
    activeWatchers.push(_orgsWatcher);
  } catch (_wErr) {
    console.warn(
      '[monomind] watchOrgsDir: both chokidar and fs.watch failed — bash-written lifecycle events will not reach SSE clients. HTTP-posted events still work via spool DLQ.',
    );
  }
}

// Post-bind startup tasks extracted from startServer(): one-time session-format
// migration, live-refresh watchers (excluding the orgs-dir/chokidar watcher, which
// stays in server.mjs — a source-pattern test asserts it there), and the spool/
// read-batch/heartbeat background pollers. Called once, right after bindServer().
// Returns stopBackgroundTasks (called by shutdown(), which stays in server.mjs since it
// mutates that module's own running/currentPort/currentUrl/_activeServer state).
function setupServerLifecycle({ projectDir, MONOMIND_HOME, boundPort }) {
  // ── One-time migration: mastermind-sessions.json → per-session JSONL ─────
  // Runs once on startup. Existing sessions in the old monolithic format are
  // split into individual JSONL files + _index.json for O(1) event writes.
  try {
    const _migDataDir = path.join(projectDir || process.cwd(), 'data');
    const _migOldFile = path.join(_migDataDir, 'mastermind-sessions.json');
    const _migSessDir = path.join(_migDataDir, 'sessions');
    const _migIndexFile = path.join(_migSessDir, '_index.json');
    if (fs.existsSync(_migOldFile) && !fs.existsSync(_migIndexFile)) {
      try {
        const _migOld = JSON.parse(fs.readFileSync(_migOldFile, 'utf8'));
        fs.mkdirSync(_migSessDir, { recursive: true });
        const _migIndex = [];
        for (const sess of _migOld || []) {
          const _msid = String(sess.id || '').trim();
          if (!_msid || !SESSION_ID_RE.test(_msid)) continue;
          // Write per-session JSONL
          const _mEvts = sess.events || [];
          const _mLines = _mEvts.map((e) => JSON.stringify(e)).join('\n');
          fs.writeFileSync(
            path.join(_migSessDir, `${_msid}.jsonl`),
            _mLines + (_mLines ? '\n' : ''),
          );
          _migIndex.push({
            id: _msid,
            ts: sess.ts,
            prompt: sess.prompt || '',
            status: sess.status || 'complete',
            org: sess.org || '',
            startedAt: sess.ts || sess.startedAt,
            endedAt: sess.endTs || sess.endedAt,
            domains: sess.domains || [],
          });
        }
        fs.writeFileSync(_migIndexFile, JSON.stringify(_migIndex));
        console.log(`[server] migrated ${_migIndex.length} sessions to per-session JSONL format`);
      } catch (_me) {
        console.warn('[server] session migration failed:', _me.message);
      }
    }
  } catch (_) {}

  // ---------------------------------------------------------------- Watchers
  let debounceTimer = null;
  const pendingSections = new Set();

  function scheduleRefresh(_event, filename) {
    const sections = pathToSections(filename);
    if (sections) sections.forEach((s) => pendingSections.add(s));
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const changed =
        pendingSections.size > 0
          ? Array.from(pendingSections)
          : ['sessions', 'swarm', 'agents', 'tokens', 'hooks', 'memory', 'knowledge', 'metrics'];
      pendingSections.clear();
      broadcast({ kind: 'changed', sections: changed });
    }, 500);
  }

  // Watch .monomind directory
  const monomindDir = path.join(projectDir || process.cwd(), '.monomind');
  if (fs.existsSync(monomindDir)) {
    try {
      const w = watchSafely(watchTree(monomindDir, scheduleRefresh), '.monomind');
      activeWatchers.push(w);
    } catch {
      // Directory may not support recursive watch on all platforms — ignore
    }
  }

  // Watch .claude/sessions/ if present
  const claudeSessionsDir = path.join(projectDir || process.cwd(), '.claude', 'sessions');
  if (fs.existsSync(claudeSessionsDir)) {
    try {
      const w = watchSafely(watchTree(claudeSessionsDir, scheduleRefresh), '.claude/sessions');
      activeWatchers.push(w);
    } catch {
      // Ignore unsupported watch
    }
  }

  // ── Phase 2: Spool polling — replay undelivered events from capture-handler (Issue 5) ──
  // capture-handler writes events to spool/ before HTTP POST. If the POST fails (server
  // down, timeout), the file stays. We poll every 5s and replay them.
  const _spoolBaseDir = path.join(MONOMIND_HOME, '.monomind', 'capture', 'spool');
  const _spoolTimer = setInterval(() => {
    if (!fs.existsSync(_spoolBaseDir)) return;
    try {
      const _spoolFiles = fs
        .readdirSync(_spoolBaseDir)
        .filter((f) => f.endsWith('.json') && !f.startsWith('.'))
        .sort() // chronological (timestamp prefix)
        .slice(0, 20); // max 20 per cycle to avoid flooding
      for (const _sf of _spoolFiles) {
        const _sfPath = path.join(_spoolBaseDir, _sf);
        try {
          const _spoolEvent = JSON.parse(fs.readFileSync(_sfPath, 'utf8'));
          const _spoolBody = JSON.stringify(_spoolEvent);
          const _spoolReq = http.request(
            {
              hostname: 'localhost',
              port: boundPort,
              path: '/api/mastermind/event',
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(_spoolBody),
              },
            },
            (_spoolRes) => {
              // Delete only after confirmed delivery; leave file on failure for next poll cycle
              if (_spoolRes.statusCode >= 200 && _spoolRes.statusCode < 300) {
                try {
                  fs.unlinkSync(_sfPath);
                } catch (_) {}
              }
              _spoolRes.resume();
            },
          );
          _spoolReq.on('error', () => {});
          _spoolReq.setTimeout(2000, () => {
            _spoolReq.destroy();
          });
          _spoolReq.write(_spoolBody);
          _spoolReq.end();
        } catch (_e) {}
      }
    } catch (_) {}
  }, 5000);
  // Clean up spool files older than 8 hours on startup (stale captures from crashed sessions)
  try {
    if (fs.existsSync(_spoolBaseDir)) {
      const _staleMs = 8 * 60 * 60 * 1000;
      fs.readdirSync(_spoolBaseDir)
        .filter((f) => f.endsWith('.json'))
        .forEach((_staleF) => {
          const _staleP = path.join(_spoolBaseDir, _staleF);
          try {
            if (Date.now() - fs.statSync(_staleP).mtimeMs > _staleMs) fs.unlinkSync(_staleP);
          } catch (_) {}
        });
    }
  } catch (_) {}

  // ── Phase 3: Read-batch polling — aggregate file-read events from capture-handler (Issue 9) ──
  // capture-handler writes Read tool calls to capture/read-batch-{ppid}-{pid}.json (per-subagent, no sharing).
  // Server polls every 3s, aggregates all matching files per session, emits agent:read:batch, removes files.
  const _rbDir = path.join(MONOMIND_HOME, '.monomind', 'capture');
  const _rbTimer = setInterval(() => {
    if (!fs.existsSync(_rbDir)) return;
    try {
      fs.readdirSync(_rbDir)
        .filter((f) => f.startsWith('read-batch-') && f.endsWith('.json'))
        .forEach((_rbf) => {
          const _rbPath = path.join(_rbDir, _rbf);
          try {
            const _rbData = JSON.parse(fs.readFileSync(_rbPath, 'utf8'));
            fs.unlinkSync(_rbPath);
            if (!Array.isArray(_rbData) || _rbData.length === 0) return;
            const _rbOrg = String(_rbData[0].org || '').trim();
            const _rbRunId = String(_rbData[0].runId || '').trim();
            const _rbEvent = {
              type: 'agent:read:batch',
              org: _rbOrg,
              runId: _rbRunId,
              paths: _rbData.map((e) => String(e.path || '').slice(0, 256)),
              count: _rbData.length,
              ts: Date.now(),
            };
            const _rbBody = JSON.stringify(_rbEvent);
            const _rbReq = http.request(
              {
                hostname: 'localhost',
                port: boundPort,
                path: '/api/mastermind/event',
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Content-Length': Buffer.byteLength(_rbBody),
                },
              },
              (res) => res.resume(),
            );
            _rbReq.on('error', () => {});
            _rbReq.setTimeout(2000, () => {
              _rbReq.destroy();
            });
            _rbReq.write(_rbBody);
            _rbReq.end();
          } catch (_e) {}
        });
    } catch (_) {}
  }, 3000);

  // ── Phase 4: Daemon heartbeat — ps -p {ppid} liveness check (Issue 8) ──
  // Periodically checks if the Claude Code session (tracked via ppid-keyed files) is still alive.
  // If the parent process is gone, auto-emits org:stop to close stale LIVE orgs in the dashboard.
  const _ppidCheckDir = path.join(MONOMIND_HOME, '.monomind', 'capture', 'active-runs');
  const _heartbeatTimer = setInterval(() => {
    if (!fs.existsSync(_ppidCheckDir)) return;
    try {
      fs.readdirSync(_ppidCheckDir)
        .filter((f) => f.endsWith('.json'))
        .forEach((_ppf) => {
          const _ppPath = path.join(_ppidCheckDir, _ppf);
          try {
            const _ppData = JSON.parse(fs.readFileSync(_ppPath, 'utf8'));
            const _ppid = parseInt(_ppf.replace('.json', ''), 10);
            if (!_ppid || Number.isNaN(_ppid)) return;
            // Check if the ppid process is still alive (signal 0 = probe, no kill)
            try {
              process.kill(_ppid, 0);
              // Process alive — no action
            } catch (_psErr) {
              // Process gone — emit org:stop and remove the ppid file
              fs.unlinkSync(_ppPath);
              const _staleOrg = String(_ppData.org || '').trim();
              const _staleRun = String(_ppData.runId || '').trim();
              if (_staleOrg && activeOrgRuns.has(_staleOrg)) {
                const _stopBody = JSON.stringify({
                  type: 'org:stop',
                  org: _staleOrg,
                  runId: _staleRun,
                  reason: 'ppid-dead',
                  ts: Date.now(),
                });
                const _stopReq = http.request(
                  {
                    hostname: 'localhost',
                    port: boundPort,
                    path: '/api/mastermind/event',
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                      'Content-Length': Buffer.byteLength(_stopBody),
                    },
                  },
                  (res) => res.resume(),
                );
                _stopReq.on('error', () => {});
                _stopReq.setTimeout(2000, () => {
                  _stopReq.destroy();
                });
                _stopReq.write(_stopBody);
                _stopReq.end();
              }
            }
          } catch (_) {}
        });
    } catch (_) {}
  }, 60000); // every 60s — intentionally infrequent, just a safety net

  function stopBackgroundTasks() {
    clearTimeout(debounceTimer);
    clearInterval(_spoolTimer);
    clearInterval(_rbTimer);
    clearInterval(_heartbeatTimer);
  }

  return { stopBackgroundTasks };
}

export {
  _readNewOrgLines,
  reportBoundPort,
  seedOrgsFileSizes,
  setupServerLifecycle,
  startOrgsFsWatchFallback,
  watchOrgsParentDir,
};
