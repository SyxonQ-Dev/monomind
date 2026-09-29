import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

// ── Security: DNS-rebinding defence ───────────────────────────────────────────
// The dashboard binds 127.0.0.1 and embeds a live auth token in the HTML served
// by GET / (an open route — the page needs the token before it can attach it to
// any fetch). Loopback binding is NOT a boundary against a browser: a page on
// attacker.example can point its own DNS at 127.0.0.1, and the browser will
// happily connect and treat the response as same-origin with attacker.example,
// letting the attacker's script read the token straight out of the <meta> tag
// and then drive every authenticated /api/* route.
//
// The distinguishing signal is the Host header: the browser sends the name from
// the URL bar, so a rebound request carries `Host: attacker.example` while the
// real dashboard carries a loopback name. Rejecting non-loopback Host values
// closes the hole without affecting any legitimate client. (CORS does not help
// here — the rebound page IS same-origin as far as the browser is concerned.)
const _LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * Extract the hostname from a Host header, dropping the port.
 * Returns '' for a missing/blank header. IPv6 literals keep their brackets
 * (`[::1]:4242` → `[::1]`), which is how they appear in a Host header.
 */
export function parseHostHeader(hostHeader) {
  const h = String(hostHeader ?? '')
    .trim()
    .toLowerCase();
  if (!h) return '';
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    return end === -1 ? h : h.slice(0, end + 1);
  }
  const colon = h.lastIndexOf(':');
  return colon === -1 ? h : h.slice(0, colon);
}

/**
 * True when a request's Host header names this machine's loopback interface or
 * an explicitly configured extra host.
 *
 * A request with NO Host header is allowed: HTTP/1.0 and raw local scripts omit
 * it, and it is not an attack vector — browsers ALWAYS send Host, so a rebinding
 * page cannot suppress it.
 *
 * `extraHosts` comes from startServer({ allowedHosts }) or the
 * MONOMIND_DASHBOARD_ALLOWED_HOSTS env var (comma-separated), for the case where
 * someone deliberately fronts the dashboard with another name.
 */
export function isAllowedHost(hostHeader, extraHosts = []) {
  const name = parseHostHeader(hostHeader);
  if (!name) return true; // absent Host — non-browser client, see above
  if (_LOOPBACK_HOSTNAMES.has(name)) return true;
  // 127.0.0.0/8 is entirely loopback, not just 127.0.0.1.
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name)) return true;
  for (const extra of extraHosts) {
    if (parseHostHeader(extra) === name) return true;
  }
  return false;
}

/** Parse the configured extra-host allow-list from an option + env var. */
export function resolveAllowedHosts(optionValue) {
  const raw = []
    .concat(Array.isArray(optionValue) ? optionValue : optionValue ? [optionValue] : [])
    .concat(String(process.env.MONOMIND_DASHBOARD_ALLOWED_HOSTS || '').split(','));
  return raw.map((s) => String(s).trim().toLowerCase()).filter(Boolean);
}

// Server state

const activeWatchers = [];

// fs.watch (and chokidar) emit 'error' asynchronously — e.g. ENOSPC when the
// system's inotify watch limit is exhausted — and Node's default behavior for
// an unhandled EventEmitter 'error' event is to throw, crashing the whole
// process. Every watcher here is best-effort (live refresh degrades, the
// dashboard still works, if a watch fails), so log and disable instead.
export function watchSafely(watcher, label) {
  watcher.on('error', (err) => {
    console.warn(
      `[monomind] ${label} watcher failed, disabling live updates for it: ${err.message}`,
    );
    try {
      watcher.close();
    } catch {
      // Already closed
    }
    const idx = activeWatchers.indexOf(watcher);
    if (idx !== -1) activeWatchers.splice(idx, 1);
  });
  return watcher;
}

// broadcast() is imported from sse-manager.mjs

/**
 * Opens a URL in the default browser, cross-platform.
 */
