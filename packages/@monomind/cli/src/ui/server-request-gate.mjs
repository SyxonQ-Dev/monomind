import { isAllowedHost } from './server-net.mjs';

// Per-request security preamble extracted from startServer()'s createServer callback
// (this file's line-count limit): loopback Host check, strict CORS allow-list, and the
// default-closed auth gate (+ Sec-Fetch-Site CSRF guard on mutations). Called first, for
// every request, before any route dispatch.
function checkRequestGate({
  req,
  res,
  _allowedHosts,
  currentPort,
  boundPort,
  port,
  _isOpenRoute,
  _checkAuth,
  _sendUnauthorized,
}) {
  const url = req.url.split('?')[0];

  // ── Security: DNS-rebinding defence (see isAllowedHost) ─────────────────
  // Must run before ANY route — including the open ones, since GET / is what
  // hands out the auth token. Fails closed with a bare 403 and no CORS header.
  if (!isAllowedHost(req.headers.host, _allowedHosts)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(
      'Forbidden: Host header is not a loopback address. ' +
        'Set MONOMIND_DASHBOARD_ALLOWED_HOSTS to permit another host name.\n',
    );
    return { blocked: true };
  }

  // ── Security: strict CORS allow-list ────────────────────────────────────
  // Only reflect Origin when it is this dashboard's own loopback origin.
  // Otherwise the header is omitted entirely, so cross-origin reads fail
  // closed rather than defaulting to '*'.
  const _reqOrigin = req.headers.origin || '';
  const _boundPortForCors = currentPort || boundPort || port;
  const _allowedOrigins = new Set([
    `http://localhost:${_boundPortForCors}`,
    `http://127.0.0.1:${_boundPortForCors}`,
  ]);
  const corsOrigin = _allowedOrigins.has(_reqOrigin) ? _reqOrigin : undefined;

  // ── Security: default-closed for /api/* — every API route requires the
  // auth token, GET or not. Only the page-bootstrap and static-asset
  // routes below stay open (they serve the HTML/JS that embeds the token
  // in the first place, before any fetch() call could attach it).
  // Gating individual GET routes by name (tried first) left real gaps
  // across two independent review passes — session-journal,
  // search-sessions, project-costs, org threads/budgets/runs, several SSE
  // streams, and more all returned session/cost/secret-adjacent data
  // unauthenticated. Default-deny is the only version of this fix that
  // doesn't silently miss a route.
  if (!_isOpenRoute(url, req.method)) {
    if (!_checkAuth(req)) {
      _sendUnauthorized(res, corsOrigin);
      return { blocked: true };
    }
    // ── Security: Sec-Fetch-Site CSRF guard on mutations (i-073) ──────────
    // The token check alone cannot stop CSRF if the token ever leaks (a
    // browser cache, a proxy log, `ps` on a shared host). Reject when the
    // header is PRESENT and not `same-origin` — deliberately NOT "reject
    // cross-site": `Sec-Fetch-Site: same-site` covers a *different port on
    // the same host*, i.e. a page served by another local server (another
    // monomind dashboard among them — o-04 shows there can be eleven).
    // Rejecting anything that isn't `same-origin` closes that case too, at
    // no cost to the dashboard's own pages.
    // Header ABSENT must stay allowed, or every first-party non-browser
    // caller breaks: control-start.cjs, event-logger.cjs,
    // capture-handler.cjs, route-handler.cjs, forwarder.ts and the
    // `/mastermind:*` commands all POST with the token header and send no
    // Sec-Fetch-* at all. A browser too old to send Sec-Fetch-Site is
    // treated the same as a non-browser client — it still needs the token.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const _secFetchSite = req.headers['sec-fetch-site'];
      if (_secFetchSite && _secFetchSite !== 'same-origin') {
        res.writeHead(403, {
          'Content-Type': 'application/json',
          ...(corsOrigin ? { 'Access-Control-Allow-Origin': corsOrigin } : {}),
        });
        res.end(JSON.stringify({ error: 'Forbidden: cross-origin mutation' }));
        return { blocked: true };
      }
    }
  }

  return { blocked: false, url, corsOrigin, _boundPortForCors };
}

export { checkRequestGate };
