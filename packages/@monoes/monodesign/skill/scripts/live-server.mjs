#!/usr/bin/env node
/**
 * Live variant mode server (self-contained, zero dependencies).
 *
 * Serves the browser script (/live.js), the detection overlay (/detect.js),
 * uses Server-Sent Events (SSE) for server→browser push, and HTTP POST for
 * browser→server events. Agent communicates via HTTP long-poll (/poll).
 *
 * Usage:
 *   node <scripts_path>/live-server.mjs              # start
 *   node <scripts_path>/live-server.mjs stop         # stop + remove injected live.js tag
 *   node <scripts_path>/live-server.mjs stop --keep-inject   # stop only
 *   node <scripts_path>/live-server.mjs --help
 */

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLiveSessionStore } from './live/session-store.mjs';
import {
  getLiveAnnotationsDir,
  readLiveServerInfo,
  removeLiveServerInfo,
  writeLiveServerInfo,
} from './lib/monodesign-paths.mjs';
import {
  applyDeferredSvelteComponentAccepts,
  removeAllSvelteComponentSessions,
} from './live/svelte-component.mjs';
import {
  state,
  manualApply,
  findOpenPort,
  restorePendingEventsFromStore,
} from './live-server-state.mjs';
import { loadBrowserScripts, createRequestHandler } from './live-server-routes.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let httpServer = null;

function shutdown() {
  cleanupSvelteComponentSessionsBeforeExit();
  removeLiveServerInfo(process.cwd());
  if (state.leaseTimer) clearTimeout(state.leaseTimer);
  state.leaseTimer = null;
  if (state.sessionDir) {
    try { fs.rmSync(state.sessionDir, { recursive: true, force: true }); } catch {}
  }
  for (const res of state.sseClients) { try { res.end(); } catch {} }
  state.sseClients.clear();
  for (const poll of state.pendingPolls) poll.resolve({ type: 'exit' });
  state.pendingPolls.length = 0;
  if (httpServer) httpServer.close();
  process.exit(0);
}

function cleanupSvelteComponentSessionsBeforeExit() {
  try {
    removeAllSvelteComponentSessions(process.cwd());
  } catch (err) {
    console.warn('[monodesign] Svelte component session cleanup failed:', err.message);
  }
}

function applyLegacyDeferredAcceptsOnStartup() {
  try {
    const result = applyDeferredSvelteComponentAccepts(process.cwd());
    if (result.applied > 0 || result.failed > 0) {
      console.log('[monodesign] applied legacy deferred Svelte component accepts:', JSON.stringify(result));
    }
  } catch (err) {
    console.warn('[monodesign] legacy deferred Svelte component accept apply failed:', err.message);
  }
}

// Exported so live-server-routes.mjs's request handler can call them (the
// '/stop' route and the 'exit' event branch).
export { shutdown, cleanupSvelteComponentSessionsBeforeExit };
// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`Usage: node live-server.mjs [options]

Start the live variant mode server (zero dependencies).

Commands:
  (default)     Start the server (foreground)
  stop          Stop the server and remove the injected live.js script tag
  stop --keep-inject   Stop the server only (leave the script tag in the HTML entry)

Options:
  --background  Start detached, print connection JSON to stdout, then exit
  --port=PORT   Use a specific port (default: auto-detect starting at 8400)
  --keep-inject Only with stop: skip live-inject.mjs --remove
  --help        Show this help

Endpoints:
  /live.js             Browser script (element picker + variant cycling)
  /detect.js           Detection overlay (backwards compatible)
  /modern-screenshot.js Vendored modern-screenshot UMD build (lazy-loaded by live.js)
  /annotation          POST raw image/png to stage a variant screenshot
  /events              SSE stream (server→browser) + POST (browser→server)
  /poll                Long-poll for agent CLI
  /manual-edit-stash   Stage browser copy edits
  /manual-edit-commit  Apply staged browser copy edits
  /manual-edit-discard Discard staged browser copy edits
  /source              Raw source file reader (no-HMR fallback)
  /status              Durable recovery status (token-protected)
  /health              Health check`);
  process.exit(0);
}

if (args.includes('stop')) {
  const keepInject = args.includes('--keep-inject');
  try {
    const { info } = readLiveServerInfo(process.cwd()) || {};
    const res = await fetch(`http://localhost:${info.port}/stop?token=${info.token}`);
    if (res.ok) console.log(`Stopped live server on port ${info.port}.`);
  } catch {
    console.log('No running live server found.');
  }
  if (!keepInject) {
    const injectPath = path.join(__dirname, 'live-inject.mjs');
    try {
      const out = execFileSync(process.execPath, [injectPath, '--remove'], {
        encoding: 'utf-8',
        cwd: process.cwd(),
      });
      const line = out.trim().split('\n').filter(Boolean).pop();
      if (line) {
        try {
          const j = JSON.parse(line);
          if (j.removed === true) {
            console.log(`Removed live script tag from ${j.file}.`);
          }
        } catch {
          /* ignore non-JSON lines */
        }
      }
    } catch (err) {
      const detail = err.stderr?.toString?.().trim?.()
        || err.stdout?.toString?.().trim?.()
        || err.message
        || String(err);
      console.warn(`Note: could not remove live script tag (${detail.split('\n')[0]})`);
    }
  }
  process.exit(0);
}

