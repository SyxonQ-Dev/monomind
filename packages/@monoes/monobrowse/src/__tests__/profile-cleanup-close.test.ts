/**
 * #395: closing (or killing) a browser monobrowse launched deletes the temp
 * profile dir monobrowse created for it — and never a caller-supplied one.
 *
 * No real Chrome: launchBrowser spawns a fake-chrome script that behaves
 * like Chrome where it matters here (creates and writes into its
 * --user-data-dir, serves /json/version, announces its browser id on stderr,
 * writes DevToolsActivePort for port 0). Browser.close goes over a fake `ws`
 * socket that kills the fixture, as a real Chrome exits on it. A client that
 * never connected drives the kill fallback (its Browser.close fails at once).
 *
 * TMPDIR is pointed at a root of each test's own, so both the launch-time
 * sweep and the default profile dir live there — never the real /tmp.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let onBrowserClose: (() => void) | null = null;
let lastSocket: FakeWs | null = null;

/** Acknowledges every command; `Browser.close` also runs onBrowserClose. */
class FakeWs {
  handlers = new Map<string, Array<(...a: unknown[]) => void>>();
  constructor(public url: string) {
    lastSocket = this;
  }
  on(event: string, fn: (...a: unknown[]) => void): void {
    if (!this.handlers.has(event)) this.handlers.set(event, []);
    this.handlers.get(event)!.push(fn);
  }
  emit(event: string, ...args: unknown[]): void {
    for (const fn of [...(this.handlers.get(event) ?? [])]) fn(...args);
  }
  send(data: string): void {
    const { id, method } = JSON.parse(data) as { id: number; method: string };
    if (method === 'Browser.close') onBrowserClose?.();
    queueMicrotask(() => this.emit('message', Buffer.from(JSON.stringify({ id, result: {} }))));
  }
  close(): void {}
}

vi.mock('ws', () => ({ WebSocket: FakeWs }));

// Exits once the test process is gone, and within a minute regardless, so a
// fixture never outlives the run.
const FAKE_CHROME = `#!/usr/bin/env node
const parent = process.ppid;
setInterval(() => {
  try { if (process.ppid !== parent) process.exit(0); process.kill(parent, 0); } catch { process.exit(0); }
}, 1000).unref();
setTimeout(() => process.exit(0), 60000).unref();
const { createServer } = require('node:http');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const arg = (k) => process.argv.find((a) => a.startsWith(k + '=')).slice(k.length + 1);
const dir = arg('--user-data-dir');
const wanted = Number(arg('--remote-debugging-port'));
mkdirSync(join(dir, 'Default'), { recursive: true });
writeFileSync(join(dir, 'Default', 'Preferences'), '{}');
const server = createServer((req, res) => {
  const port = server.address().port;
  const ws = 'ws://127.0.0.1:' + port + '/devtools/browser/fake-' + process.pid;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(req.url === '/json/version'
    ? JSON.stringify({ Browser: 'Chrome/999.0.0.0', webSocketDebuggerUrl: ws })
    : '[]');
});
server.listen(wanted, '127.0.0.1', () => {
  const port = server.address().port;
  if (wanted === 0) writeFileSync(join(dir, 'DevToolsActivePort'), port + '\\n/devtools/browser/fake');
  process.stderr.write('DevTools listening on ws://127.0.0.1:' + port + '/devtools/browser/fake-' + process.pid + '\\n');
});
`;

let root: string;
let fixtures: string;
let cwd: string;
let exe: string;
const children: ChildProcess[] = [];
const launchedPids: number[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'monobrowse-395-root-'));
  fixtures = await mkdtemp(join(tmpdir(), 'monobrowse-395-fixture-'));
  cwd = await mkdtemp(join(tmpdir(), 'monobrowse-395-cwd-'));
  vi.stubEnv('TMPDIR', root);
  vi.spyOn(process, 'cwd').mockReturnValue(cwd);
  exe = join(fixtures, 'fake-chrome.cjs');
  writeFileSync(exe, FAKE_CHROME);
  chmodSync(exe, 0o755);
  onBrowserClose = null;
  lastSocket = null;
  vi.resetModules();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const pid of launchedPids.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
  for (const child of children.splice(0)) child.kill('SIGKILL');
  for (const dir of [root, fixtures, cwd]) await rm(dir, { recursive: true, force: true });
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

/** A client whose Browser.close is acknowledged, and makes `pid` exit the
 *  way Chrome does on it. */
async function gracefulClient(pid: number) {
  const { CdpClient } = await import('../browser/cdp.js');
  const client = new CdpClient();
  const p = client.connect('ws://127.0.0.1:1/devtools/browser/fake');
  lastSocket!.emit('open');
  await p;
  onBrowserClose = () => process.kill(pid, 'SIGTERM');
  return client;
}

/** A client that never connected: Browser.close fails at once, so
 *  closeBrowser takes its kill fallback. */
async function deadClient() {
  const { CdpClient } = await import('../browser/cdp.js');
  return new CdpClient();
}

async function launch(config: Record<string, unknown>) {
  const browser = await import('../browser/browser.js');
  const port = await browser.launchBrowser({ executablePath: exe, ...config });
  const pid = browser.getLaunchedPid(port)!;
  launchedPids.push(pid);
  return { browser, port, pid, dir: browser.getLaunchedUserDataDir(port)! };
}

