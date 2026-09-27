// Live server HTTP routing: loading the browser/detect scripts and the
// request handler that dispatches every route. Split out of live-server.mjs
// (file-size sweep — pure move, no behaviour change).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDesignMd } from './lib/design-parser.mjs';
import {
  assembleLiveBrowserScript,
  assertLiveBrowserScriptParts,
  readLiveBrowserScriptParts,
  resolveLiveBrowserScriptParts,
} from './live/browser-script-parts.mjs';
import { validateEvent } from './live/event-validation.mjs';
import { LIVE_COMMANDS } from './live/vocabulary.mjs';
import {
  getDesignSidecarPath,
  MONODESIGN_COMMAND_PREFIX,
  resolveDesignSidecarPath,
} from './lib/monodesign-paths.mjs';
import {
  state,
  PROJECT_CONTEXT,
  CONTEXT_DIR,
  DESIGN_MD_PATH,
  SSE_HEARTBEAT_INTERVAL,
  MAX_ANNOTATION_BYTES,
  activeSessionSummaries,
  summarizePendingEventForStatus,
  agentPollingConnected,
  getManualEditStatus,
  enqueueEvent,
  cancelQueuedAnonymousExitEvents,
  manualEditRoutes,
  hasProjectContext,
  statOrNull,
  requireAuthQueryCred,
} from './live-server-state.mjs';
import { handlePollGet, handlePollPost } from './live-server-poll.mjs';
import { shutdown, cleanupSvelteComponentSessionsBeforeExit } from './live-server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Load scripts
// ---------------------------------------------------------------------------

function loadBrowserScripts() {
  // Detection script: prefer the skill-bundled detector, then fall back to
  // source/npm package locations for local development and older installs.
  // This one IS cached — detect.js rarely changes during a session.
  const detectPaths = [
    path.join(__dirname, 'detector', 'detect-antipatterns-browser.js'),
    path.join(__dirname, '..', '..', 'cli', 'engine', 'detect-antipatterns-browser.js'),
    path.join(__dirname, '..', '..', '..', '..', 'cli', 'engine', 'detect-antipatterns-browser.js'),
    path.join(process.cwd(), 'node_modules', 'monodesign', 'cli', 'engine', 'detect-antipatterns-browser.js'),
  ];
  let detectScript = '';
  for (const p of detectPaths) {
    try { detectScript = fs.readFileSync(p, 'utf-8'); break; } catch { /* try next */ }
  }

  // Browser script parts: DO NOT cache. Return paths so the /live.js handler
  // can re-read every part on each request. Editing browser code during
  // iteration should land on the next tab reload, not require a server restart.
  const liveScriptParts = resolveLiveBrowserScriptParts(__dirname);
  try {
    assertLiveBrowserScriptParts(liveScriptParts);
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(1);
  }

  return { detectScript, liveScriptParts };
}

// HTTP request handler
// ---------------------------------------------------------------------------