// --background: spawn a detached child server, wait for it to be ready,
// print the connection JSON, then exit.  This keeps the startup command
// simple (no shell backgrounding or chained commands).
if (args.includes('--background')) {
  const childArgs = args.filter(a => a !== '--background');
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...childArgs], {
    detached: true,
    stdio: 'ignore',
    cwd: process.cwd(),
  });
  child.unref();

  // Poll for the PID file (the child writes it once the HTTP server is listening).
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const { info } = readLiveServerInfo(process.cwd()) || {};
      if (info.pid !== process.pid) {
        // Output JSON so the agent can read port + token from stdout.
        console.log(JSON.stringify(info));
        process.exit(0);
      }
    } catch { /* not ready yet */ }
    await new Promise(r => setTimeout(r, 200));
  }
  console.error('Timed out waiting for live server to start.');
  process.exit(1);
}

// Check for existing session
const existingRecord = readLiveServerInfo(process.cwd());
if (existingRecord?.info) {
  const existing = existingRecord.info;
  try {
    process.kill(existing.pid, 0);
    console.error(`Live server already running on port ${existing.port} (pid ${existing.pid}).`);
    console.error(`Stop it first with: node ${path.basename(fileURLToPath(import.meta.url))} stop`);
    process.exit(1);
  } catch {
    try { fs.unlinkSync(existingRecord.path); } catch {}
  }
}

state.token = randomUUID();
state.sessionStore = createLiveSessionStore({ cwd: process.cwd() });
manualApply.rollbackTransaction({
  reason: 'manual_edit_server_start_recovered_abandoned_transaction',
});
applyLegacyDeferredAcceptsOnStartup();
restorePendingEventsFromStore();
manualApply.pruneStaleEvidence();
const portArg = args.find(a => a.startsWith('--port='));
const explicitPort = portArg ? parseInt(portArg.split('=')[1], 10) : null;
state.port = explicitPort ?? await findOpenPort();
// Annotation screenshots live in the project root so the agent's Read tool
// doesn't trip a per-file permission prompt. Sessioned by token so concurrent
// projects (or quick restarts) don't collide.
const annotRoot = getLiveAnnotationsDir(process.cwd());
fs.mkdirSync(annotRoot, { recursive: true });
state.sessionDir = fs.mkdtempSync(path.join(annotRoot, 'session-'));

const { detectScript, liveScriptParts } = loadBrowserScripts();
httpServer = http.createServer(createRequestHandler({ detectScript, liveScriptParts }));

// findOpenPort() probes a port, closes the probe socket, and only then does the
// real server bind it. Another process scanning the same range can take the
// port inside that gap, which surfaced as an intermittent
// "EADDRINUSE 127.0.0.1:8405" — about one run in five of the test suite, where
// several server-starting test files run in parallel.
//
// Retry on the next port when we picked it ourselves. An explicit --port is
// never silently moved: the caller asked for that port, so a conflict there
// must be an error they can see.
const MAX_PORT_RETRIES = 25;
let portRetries = 0;

httpServer.on('error', (err) => {
  if (err?.code !== 'EADDRINUSE') throw err;

  if (explicitPort !== null) {
    console.error(`\nPort ${state.port} is already in use.`);
    console.error('Another live server may be running — stop it, or pass a different --port.');
    process.exit(1);
  }

  if (portRetries >= MAX_PORT_RETRIES) {
    console.error(`\nCould not find a free port after ${MAX_PORT_RETRIES} attempts (last tried ${state.port}).`);
    process.exit(1);
  }

  portRetries++;
  state.port++;
  httpServer.listen(state.port, '127.0.0.1');
});

httpServer.listen(state.port, '127.0.0.1', () => {
  // Trust the address the OS actually bound over the one we asked for — after
  // a retry above, state.port and the bound port must not drift apart.
  const boundAddr = httpServer.address();
  if (boundAddr && typeof boundAddr === 'object') state.port = boundAddr.port;

  writeLiveServerInfo(process.cwd(), { pid: process.pid, port: state.port, token: state.token });
  const url = `http://localhost:${state.port}`;
  console.log(`\nMonodesign live server running on ${url}`);
  console.log(`Token: ${state.token}\n`);
  console.log(`Script: ${url}/live.js`);
  console.log('Inject: managed by live-inject.mjs; Astro source tags use is:inline automatically.');
  console.log(`Stop:   node ${path.basename(fileURLToPath(import.meta.url))} stop`);
});

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