describe.skipIf(process.platform === 'win32')('#395 profile dir cleanup on close', () => {
  it('launch then graceful close removes the default profile dir it created', async () => {
    const { browser, port, pid, dir } = await launch({ port: await freePort() });
    expect(dir.startsWith(root)).toBe(true);
    expect(existsSync(join(dir, 'Default', 'Preferences'))).toBe(true);
    expect(browser.ownsLaunchedUserDataDir(port)).toBe(true);

    await browser.closeBrowser(await gracefulClient(pid), port);

    expect(existsSync(dir)).toBe(false);
  }, 20_000);

  it('removes a CLI session profile (port 0, ownsUserDataDir) on close', async () => {
    const browser = await import('../browser/browser.js');
    const { sessionProfileDirPath } = await import('../browser/profile-dir.js');
    const own = sessionProfileDirPath('abcdef12');
    expect(own.startsWith(root)).toBe(true);
    const { port, pid, dir } = await launch({ port: 0, userDataDir: own, ownsUserDataDir: true });
    expect(dir).toBe(own);

    await browser.closeBrowser(await gracefulClient(pid), port);

    expect(existsSync(own)).toBe(false);
  }, 20_000);

  it('never deletes a caller-supplied userDataDir, even one named like ours', async () => {
    const mine = join(root, 'my-profile');
    const lookalike = join(root, `monomind-browse-${process.pid}-0badc0de`);
    for (const userDataDir of [mine, lookalike]) {
      mkdirSync(userDataDir);
      const { browser, port, pid } = await launch({ port: 0, userDataDir });
      expect(browser.ownsLaunchedUserDataDir(port)).toBe(false);
      await browser.closeBrowser(await gracefulClient(pid), port);
      expect(existsSync(join(userDataDir, 'Default', 'Preferences')), userDataDir).toBe(true);
    }
  }, 30_000);

  it('the kill fallback removes the created dir once the process is gone', async () => {
    const { browser, port, pid, dir } = await launch({ port: await freePort() });
    expect(existsSync(dir)).toBe(true);

    await browser.closeBrowser(await deadClient(), port);

    expect(() => process.kill(pid, 0)).toThrow();
    expect(existsSync(dir)).toBe(false);
  }, 20_000);

  it('a failed launch removes the profile dir it created', async () => {
    const dying = join(fixtures, 'dying-chrome.cjs');
    writeFileSync(
      dying,
      `#!/usr/bin/env node
const dir = process.argv.find((a) => a.startsWith('--user-data-dir=')).slice(16);
require('node:fs').mkdirSync(dir, { recursive: true });
process.exit(1);
`,
    );
    chmodSync(dying, 0o755);
    const browser = await import('../browser/browser.js');
    const port = await freePort();
    await expect(
      browser.launchBrowser({ port, strictPort: true, executablePath: dying }),
    ).rejects.toThrow(/exited before the CDP endpoint opened/);

    expect(readdirSync(root)).toEqual([]);
  }, 20_000);
});

describe.skipIf(process.platform === 'win32')(
  '#395 fresh-process close via the persisted session',
  () => {
    /** A live stand-in for a Chrome some earlier CLI process launched, its
     *  profile dir, and the session record that process left behind. */
    async function persistedSession(ownsUserDataDir: boolean | undefined) {
      const dir = join(
        root,
        `monomind-browse-${process.pid}-5e55107${ownsUserDataDir ? 'a' : 'b'}`,
      );
      await mkdir(join(dir, 'Default'), { recursive: true });
      await writeFile(join(dir, 'Default', 'Preferences'), '{}');
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: 'ignore',
      });
      children.push(child);
      await new Promise((resolve) => child.once('spawn', resolve));
      const port = await freePort();
      const sessions = join(cwd, '.monomind', 'monobrowse', 'sessions');
      await mkdir(sessions, { recursive: true });
      await writeFile(
        join(sessions, `${port}.json`),
        JSON.stringify({
          port,
          launched: true,
          pid: child.pid,
          userDataDir: dir,
          ownsUserDataDir,
          savedAt: Date.now(),
        }),
      );
      return { dir, pid: child.pid!, port };
    }

    it('removes the dir when the record says monobrowse owns it', async () => {
      const { dir, port } = await persistedSession(true);
      const browser = await import('../browser/browser.js');
      const { loadSessionRecord } = await import('../browser/ref-cache.js');
      expect((await loadSessionRecord(port))?.ownsUserDataDir).toBe(true);

      await browser.closeBrowser(await deadClient(), port);

      expect(existsSync(dir)).toBe(false);
    }, 20_000);

    it('keeps the dir (still killing the browser) when the record has no ownership flag', async () => {
      const { dir, pid, port } = await persistedSession(undefined);
      const browser = await import('../browser/browser.js');

      await browser.closeBrowser(await deadClient(), port);

      for (let i = 0; i < 40; i++) {
        try {
          process.kill(pid, 0);
        } catch {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(() => process.kill(pid, 0)).toThrow();
      expect(existsSync(join(dir, 'Default', 'Preferences'))).toBe(true);
    }, 20_000);
  },
);
