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
 */
function bindServer(server, port) {
  return new Promise((resolve, reject) => {
    const maxTries = 10;
    let attempt = 0;

    function tryPort(p) {
      // A failed attempt's 'listening' callback is never invoked (listen()
      // failure emits 'error', not 'listening'), so it stays armed on the
      // server. Without removeAllListeners('listening') here, the NEXT
      // attempt's successful bind fires every still-armed 'listening'
      // listener in registration order — the failed attempt's callback runs
      // first and resolves with the busy port it never got, not the port
      // actually bound. Resolving from server.address().port (rather than
      // the closed-over `p`) is the same fix for the port:0 (OS-assigned)
      // case, where `p` is 0 but the real port is whatever the OS picked.
      server.removeAllListeners('listening');
      server.removeAllListeners('error');
      server.once('listening', () => resolve(server.address().port));
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && attempt < maxTries) {
          attempt += 1;
          tryPort(p + 1);
        } else {
          reject(err);
        }
      });
      server.listen(p, '127.0.0.1');
    }

    tryPort(port);
  });
}

export { activeWatchers, bindServer };
