/**
 * #477 — the dashboard server (src/ui/server.mjs) must not duplicate, must
 * stop on SIGTERM, and must not grow without bound.
 *
 * The process-level cases boot the REAL built server (dist/src/ui/server.mjs)
 * on kernel-picked free ports against a throwaway project, the same contract as
 * src/__tests__/knowledge-endpoint.test.ts: `pnpm run build` must have run.
 * The rest are in-process regression tests on the structures that were capped.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error — .mjs sibling has no type declarations
import { RUN_CACHE_MAX, readRunDigest, runCacheSize } from '../src/ui/org-runtime.mjs';
// @ts-expect-error — .mjs sibling has no type declarations
import { bindServer, watchTree } from '../src/ui/server-net.mjs';
// @ts-expect-error — .mjs sibling has no type declarations
import { MAX_SSE_BACKLOG_BYTES, writeSse } from '../src/ui/sse-manager.mjs';

const CLI_ROOT = path.resolve(__dirname, '..');
const SERVER_MJS = path.join(CLI_ROOT, 'dist', 'src', 'ui', 'server.mjs');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error('no port assigned'))));
    });
  });
}

let tmpRoot = '';
const children: ChildProcess[] = [];

interface Spawned {
  child: ChildProcess;
  out: () => string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function spawnServer(projectDir: string, port: number): Spawned {
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_PROJECT_DIR: projectDir };
  for (const k of ['MONOMIND_BOUND_REPORT', 'CONTROL_PORT', 'MONOMIND_CONTROL_PORT', 'MONOMIND_HOME'])
    delete env[k];
  const child = spawn(process.execPath, [SERVER_MJS, String(port)], {
    cwd: projectDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let out = '';
  child.stdout?.on('data', (d) => {
    out += d;
  });
  child.stderr?.on('data', (d) => {
    out += d;
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.on('exit', (code, signal) => resolve({ code, signal })),
  );
  return { child, out: () => out, exited };
}

async function identity(port: number): Promise<{ pid: number; dir: string } | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/identity`, {
      signal: AbortSignal.timeout(1000),
    });
    return r.ok ? ((await r.json()) as { pid: number; dir: string }) : null;
  } catch {
    return null;
  }
}

async function waitForServer(port: number, pid: number | undefined, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const id = await identity(port);
    if (id && id.pid === pid) return;
    await sleep(200);
  }
  throw new Error(`server pid ${pid} never answered on :${port}`);
}

function newProject(name: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(tmpRoot, `${name}-`)));
  fs.mkdirSync(path.join(dir, '.monomind'), { recursive: true });
  return dir;
}

const within = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, sleep(ms).then(() => 'timeout' as const)]);

beforeAll(() => {
  tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mm477-')));
});

afterAll(() => {
  for (const c of children) {
    try {
      c.kill('SIGKILL');
    } catch {
      /* gone */
    }
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe.skipIf(!fs.existsSync(SERVER_MJS))('#477 dashboard process lifecycle (built server)', () => {
  it('a second server for the same project and port exits 0 and prints the first one’s URL', async () => {
    const proj = newProject('dup');
    const port = await freePort();
    const first = spawnServer(proj, port);
    await waitForServer(port, first.child.pid);

    const second = spawnServer(proj, port);
    const res = await within(second.exited, 10_000);
    expect(res).toEqual({ code: 0, signal: null });
    expect(second.out()).toContain(`http://localhost:${port}`);
    // The first one is untouched and still serving.
    expect((await identity(port))?.pid).toBe(first.child.pid);
    first.child.kill('SIGKILL');
  }, 60_000);

  it('a start on another port exits 0 when control.json names this project’s live server', async () => {
    const proj = newProject('ctl');
    const port = await freePort();
    const first = spawnServer(proj, port);
    await waitForServer(port, first.child.pid);
    fs.writeFileSync(
      path.join(proj, '.monomind', 'control.json'),
      JSON.stringify({ pid: first.child.pid, port, url: `http://localhost:${port}` }),
    );

    const otherPort = await freePort();
    const second = spawnServer(proj, otherPort);
    expect(await within(second.exited, 10_000)).toEqual({ code: 0, signal: null });
    expect(second.out()).toContain(`http://localhost:${port}`);
    expect(await identity(otherPort)).toBeNull(); // never bound
    first.child.kill('SIGKILL');
  }, 60_000);

  it('another project’s server on the port does not count: the start still binds', async () => {
    const foreign = newProject('foreign');
    const proj = newProject('own');
    const port = await freePort();
    const theirs = spawnServer(foreign, port);
    await waitForServer(port, theirs.child.pid);

    const ours = spawnServer(proj, port);
    const deadline = Date.now() + 30_000;
    let bound = 0;
    while (!bound && Date.now() < deadline) {
      for (let p = port + 1; p <= port + 10 && !bound; p++) {
        const id = await identity(p);
        if (id?.pid === ours.child.pid) bound = p;
      }
      if (!bound) await sleep(300);
    }
    expect(bound).toBeGreaterThan(port);
    theirs.child.kill('SIGKILL');
    ours.child.kill('SIGKILL');
  }, 60_000);

  it('SIGTERM exits 0 within 5 s with SSE clients still connected', async () => {
    const proj = newProject('term');
    fs.mkdirSync(path.join(proj, '.monomind', 'orgs', 'demo', 'runs'), { recursive: true });
    const port = await freePort();
    const srv = spawnServer(proj, port);
    await waitForServer(port, srv.child.pid);
    const cred = fs.readFileSync(path.join(proj, '.monomind', 'dashboard-token'), 'utf8').trim();
    // One client on each stream kind: mastermind and per-org streams were never
    // closed by shutdown, and /api/events-stream is a plain long-lived socket.
    const held: http.ClientRequest[] = [];
    for (const p of ['/api/stream', '/api/mastermind-stream', '/api/orgs/demo/stream', '/api/events-stream']) {
      const req = http.get({ host: '127.0.0.1', port, path: `${p}?token=${cred}`, agent: false });
      req.on('response', (r) => r.resume());
      req.on('error', () => {});
      held.push(req);
    }
    await sleep(1000);
    const t0 = Date.now();
    srv.child.kill('SIGTERM');
    const res = await within(srv.exited, 5_000);
    for (const r of held) r.destroy();
    expect(res).toEqual({ code: 0, signal: null });
    expect(Date.now() - t0).toBeLessThan(5_000);
  }, 60_000);
});