function createRequestHandler({ detectScript, liveScriptParts }) {
  return (req, res) => {
    const url = new URL(req.url, `http://localhost:${state.port}`);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const p = url.pathname;

    // --- Scripts ---
    if (p === '/live.js') {
      // This response embeds the shared bearer credential (below) — unlike
      // /detect.js and the vendored scripts, it must be gated the same way
      // every OTHER protected route already is. Without this, requesting this
      // one route defeats every other route's check: whoever fetches it walks
      // away with the value that's supposed to distinguish the legitimate
      // preview tab from any other page. See requireAuthQueryCred() below —
      // callers must supply the credential the running server printed at
      // startup (also mirrored into the live-server info file for tooling).
      if (!requireAuthQueryCred(url, res)) return;
      // Re-read from disk each request so edits to live-browser.js land on
      // the next tab reload. No-store headers prevent browser caching across
      // sessions — during iteration, a cached old script silently breaks
      // every subsequent session.
      let parts;
      try {
        parts = readLiveBrowserScriptParts(liveScriptParts);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`Error reading live browser scripts: ${err.message}`);
        return;
      }
      const body = assembleLiveBrowserScript({
        token: state.token,
        port: state.port,
        vocabulary: LIVE_COMMANDS,
        commandPrefix: MONODESIGN_COMMAND_PREFIX,
        parts,
      });
      res.writeHead(200, {
        'Content-Type': 'application/javascript',
        'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
        'Pragma': 'no-cache',
      });
      res.end(body);
      return;
    }
    if (p === '/detect.js' || p === '/') {
      if (!detectScript) { res.writeHead(404); res.end('Not available'); return; }
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      res.end(detectScript);
      return;
    }

    // --- Vendored modern-screenshot (UMD build) ---
    // Lazy-loaded by live.js when the user clicks Go; exposes
    // window.modernScreenshot.domToBlob(...) for capture.
    if (p === '/modern-screenshot.js') {
      const vendorPath = path.join(__dirname, 'modern-screenshot.umd.js');
      try {
        res.writeHead(200, {
          'Content-Type': 'application/javascript',
          'Cache-Control': 'public, max-age=31536000, immutable',
        });
        res.end(fs.readFileSync(vendorPath));
      } catch {
        res.writeHead(404); res.end('Vendor script not found');
      }
      return;
    }

    // --- Annotation upload (browser → server, raw PNG body) ---
    // Client generates the eventId, POSTs the PNG, then POSTs the generate
    // event with screenshotPath already set. Keeps bytes out of the SSE/poll
    // bridge and preserves the "one shot from the user's POV" UX.
    if (p === '/annotation' && req.method === 'POST') {
      const token = url.searchParams.get('token');
      if (token !== state.token) { res.writeHead(401); res.end('Unauthorized'); return; }
      const eventId = url.searchParams.get('eventId');
      if (!eventId || !/^[A-Za-z0-9_-]{1,64}$/.test(eventId)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid eventId' }));
        return;
      }
      if ((req.headers['content-type'] || '').toLowerCase() !== 'image/png') {
        res.writeHead(415, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Content-Type must be image/png' }));
        return;
      }
      if (!state.sessionDir) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session dir unavailable' }));
        return;
      }
      const chunks = [];
      let total = 0;
      let aborted = false;
      req.on('data', (c) => {
        if (aborted) return;
        total += c.length;
        if (total > MAX_ANNOTATION_BYTES) {
          aborted = true;
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Payload too large' }));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        if (aborted) return;
        const absPath = path.join(state.sessionDir, `${eventId}.png`);
        try {
          fs.writeFileSync(absPath, Buffer.concat(chunks));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Write failed: ${err.message}` }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, path: absPath }));
      });
      req.on('error', () => {
        if (!aborted) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Upload failed' }));
        }
      });
      return;
    }

    // --- Health ---
    if (p === '/status') {
      const token = url.searchParams.get('token');
      if (token !== state.token) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
      const sessions = activeSessionSummaries();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        port: state.port,
        connectedClients: state.sseClients.size,
        pendingEvents: state.pendingEvents.map((entry) => summarizePendingEventForStatus(entry)),
        agentPolling: agentPollingConnected(),
        activeSessions: sessions,
        manualEdits: getManualEditStatus(),
      }));
      return;
    }

    if (p === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok', port: state.port, mode: 'variant',
        hasProjectContext: hasProjectContext(),
        connectedClients: state.sseClients.size,
      }));
      return;
    }

    // --- Design system (unified v2 response) + raw ---
    //   /design-system.json    returns both parsed DESIGN.md and .monodesign/design.json
    //                          sidecar when present. Panel merges them:
    //                            { present, parsed, sidecar, hasMd, hasSidecar,
    //                              mdNewerThanJson, parseError?, sidecarError? }
    //                          - parsed: output of parseDesignMd (frontmatter
    //                            + six canonical sections) when DESIGN.md exists.
    //                          - sidecar: .monodesign/design.json contents when present.
    //                            Expected shape: schemaVersion 2, carrying
    //                            extensions + components + narrative.
    //   /design-system/raw     returns DESIGN.md markdown verbatim
    if (p === '/design-system.json' || p === '/design-system/raw') {
      const token = url.searchParams.get('token');
      if (token !== state.token) { res.writeHead(401); res.end('Unauthorized'); return; }

      const mdPath = DESIGN_MD_PATH;
      const jsonPath = resolveDesignSidecarPath(process.cwd(), PROJECT_CONTEXT.designContextDir || CONTEXT_DIR) || getDesignSidecarPath(process.cwd());
      const mdStat = statOrNull(mdPath);
      const jsonStat = statOrNull(jsonPath);

      if (p === '/design-system/raw') {
        if (!mdStat) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
        res.end(fs.readFileSync(mdPath, 'utf-8'));
        return;
      }

      if (!mdStat && !jsonStat) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ present: false }));
        return;
      }

      const response = {
        present: true,
        hasMd: !!mdStat,
        hasSidecar: !!jsonStat,
        mdNewerThanJson: !!(mdStat && jsonStat && mdStat.mtimeMs > jsonStat.mtimeMs + 1000),
      };

      if (mdStat) {
        try {
          response.parsed = parseDesignMd(fs.readFileSync(mdPath, 'utf-8'));
        } catch (err) {
          response.parseError = err.message;
        }
      }

      if (jsonStat) {
        try {
          response.sidecar = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
        } catch (err) {
          response.sidecarError = `Failed to parse .monodesign/design.json: ${err.message}`;
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response));
      return;
    }

    // --- Source file (no-HMR fallback) ---
    if (p === '/source') {
      const token = url.searchParams.get('token');
      if (token !== state.token) { res.writeHead(401); res.end('Unauthorized'); return; }
      const filePath = url.searchParams.get('path');
      if (!filePath || filePath.includes('..')) { res.writeHead(400); res.end('Bad path'); return; }
      // Resolve symlinks on BOTH sides before comparing: a lexical prefix check
      // (path.resolve + startsWith) can't tell a symlink that lexically resolves
      // inside cwd from one that physically points outside it, and startsWith on
      // its own also has no path-boundary — "/proj-evil" lexically "starts with"
      // "/proj". realpath + path.relative closes both gaps (the same pattern
      // already used correctly elsewhere in this package).
      let root, absPath;
      try {
        root = fs.realpathSync(process.cwd());
        absPath = fs.realpathSync(path.resolve(process.cwd(), filePath));
      } catch { res.writeHead(404); res.end('File not found'); return; }
      const rel = path.relative(root, absPath);
      if (rel.startsWith('..') || path.isAbsolute(rel)) { res.writeHead(403); res.end('Forbidden'); return; }
      let content;
      try { content = fs.readFileSync(absPath, 'utf-8'); }
      catch { res.writeHead(404); res.end('File not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(content);
      return;
    }

    // --- SSE: server→browser push (replaces WebSocket) ---
    if (p === '/events' && req.method === 'GET') {
      const token = url.searchParams.get('token');
      if (token !== state.token) { res.writeHead(401); res.end('Unauthorized'); return; }
      clearTimeout(state.exitTimer);
      state.exitTimer = null;
      cancelQueuedAnonymousExitEvents();
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      res.write(`data: ${JSON.stringify({
        type: 'connected',
        hasProjectContext: hasProjectContext(),
        agentPolling: agentPollingConnected(),
        activeSessions: activeSessionSummaries(),
      })}\n\n`);

      state.sseClients.add(res);

      // Keepalive: SSE comment every 30s prevents silent connection drops.
      const heartbeat = setInterval(() => {
        try { res.write(': keepalive\n\n'); } catch { clearInterval(heartbeat); }
      }, SSE_HEARTBEAT_INTERVAL);

      req.on('close', () => {
        clearInterval(heartbeat);
        state.sseClients.delete(res);
        if (state.sseClients.size === 0) {
          clearTimeout(state.exitTimer);
          state.exitTimer = setTimeout(() => {
            if (state.sseClients.size === 0) enqueueEvent({ type: 'exit' });
          }, 8000);
        }
      });
      return;
    }

    if (manualEditRoutes(req, res, url)) return;

    // --- Browser→server events (replaces WebSocket messages) ---
    if (p === '/events' && req.method === 'POST') {
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
        // Defense in depth: manual copy edits must use the staged stash/apply
        // endpoints. The direct Save event path is disabled in the browser.
        if (msg.type === 'manual_edits') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'manual_edits must POST to /manual-edit-stash, not /events' }));
          return;
        }
        if (msg.type === 'manual_edit_apply') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'manual_edit_apply is disabled; use /manual-edit-stash then /manual-edit-commit' }));
          return;
        }
        const error = validateEvent(msg);
        if (error) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error }));
          return;
        }
        if (state.sessionStore && msg.id) {
          try {
            state.sessionStore.appendEvent(msg);
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'session_store_append_failed', message: err.message }));
            return;
          }
        }
        if (msg.type === 'exit') {
          cleanupSvelteComponentSessionsBeforeExit();
        }
        if (msg.type !== 'checkpoint') {
          enqueueEvent(msg);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }

    // --- Stop ---
    if (p === '/stop') {
      const token = url.searchParams.get('token');
      if (token !== state.token) { res.writeHead(401); res.end('Unauthorized'); return; }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('stopping');
      shutdown();
      return;
    }

    // --- Agent poll ---
    if (p === '/poll' && req.method === 'GET') {
      handlePollGet(req, res, url);
      return;
    }
    if (p === '/poll' && req.method === 'POST') {
      handlePollPost(req, res);
      return;
    }

    res.writeHead(404); res.end('Not found');
  };
}

export { loadBrowserScripts, createRequestHandler };