export async function openUrl(url) {
  const { exec } = await import('node:child_process');
  const cmd =
    process.platform === 'darwin'
      ? `open "${url}"`
      : process.platform === 'win32'
        ? `start "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd);
}

/**
 * Attempts to bind the HTTP server to a port, trying up to 10 increments
 * if the initial port is already in use.
 *
 * `onBusy(port)` (optional) is asked about each busy port before moving on.
 * When it resolves to a record, that port is already served by this project's
 * own dashboard: the bind stops with an EALREADYRUNNING error carrying the
 * record as `err.existing`, instead of starting a second server beside it (#477).
 */
function bindServer(server, port, { onBusy } = {}) {
  return new Promise((resolve, reject) => {
    const maxTries = 10;
    let attempt = 0;
    let onListening = null;
    let onError = null;

    function tryPort(p) {
      // A failed attempt's 'listening' callback is never invoked (listen()
      // failure emits 'error', not 'listening'), so it stays armed on the
      // server. Without removing it here, the NEXT attempt's successful bind
      // fires every still-armed 'listening' listener in registration order —
      // the failed attempt's callback runs first and resolves with the busy
      // port it never got, not the port actually bound. Resolving from
      // server.address().port (rather than the closed-over `p`) is the same
      // fix for the port:0 (OS-assigned) case, where `p` is 0 but the real
      // port is whatever the OS picked.
      // Only this function's own listeners are removed. removeAllListeners()
      // also stripped http.Server's internal 'listening' listener
      // (setupConnectionsTracking), so the server tracked no connections:
      // closeAllConnections() and closeIdleConnections() did nothing and
      // server.close() waited on every keep-alive and SSE socket forever (#477).
      if (onListening) server.removeListener('listening', onListening);
      if (onError) server.removeListener('error', onError);
      onListening = () => resolve(server.address().port);
      onError = async (err) => {
        if (err.code !== 'EADDRINUSE' || attempt >= maxTries) {
          reject(err);
          return;
        }
        const existing = onBusy ? await onBusy(p).catch(() => null) : null;
        if (existing) {
          const already = new Error(`dashboard already running at ${existing.url}`);
          already.code = 'EALREADYRUNNING';
          already.existing = existing;
          reject(already);
          return;
        }
        attempt += 1;
        tryPort(p + 1);
      };
      server.once('listening', onListening);
      server.once('error', onError);
      server.listen(p, '127.0.0.1');
    }

    tryPort(port);
  });
}

// ── Duplicate-start detection (#477) ─────────────────────────────────────────
// A second `server.mjs 4242` for a project whose dashboard was already up used
// to start anyway: on port+1, or, once its own shutdown hung, as a portless
// process nobody could reach. /api/identity (an open route) names the pid and
// project dir of whatever answers a port, so a start can tell this project's
// dashboard apart from another project's server on the same port.

/** GET /api/identity on a loopback port; null when nothing valid answers. */
async function fetchDashboardIdentity(port, timeoutMs = 1000) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/identity`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) {
      await r.body?.cancel();
      return null;
    }
    const id = await r.json();
    return id && typeof id.pid === 'number' && typeof id.dir === 'string' ? id : null;
  } catch (_) {
    return null;
  }
}

/**
 * The dashboard of another process already serving `projectDir` on `port`.
 * @returns {Promise<{pid: number, port: number, url: string} | null>}
 */
async function dashboardServingProject(port, projectDir) {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  const id = await fetchDashboardIdentity(port);
  if (!id || id.pid === process.pid) return null;
  if (path.resolve(id.dir) !== path.resolve(projectDir)) return null;
  return { pid: id.pid, port, url: `http://localhost:${port}` };
}

/**
 * This project's live dashboard on the port control.json records or on the
 * requested port, or null.
 */
