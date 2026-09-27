/**
 * Unit tests for launchBrowser's port-scan/attach decisions (browser.ts).
 * Deliberately scoped to branches reachable WITHOUT spawning a real Chrome —
 * each scenario below resolves via attach or a thrown error before
 * launchBrowser would ever exec a browser binary, so these run fast and
 * don't depend on Chrome being installed in CI.
 *
 * Fixed port range (23460-23489) chosen to avoid colliding with real
 * services and with reap-idle-browser.test.ts's 23490-23499, which runs in a
 * parallel worker; each test binds/tears down its own listeners.
 */

import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer as createTcpServer, type Socket, type Server as TcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { getLaunchedPid, getLaunchedUserDataDir, launchBrowser } from '../browser/browser.js';

const BASE = 23470;

let servers: Array<TcpServer | HttpServer> = [];
let sockets: Socket[] = [];

afterEach(async () => {
  // server.close() only stops accepting NEW connections — it waits for
  // already-open ones (the fetches that hung until their AbortSignal fired)
  // to close on their own, which can outlast the test. Destroy explicitly.
  for (const sock of sockets) sock.destroy();
  sockets = [];
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  servers = [];
}, 5000);

// Every fake-chrome.cjs below is spawned by launchBrowser (detached, so a
// test cannot reach it through a ChildProcess). Its temp dir is on its
// command line, so each dir is recorded here and afterAll kills whatever is
// still running out of one — a fixture must never outlive this file (one
// that did kept 127.0.0.1:23480 bound and failed later runs with
// EADDRINUSE).
const fixtureDirs: string[] = [];

function fixtureDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  fixtureDirs.push(dir);
  return dir;
}