describe('#477 bounded structures', () => {
  const inotifyWatches = (): number => {
    let n = 0;
    for (const fd of fs.readdirSync('/proc/self/fd')) {
      try {
        if (!fs.readlinkSync(`/proc/self/fd/${fd}`).includes('inotify')) continue;
        n += (fs.readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8').match(/^inotify/gm) || []).length;
      } catch {
        /* fd closed meanwhile */
      }
    }
    return n;
  };
  let tree: { close(): void } | null = null;
  afterEach(() => {
    tree?.close();
    tree = null;
  });

  it.runIf(process.platform === 'linux')(
    'watchTree watches directories, not files, and still reports nested changes',
    async () => {
      const root = newProject('tree');
      for (let d = 0; d < 10; d++) {
        const dir = path.join(root, `d${d}`, 'inner');
        fs.mkdirSync(dir, { recursive: true });
        for (let f = 0; f < 100; f++) fs.writeFileSync(path.join(dir, `f${f}.json`), '{}');
      }
      fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
      const before = inotifyWatches();
      const events: string[] = [];
      tree = watchTree(root, (_evt: string, rel: string) => events.push(String(rel)), {
        skip: (rel: string) => rel.split(path.sep).includes('node_modules'),
      });
      // root + .monomind + 10 dirs + 10 inner dirs — not 1000 files (Node's own recursive
      // emulation on Linux opened one watch per file).
      expect(inotifyWatches() - before).toBeLessThanOrEqual(22);

      fs.appendFileSync(path.join(root, 'd3', 'inner', 'f7.json'), ' ');
      fs.mkdirSync(path.join(root, 'late'));
      await sleep(100);
      fs.writeFileSync(path.join(root, 'late', 'new.md'), 'x');
      fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'x.js'), 'x');
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && !events.includes(path.join('late', 'new.md'))) await sleep(50);
      expect(events).toContain(path.join('d3', 'inner', 'f7.json'));
      expect(events).toContain(path.join('late', 'new.md'));
      expect(events.some((e) => e.includes('node_modules'))).toBe(false);

      tree.close();
      tree = null;
      expect(inotifyWatches()).toBe(before);
    },
  );

  it('bindServer keeps http.Server connection tracking, so closeAllConnections() works after a port walk', async () => {
    const busy = net.createServer();
    await new Promise<void>((r) => busy.listen(0, '127.0.0.1', r));
    const busyPort = (busy.address() as net.AddressInfo).port;
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(': open\n\n'); // never ended, like an SSE stream
    });
    try {
      const bound = await bindServer(server, busyPort);
      expect(bound).not.toBe(busyPort);
      const req = http.get({ host: '127.0.0.1', port: bound, path: '/', agent: false });
      req.on('error', () => {});
      await new Promise((r) => req.on('response', r));
      const closed = new Promise((r) => server.close(r));
      server.closeAllConnections();
      expect(await within(closed, 2000)).not.toBe('timeout');
    } finally {
      busy.close();
    }
  });

  it('writeSse drops a client that stopped reading instead of buffering forever', () => {
    const registry = new Set<any>();
    let destroyed = false;
    const stalled = {
      destroyed: false,
      writableEnded: false,
      writableLength: MAX_SSE_BACKLOG_BYTES + 1,
      write: () => true,
      destroy: () => {
        destroyed = true;
      },
    };
    const writes: string[] = [];
    const healthy = {
      destroyed: false,
      writableEnded: false,
      writableLength: 0,
      write: (m: string) => writes.push(m),
      destroy: () => {},
    };
    const gone = { ...healthy, destroyed: true };
    registry.add(stalled).add(healthy).add(gone);
    for (const c of [...registry]) writeSse(c, 'data: x\n\n', registry);
    expect(destroyed).toBe(true);
    expect([...registry]).toEqual([healthy]);
    expect(writes).toEqual(['data: x\n\n']);
  });

  it('SSE registries drop every client that disconnects', async () => {
    const proj = newProject('sse');
    fs.mkdirSync(path.join(proj, '.monomind', 'orgs', 'demo', 'runs'), { recursive: true });
    const signals = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const;
    const before = signals.map((s) => process.listeners(s).length);
    const { startServer } = await import('../src/ui/server.mjs' as string);
    const { getMmClientCount, getSseClientCount } = await import('../src/ui/sse-manager.mjs' as string);
    const { runStreamClients } = await import('../src/ui/server-rundb.mjs' as string);
    const res = await startServer({ port: 0, projectDir: proj, openBrowser: false });
    try {
      const cred = fs.readFileSync(path.join(proj, '.monomind', 'dashboard-token'), 'utf8').trim();
      const paths = ['/api/stream', '/api/mastermind-stream', '/api/orgs/demo/stream'];
      for (let round = 0; round < 25; round++) {
        await Promise.all(
          paths.map(
            (p) =>
              new Promise<void>((resolve) => {
                const req = http.get(
                  { host: '127.0.0.1', port: res.port, path: `${p}?token=${cred}`, agent: false },
                  (r) => {
                    r.resume();
                    setTimeout(() => {
                      req.destroy();
                      resolve();
                    }, 20);
                  },
                );
                req.on('error', () => resolve());
              }),
          ),
        );
      }
      const deadline = Date.now() + 5000;
      while (
        Date.now() < deadline &&
        (getSseClientCount() || getMmClientCount() || runStreamClients.size)
      )
        await sleep(50);
      expect(getSseClientCount()).toBe(0);
      expect(getMmClientCount()).toBe(0);
      expect(runStreamClients.size).toBe(0);
    } finally {
      // Undo startServer's process-wide side effects without calling its
      // shutdown (that ends in process.exit).
      signals.forEach((s, i) => {
        const ls = process.listeners(s);
        for (const l of ls.slice(before[i])) process.removeListener(s, l as never);
      });
      res.server.closeAllConnections();
      await new Promise((r) => res.server.close(r));
    }
  }, 60_000);

  it('the run digest cache keeps at most RUN_CACHE_MAX runs', () => {
    const root = newProject('runs');
    const total = RUN_CACHE_MAX + 20;
    for (let i = 0; i < total; i++) {
      const runDir = path.join(root, '.monomind', 'orgs', 'o', `r${i}`);
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(path.join(runDir, 'bus.jsonl'), `${JSON.stringify({ ts: i, from: 'a' })}\n`);
      expect(readRunDigest(root, 'o', `r${i}`)?.startedAt).toBe(i);
    }
    expect(runCacheSize()).toBe(RUN_CACHE_MAX);
  });
});