async function findRunningDashboard(projectDir, port) {
  const ports = [];
  try {
    const ctl = JSON.parse(
      fs.readFileSync(path.join(projectDir, '.monomind', 'control.json'), 'utf8'),
    );
    const ctlPort = Number(ctl.port || (String(ctl.url || '').match(/:(\d+)/) || [])[1]);
    if (ctlPort) ports.push(ctlPort);
  } catch (_) {
    /* no control.json — only the requested port is a candidate */
  }
  if (!ports.includes(port)) ports.push(port);
  for (const p of ports) {
    const found = await dashboardServingProject(p, projectDir);
    if (found) return found;
  }
  return null;
}

// ── Bounded directory-tree watching (#477) ───────────────────────────────────
// fs.watch({ recursive: true }) is native only on macOS and Windows. On Linux,
// Node emulates it in JavaScript: it walks the whole tree and keeps one inotify
// watch, one FSWatcher and one retained fs.Stats per FILE. A project whose
// .monomind held ~110k files cost the dashboard ~110k watches and hundreds of
// MB for its whole life, and the project-root document watcher walked every
// file outside the skip list too. watchTree keeps the native path where it
// exists and elsewhere watches DIRECTORIES only: a directory's watch already
// reports changes to the files directly inside it, so the cost follows the
// directory count (capped) instead of the file count.
const NATIVE_RECURSIVE_WATCH = process.platform === 'darwin' || process.platform === 'win32';
const MAX_TREE_WATCH_DIRS = 2000;

/**
 * Recursive-watch replacement. `onEvent(eventType, relPath)` mirrors the
 * fs.watch listener, with paths relative to `root`. `skip(relPath)` prunes a
 * path (and, for a directory, its whole subtree) from watching and events.
 * Throws, like fs.watch, when `root` itself cannot be watched. Returns an
 * EventEmitter with close().
 */
function watchTree(
  root,
  onEvent,
  { skip = () => false, persistent = true, maxDepth = 8, maxDirs = MAX_TREE_WATCH_DIRS } = {},
) {
  if (NATIVE_RECURSIVE_WATCH) {
    return fs.watch(root, { recursive: true, persistent }, (evt, rel) => {
      if (rel && skip(String(rel))) return;
      onEvent(evt, rel);
    });
  }
  const base = path.resolve(root);
  const tree = new EventEmitter();
  const dirs = new Map(); // absolute dir → FSWatcher
  let closed = false;
  const drop = (dir) => {
    for (const [d, w] of dirs) {
      if (d !== dir && !d.startsWith(dir + path.sep)) continue;
      try {
        w.close();
      } catch (_) {}
      dirs.delete(d);
    }
  };
  const add = (dir, depth) => {
    if (closed || dirs.has(dir) || dirs.size >= maxDirs || depth > maxDepth) return;
    let w;
    try {
      w = fs.watch(dir, { persistent }, (evt, name) => {
        if (closed || !name) return;
        const full = path.join(dir, String(name));
        const rel = path.relative(base, full);
        if (skip(rel)) return;
        if (evt === 'rename') {
          let isDir = false;
          try {
            isDir = fs.statSync(full).isDirectory();
          } catch (_) {}
          if (isDir) add(full, depth + 1);
          else if (dirs.has(full)) drop(full);
        }
        onEvent(evt, rel);
      });
    } catch (err) {
      if (depth === 0) throw err;
      return; // a subdirectory that vanished or is unreadable — skip it
    }
    w.on('error', () => drop(dir));
    dirs.set(dir, w);
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {}
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const child = path.join(dir, e.name);
      if (!skip(path.relative(base, child))) add(child, depth + 1);
    }
  };
  add(base, 0);
  tree.close = () => {
    closed = true;
    for (const w of dirs.values()) {
      try {
        w.close();
      } catch (_) {}
    }
    dirs.clear();
  };
  return tree;
}

export {
  activeWatchers,
  bindServer,
  dashboardServingProject,
  findRunningDashboard,
  MAX_TREE_WATCH_DIRS,
  watchTree,
};
