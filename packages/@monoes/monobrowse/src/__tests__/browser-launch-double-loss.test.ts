/**
 * #491: two launches that call listen() on the same free port at the same
 * instant can BOTH lose it on Linux (each socket is marked LISTEN before the
 * port conflict check, so each sees the other and gets EADDRINUSE). Both
 * Chromes exit before their CDP endpoint opens and the port is free again
 * afterwards, so the lost race looks exactly like a Chrome that cannot start.
 *
 * The double loss is a kernel timing window (about 1 in 600 races locally),
 * so these tests reproduce its outcome deterministically instead: a fake
 * Chrome that exits early without binding on its first start.
 *
 * Fixed ports 23440-23449, clear of browser-launch.test.ts (23460-23489) and
 * reap-idle-browser.test.ts (23490-23499), which run in parallel workers.
 */

import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getLaunchedPid, launchBrowser } from '../browser/browser.js';

const BASE = 23440;
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      execFileSync('pkill', ['-KILL', '-f', dir]);
    } catch {
      /* nothing left running */
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A fixed-port fake Chrome. It exits with code 21 before binding anything
 * on each of its first `lostStarts` starts (counted in a file next to it),
 * and on every start for `lostPort`, which is what a Chrome that lost the
 * double-EADDRINUSE race looks like. Otherwise it binds the port and
 * announces itself like real Chrome.
 */
function fakeChrome(lostStarts: number, lostPort = 0): string {
  const dir = mkdtempSync(join(tmpdir(), 'monobrowse-491-'));
  dirs.push(dir);
  const exe = join(dir, 'fake-chrome.cjs');
  writeFileSync(
    exe,
    `#!/usr/bin/env node
const { createServer } = require('node:http');
const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const port = Number(
  process.argv.find((a) => a.startsWith('--remote-debugging-port=')).slice('--remote-debugging-port='.length),
);
const counter = ${JSON.stringify(join(dir, 'starts'))};
const starts = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0;
writeFileSync(counter, String(starts + 1));
if (starts < ${lostStarts} || port === ${lostPort}) process.exit(21);
setTimeout(() => process.exit(0), 30000).unref();
const ws = 'ws://127.0.0.1:' + port + '/devtools/browser/fake-' + process.pid;
const server = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    req.url === '/json/version'
      ? JSON.stringify({ Browser: 'Chrome/999.0.0.0', webSocketDebuggerUrl: ws })
      : '[]',
  );
});
server.listen(port, '127.0.0.1', () => {
  process.stderr.write('\\nDevTools listening on ' + ws + '\\n');
});
`,
  );
  chmodSync(exe, 0o755);
  return exe;
}

function startsOf(exe: string): number {
  const counter = join(exe, '..', 'starts');
  return existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0;
}

describe.skipIf(process.platform === 'win32')(
  'launchBrowser — a Chrome that lost the port race with nothing left listening (#491)',
  () => {
    it('moves on to the next candidate instead of failing the launch', async () => {
      const exe = fakeChrome(1);
      const port = await launchBrowser({ port: BASE, executablePath: exe, launchTimeoutMs: 5000 });
      try {
        expect(port).toBe(BASE + 1);
        expect(startsOf(exe)).toBe(2);
      } finally {
        process.kill(getLaunchedPid(port)!, 'SIGKILL');
      }
    }, 15000);

    it('two concurrent launches that both lost the same candidate both succeed, on different ports', async () => {
      // The CI failure's shape: both racers' Chromes exited early on the
      // first candidate and neither found anything listening there.
      const exe = fakeChrome(0, BASE + 2);
      let results: PromiseSettledResult<number>[] = [];
      try {
        results = await Promise.allSettled([
          launchBrowser({ port: BASE + 2, executablePath: exe, launchTimeoutMs: 5000 }),
          launchBrowser({ port: BASE + 2, executablePath: exe, launchTimeoutMs: 5000 }),
        ]);
      } finally {
        for (const r of results) {
          const pid = r.status === 'fulfilled' ? getLaunchedPid(r.value) : undefined;
          if (pid) process.kill(pid, 'SIGKILL');
        }
      }
      for (const r of results) if (r.status === 'rejected') throw r.reason;
      const ports = results.map((r) => (r as PromiseFulfilledResult<number>).value);
      expect(ports[0]).not.toBe(ports[1]);
      expect(ports).not.toContain(BASE + 2);
    }, 15000);

    it('still surfaces a Chrome that cannot start, after one more attempt', async () => {
      const exe = fakeChrome(Number.POSITIVE_INFINITY);
      await expect(
        launchBrowser({ port: BASE + 5, executablePath: exe, launchTimeoutMs: 5000 }),
      ).rejects.toThrow(/exited before the CDP endpoint opened on port 23445 \(code=21/);
      expect(startsOf(exe)).toBe(2);
    }, 15000);
  },
);