/** Pids of processes whose command line mentions `dir`. */
function processesIn(dir: string): string[] {
  try {
    return execFileSync('pgrep', ['-f', dir], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter(Boolean);
  } catch {
    return []; // pgrep exits 1 when nothing matches
  }
}

afterAll(async () => {
  const leaked: string[] = [];
  for (const dir of fixtureDirs.splice(0)) {
    // A fixture a test just SIGKILLed can take a moment to disappear.
    let pids = processesIn(dir);
    for (let i = 0; i < 20 && pids.length > 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      pids = processesIn(dir);
    }
    leaked.push(...pids);
    for (const pid of pids) {
      try {
        process.kill(Number(pid), 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
    rmSync(dir, { recursive: true, force: true });
  }
  // Swept above either way; failing here names a test whose own cleanup
  // missed a fixture.
  expect(leaked, 'fake-chrome fixtures outlived their test').toEqual([]);
});

// Prepended to every fake-chrome script: exit once the process that launched
// it is gone (launchBrowser spawns detached, so a vitest worker that dies or
// is killed mid-test would otherwise leave the fixture — and its port —
// behind, reparented to init), and never live longer than a minute anyway.
const FIXTURE_WATCHDOG = `const parent = process.ppid;
setInterval(() => {
  try {
    if (process.ppid !== parent) process.exit(0);
    process.kill(parent, 0);
  } catch {
    process.exit(0);
  }
}, 1000).unref();
setTimeout(() => process.exit(0), 60000).unref();
`;

/** Bind a bare TCP listener — accepts connections but speaks no HTTP/CDP. */
function occupyNonChrome(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = createTcpServer((sock) => {
      sockets.push(sock); /* accept and do nothing — no CDP response */
    });
    s.once('error', reject);
    s.listen(port, '127.0.0.1', () => {
      servers.push(s);
      resolve();
    });
  });
}

/** Bind an HTTP server that answers /json/version like a real Chrome would. */
function occupyChrome(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = createHttpServer((req, res) => {
      if (req.url === '/json/version') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ Browser: 'Chrome/999.0.0.0' }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    s.on('connection', (sock) => sockets.push(sock));
    s.once('error', reject);
    s.listen(port, '127.0.0.1', () => {
      servers.push(s);
      resolve();
    });
  });
}

describe('launchBrowser — port scan/attach decisions', () => {
  it('attaches immediately when the EXACT requested port already identifies as Chrome', async () => {
    const port = BASE + 0;
    await occupyChrome(port);
    await expect(launchBrowser({ port })).resolves.toBe(port);
  });

  it('strictPort: throws immediately on an occupied non-Chrome requested port, never scans', async () => {
    const port = BASE + 1;
    await occupyNonChrome(port);
    await occupyChrome(port + 1); // would succeed if scanning happened — must not be reached
    await expect(launchBrowser({ port, strictPort: true })).rejects.toThrow(
      /does not identify as Chrome/,
    );
  });

  it('strictPort: attaches on an occupied Chrome requested port (identical to non-strict)', async () => {
    const port = BASE + 2;
    await occupyChrome(port);
    await expect(launchBrowser({ port, strictPort: true })).resolves.toBe(port);
  });

  it('all candidates occupied by non-Chrome processes: throws a clear range error', async () => {
    const port = BASE + 3;
    // Occupy the full 10-port scan window with non-Chrome listeners.
    for (let i = 0; i < 10; i++) await occupyNonChrome(port + i);
    await expect(launchBrowser({ port })).rejects.toThrow(
      new RegExp(`Ports ${port}-${port + 9} are all occupied`),
    );
  }, 15000); // generous margin — 10 candidates, each a fast isTcpPortOpen check

  it('a Chrome instance on a SCANNED (not the originally requested) port is skipped, not attached to', async () => {
    // Security-relevant case: the attach-if-Chrome shortcut must apply only
    // to the exact port the caller asked for. A Chrome instance sitting on a
    // later candidate the caller never named must not be silently attached
    // to — occupied candidates (Chrome or not) beyond the first are simply
    // skipped, so if every candidate is occupied the call still fails even
    // though one of them is an attachable Chrome.
    const port = BASE + 4;
    await occupyNonChrome(port); // requested port: occupied, not Chrome
    await occupyChrome(port + 1); // scanned candidate: IS Chrome — must be skipped, not attached
    for (let i = 2; i < 10; i++) await occupyNonChrome(port + i); // remaining candidates: occupied
    await expect(launchBrowser({ port })).rejects.toThrow(
      new RegExp(`Ports ${port}-${port + 9} are all occupied`),
    );
  }, 15000); // generous margin — 10 candidates, each a fast isTcpPortOpen check
});

// A stand-in for the Chrome binary: like real Chrome given
// --remote-debugging-port=0, it binds a kernel-assigned port and only then
// writes that port to <user-data-dir>/DevToolsActivePort.
const FAKE_CHROME = `#!/usr/bin/env node
${FIXTURE_WATCHDOG}const { createServer } = require('node:http');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const dir = process.argv.find((a) => a.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
const server = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(req.url === '/json/version' ? JSON.stringify({ Browser: 'Chrome/999.0.0.0' }) : '[]');
});
// Start slower than launchBrowser's first poll, so a stale file is read first.
setTimeout(() => server.listen(0, '127.0.0.1', () => {
  writeFileSync(join(dir, 'DevToolsActivePort'), server.address().port + '\\n/devtools/browser/fake');
}), 600);
`;

// Like FAKE_CHROME, but its first /json/version answer takes longer than
// launchBrowser's 1 s identity timeout, while /json/list answers at once.
const FAKE_CHROME_SLOW_IDENTITY = `#!/usr/bin/env node
${FIXTURE_WATCHDOG}const { createServer } = require('node:http');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const dir = process.argv.find((a) => a.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
let versionCalls = 0;
const server = createServer((req, res) => {
  const send = () => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(req.url === '/json/version' ? JSON.stringify({ Browser: 'Chrome/999.0.0.0' }) : '[]');
  };
  if (req.url === '/json/version' && versionCalls++ === 0) setTimeout(send, 1500);
  else send();
});
server.listen(0, '127.0.0.1', () => {
  writeFileSync(join(dir, 'DevToolsActivePort'), server.address().port + '\\n/devtools/browser/fake');
});
`;

describe.skipIf(process.platform === 'win32')(
  'launchBrowser — port 0 (Chrome picks the port)',
  () => {
    it('returns the port its own Chrome reported, never another CDP endpoint', async () => {
      const dir = fixtureDir('monobrowse-port0-');
      const exe = join(dir, 'fake-chrome.cjs');
      writeFileSync(exe, FAKE_CHROME);
      chmodSync(exe, 0o755);
      const profile = join(dir, 'profile');
      // A Chrome-looking endpoint that is NOT ours, named by a stale
      // DevToolsActivePort left in the profile dir by an earlier run.
      const foreign = BASE + 5;
      const s = createHttpServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(req.url === '/json/version' ? JSON.stringify({ Browser: 'Chrome/1.0' }) : '[]');
      });
      s.on('connection', (sock) => sockets.push(sock));
      await new Promise<void>((resolve) => s.listen(foreign, '127.0.0.1', () => resolve()));
      servers.push(s);
      mkdirSync(profile);
      writeFileSync(join(profile, 'DevToolsActivePort'), `${foreign}\n/devtools/browser/stale`);

      let port: number | undefined;
      try {
        port = await launchBrowser({ port: 0, userDataDir: profile, executablePath: exe });
        expect(port).not.toBe(foreign);
        expect(port).toBeGreaterThan(0);
        expect(getLaunchedPid(port)).toBeTypeOf('number');
      } finally {
        const pid = port === undefined ? undefined : getLaunchedPid(port);
        if (pid) process.kill(pid, 'SIGKILL');
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('does not reject its own Chrome when /json/version answers slowly (loaded machine)', async () => {
      // On a busy CI runner Chrome's DevTools server can take longer than the
      // identity check's timeout to answer /json/version right after it
      // starts listening, while /json/list (no timeout) got through. That
      // timeout used to be read as "not Chrome" and failed the launch with
      // "occupied by a CDP-speaking process that does not identify as
      // Chrome/Chromium" — for the very Chrome it had just started.
      const dir = fixtureDir('monobrowse-slowid-');
      const exe = join(dir, 'fake-chrome.cjs');
      writeFileSync(exe, FAKE_CHROME_SLOW_IDENTITY);
      chmodSync(exe, 0o755);
      const profile = join(dir, 'profile');
      mkdirSync(profile);

      let port: number | undefined;
      try {
        port = await launchBrowser({ port: 0, userDataDir: profile, executablePath: exe });
        expect(port).toBeGreaterThan(0);
        expect(getLaunchedPid(port)).toBeTypeOf('number');
      } finally {
        const pid = port === undefined ? undefined : getLaunchedPid(port);
        if (pid) process.kill(pid, 'SIGKILL');
      }
    }, 15000);

    it('still refuses a CDP endpoint that answers as a non-Chrome browser', async () => {
      const dir = fixtureDir('monobrowse-notchrome-');
      const exe = join(dir, 'fake-chrome.cjs');
      writeFileSync(exe, FAKE_CHROME.replace('Chrome/999.0.0.0', 'Firefox/1.0'));
      chmodSync(exe, 0o755);
      const profile = join(dir, 'profile');
      mkdirSync(profile);
      await expect(
        launchBrowser({ port: 0, userDataDir: profile, executablePath: exe }),
      ).rejects.toThrow(/does not identify as Chrome/);
      // Refused, so never tracked — launchBrowser must stop it itself.
      for (let i = 0; i < 20 && processesIn(dir).length > 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(processesIn(dir)).toEqual([]);
    }, 15000);

    it('refuses port 0 without a dedicated userDataDir', async () => {
      await expect(launchBrowser({ port: 0 })).rejects.toThrow(/requires a dedicated userDataDir/);
    });
  },
);

// A stand-in for the Chrome binary that, unlike FAKE_CHROME above, actually
// binds the FIXED port it is given via --remote-debugging-port (real Chrome,
// launched with no --port flag, always resolves to the same literal default
// port too — see cli/commands.ts's `port` option default). If the bind
// fails (another process already has it), it exits the way real Chrome does
// when a concurrent launch wins the same "free-looking" port: before its
// CDP endpoint ever opens. Like real Chrome on a fixed port, it writes no
// DevToolsActivePort; it announces its browser websocket on stderr, with an
// id unique to this process that /json/version reports too.
const FAKE_CHROME_FIXED_PORT = `#!/usr/bin/env node
${FIXTURE_WATCHDOG}const { createServer } = require('node:http');
const { randomUUID } = require('node:crypto');
const { writeFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');
const port = Number(
  process.argv.find((a) => a.startsWith('--remote-debugging-port=')).slice('--remote-debugging-port='.length),
);
const dir = process.argv.find((a) => a.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
const ws = 'ws://127.0.0.1:' + port + '/devtools/browser/' + randomUUID();
const server = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    req.url === '/json/version'
      ? JSON.stringify({ Browser: 'Chrome/999.0.0.0', webSocketDebuggerUrl: ws })
      : '[]',
  );
});
server.on('error', () => {
  process.exit(21);
});
server.listen(port, '127.0.0.1', () => {
  mkdirSync(dir, { recursive: true });
  process.stderr.write('\\nDevTools listening on ' + ws + '\\n');
});
`;

describe.skipIf(process.platform === 'win32')(
  'launchBrowser — concurrent launches with no explicit --port (TOCTOU race)',
  () => {
    it('two concurrent launches racing for the same default port both succeed, on different ports and profiles', async () => {
      const dir = fixtureDir('monobrowse-concurrent-');
      const exe = join(dir, 'fake-chrome.cjs');
      writeFileSync(exe, FAKE_CHROME_FIXED_PORT);
      chmodSync(exe, 0o755);
      // Both calls target the SAME literal port on purpose: that is exactly
      // what two real `monomind browse open` invocations with no --port flag
      // do, since the CLI's `port` option always defaults to the same value
      // whether or not the user passed it (cli/commands.ts:288).
      const port = BASE + 10;

      // allSettled, not all: when one launch rejects, the other's fixture is
      // still running and must be killed too — Promise.all dropped its port
      // and leaked it.
      let results: PromiseSettledResult<number>[] = [];
      let ports: number[] = [];
      try {
        results = await Promise.allSettled([
          launchBrowser({ port, executablePath: exe, launchTimeoutMs: 5000 }),
          launchBrowser({ port, executablePath: exe, launchTimeoutMs: 5000 }),
        ]);
        ports = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
      } finally {
        for (const p of ports) {
          const pid = getLaunchedPid(p);
          if (pid) {
            try {
              process.kill(pid, 'SIGKILL');
            } catch {
              /* already gone */
            }
          }
        }
      }

      for (const r of results) if (r.status === 'rejected') throw r.reason;
      expect(ports).toHaveLength(2);
      // The old probe-then-launch race let both calls observe the same
      // candidate as free and spawn Chrome on it — one bind wins, the
      // other's Chrome exits before its CDP endpoint opens and the whole
      // launchBrowser() call rejects. Both resolving at all is the
      // regression check; landing on different ports (rather than one
      // silently adopting the other's browser) proves the scan actually
      // moved on instead of colliding.
      expect(ports[0]).not.toBe(ports[1]);
      const dirs = ports.map((p) => getLaunchedUserDataDir(p));
      expect(dirs[0]).not.toBe(dirs[1]);
      expect(dirs[0]).toBeTruthy();
      expect(dirs[1]).toBeTruthy();
    }, 15000);

    it('a launch whose Chrome is still booting does not adopt a concurrent launch that took the port', async () => {
      // The loaded-machine shape of the race above, made deterministic: both
      // launches probe the port as free, the "fast" Chrome binds it first,
      // and the "slow" one is still starting when its poll finds a Chrome
      // answering there. That Chrome is not the slow launch's own, so it
      // must not be returned — nor may the slow launch record its own pid
      // (about to exit on the lost bind) under the fast launch's port.
      const dir = fixtureDir('monobrowse-adopt-');
      const fast = join(dir, 'fast-chrome.cjs');
      const slow = join(dir, 'slow-chrome.cjs');
      writeFileSync(fast, fixedPortChrome(500));
      writeFileSync(slow, fixedPortChrome(2500));
      chmodSync(fast, 0o755);
      chmodSync(slow, 0o755);
      // Below BASE: this file's fixed ports, clear of the kernel's
      // ephemeral range, where another test's listen(0) server can land on
      // the candidate the slow launch scans on to.
      const port = BASE - 10;

      let results: PromiseSettledResult<number>[] = [];
      try {
        results = await Promise.allSettled([
          launchBrowser({ port, executablePath: fast, launchTimeoutMs: 10_000 }),
          launchBrowser({ port, executablePath: slow, launchTimeoutMs: 10_000 }),
        ]);
      } finally {
        for (const r of results) {
          const pid = r.status === 'fulfilled' ? getLaunchedPid(r.value) : undefined;
          if (pid) {
            try {
              process.kill(pid, 'SIGKILL');
            } catch {
              /* already gone */
            }
          }
        }
      }

      const [fastResult, slowResult] = results;
      expect(fastResult).toEqual({ status: 'fulfilled', value: port });
      if (slowResult.status === 'rejected') throw slowResult.reason;
      expect(slowResult.value).not.toBe(port);
      // The pid tracked for the port is the Chrome that actually serves it.
      const fastDir = getLaunchedUserDataDir(port)!;
      expect(fastDir).toBeTruthy();
      expect(getLaunchedPid(port)).toBe(Number(readFileSync(join(fastDir, 'pid'), 'utf8')));
    }, 20_000);
  },
);

/** FAKE_CHROME_FIXED_PORT that waits `delayMs` before binding, and records
 *  its own pid in its profile dir. */
function fixedPortChrome(delayMs: number): string {
  return FAKE_CHROME_FIXED_PORT.replace(
    'mkdirSync(dir, { recursive: true });',
    `mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'pid'), String(process.pid));`,
  )
    .replace(
      "server.listen(port, '127.0.0.1', () => {",
      "setTimeout(() => server.listen(port, '127.0.0.1', () => {",
    )
    .replace(/\}\);\n$/, `}), ${delayMs});\n`);
}
