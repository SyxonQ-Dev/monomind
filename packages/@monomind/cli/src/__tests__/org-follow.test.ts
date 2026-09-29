/**
 * #433: `org events|logs|watch --follow` must not outlive its consumer.
 * Covers the shared follow loop (parent watchdog, stdout EPIPE/close,
 * SIGHUP, run closed), the byte-offset tail, and one real-process check
 * that an orphaned `org events --follow` exits when its parent is SIGKILLed.
 */

import { spawn } from 'node:child_process';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLineTail, followUntilDone } from '../commands/org-follow.js';
import { eventsAction } from '../commands/org-observe.js';
import type { CommandContext, ParsedFlags } from '../types.js';

const ORG = 'acme';
const RUN = 'run-20260925090000-ab12';
const CLI_BIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'cli.js');

let root: string;
let runDir: string;
let busFile: string;

const ev = (n: number, extra: Record<string, unknown> = {}): string =>
  `${JSON.stringify({ id: `${RUN}-${n}`, ts: Date.parse('2026-09-25T09:00:00Z') + n * 60_000, org: ORG, run: RUN, type: 'chat', from: 'boss', msg: `m${n}`, ...extra })}\n`;
const stopEvent = (n: number): string =>
  ev(n, { type: 'status', reason: 'org-stopped', msg: 'org stopped' });
const setRuntime = (status: string, run = RUN): void =>
  writeFileSync(
    join(root, '.monomind', 'orgs', ORG, 'runtime.json'),
    JSON.stringify({ status, run }),
  );

const listenerCounts = () => ({
  SIGINT: process.listenerCount('SIGINT'),
  SIGTERM: process.listenerCount('SIGTERM'),
  SIGHUP: process.listenerCount('SIGHUP'),
  error: process.stdout.listenerCount('error'),
  close: process.stdout.listenerCount('close'),
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'monomind-orgfollow-'));
  runDir = join(root, '.monomind', 'orgs', ORG, RUN);
  mkdirSync(runDir, { recursive: true });
  busFile = join(runDir, 'bus.jsonl');
  writeFileSync(busFile, '');
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe('createLineTail — byte-offset tailing', () => {
  it('returns each appended line exactly once, holding back a partial line until completed', () => {
    const read = createLineTail(busFile);
    appendFileSync(busFile, ev(1) + ev(2));
    expect(read()).toHaveLength(2);
    expect(read()).toEqual([]);
    const third = ev(3);
    appendFileSync(busFile, third.slice(0, 10)); // mid-append partial write
    expect(read()).toEqual([]);
    appendFileSync(busFile, third.slice(10) + ev(4));
    const lines = read();
    expect(lines.map((l) => JSON.parse(l).id)).toEqual([`${RUN}-3`, `${RUN}-4`]);
    expect(read()).toEqual([]);
  });

  it('keeps a multi-byte character split across two reads intact', () => {
    const read = createLineTail(busFile);
    const line = Buffer.from(ev(1, { msg: 'héllo — ✓' }));
    const cut = line.indexOf(Buffer.from('✓')) + 1; // inside the 3-byte sequence
    appendFileSync(busFile, line.subarray(0, cut));
    expect(read()).toEqual([]);
    appendFileSync(busFile, line.subarray(cut));
    expect(JSON.parse(read()[0]).msg).toBe('héllo — ✓');
  });

  it('passes corrupt interior lines through for the caller to skip, and emits a parseable final line without newline', () => {
    const read = createLineTail(busFile);
    appendFileSync(busFile, `${ev(1)}{corrupt\n${ev(2).trimEnd()}`);
    const lines = read();
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[2]).id).toBe(`${RUN}-2`);
    appendFileSync(busFile, '\n');
    expect(read()).toEqual([]);
  });
});

describe('followUntilDone — stops when the consumer is gone', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('stops when the process is re-parented (parent pid changes)', async () => {
    const before = listenerCounts();
    const real = process.ppid;
    const ppid = vi.spyOn(process, 'ppid', 'get').mockReturnValue(real);
    const drain = vi.fn();
    const done = followUntilDone(drain, () => false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(drain).toHaveBeenCalledTimes(2);
    ppid.mockReturnValue(1);
    await vi.advanceTimersByTimeAsync(500);
    await expect(done).resolves.toBe('orphaned');
    expect(drain).toHaveBeenCalledTimes(2);
    expect(listenerCounts()).toEqual(before);
  });

  it('stops on stdout EPIPE', async () => {
    const before = listenerCounts();
    const done = followUntilDone(vi.fn(), () => false);
    process.stdout.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    await expect(done).resolves.toBe('consumer-gone');
    expect(listenerCounts()).toEqual(before);
  });

  it('stops when stdout closes', async () => {
    const before = listenerCounts();
    const done = followUntilDone(vi.fn(), () => false);
    process.stdout.emit('close');
    await expect(done).resolves.toBe('consumer-gone');
    expect(listenerCounts()).toEqual(before);
  });

  it('stops on SIGHUP (and removes its SIGINT/SIGTERM handlers)', async () => {
    const before = listenerCounts();
    const done = followUntilDone(vi.fn(), () => false);
    expect(process.listenerCount('SIGHUP')).toBe(before.SIGHUP + 1);
    process.emit('SIGHUP', 'SIGHUP');
    await expect(done).resolves.toBe('signal');
    expect(listenerCounts()).toEqual(before);
  });

  it('drains once more and stops when the run is closed', async () => {
    const before = listenerCounts();
    const drain = vi.fn();
    let closed = false;
    const done = followUntilDone(drain, () => closed);
    await vi.advanceTimersByTimeAsync(500);
    expect(drain).toHaveBeenCalledTimes(1);
    closed = true;
    await vi.advanceTimersByTimeAsync(500);
    await expect(done).resolves.toBe('closed');
    expect(drain).toHaveBeenCalledTimes(3); // tick + final drain
    expect(listenerCounts()).toEqual(before);
  });
});

describe('org events --follow', () => {
  let out: string[];
  const ctx = (flags: Record<string, unknown>): CommandContext => ({
    args: [ORG],
    flags: { ...flags } as ParsedFlags,
    cwd: root,
    interactive: false,
  });
  const ids = (): string[] =>
    out
      .join('')
      .split('\n')
      .filter(Boolean)
      .map((l) => (JSON.parse(l) as { id: string }).id);

  beforeEach(() => {
    vi.useFakeTimers();
    out = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      out.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
  });

  it('streams appended events exactly once and exits once the run is closed', async () => {
    setRuntime('running');
    appendFileSync(busFile, ev(1));
    let finished = false;
    const done = eventsAction(ctx({ follow: true }), ORG).then((r) => {
      finished = true;
      return r;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(ids()).toEqual([`${RUN}-1`]);
    const second = ev(2);
    appendFileSync(busFile, second.slice(0, 15));
    await vi.advanceTimersByTimeAsync(500);
    expect(ids()).toEqual([`${RUN}-1`]);
    appendFileSync(busFile, second.slice(15) + stopEvent(3));
    await vi.advanceTimersByTimeAsync(1500);
    expect(ids()).toEqual([`${RUN}-1`, `${RUN}-2`, `${RUN}-3`]);
    // org-stopped seen but runtime.json still says this run is running: the
    // daemon has not sealed the bus yet, so keep following.
    expect(finished).toBe(false);
    appendFileSync(busFile, ev(4)); // a late audit event before the seal
    setRuntime('stopped');
    await vi.advanceTimersByTimeAsync(500);
    await expect(done).resolves.toMatchObject({ success: true });
    expect(ids()).toEqual([`${RUN}-1`, `${RUN}-2`, `${RUN}-3`, `${RUN}-4`]);
  });

  it('keeps following a live run', async () => {
    setRuntime('running');
    let finished = false;
    void eventsAction(ctx({ follow: true }), ORG).then(() => {
      finished = true;
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(finished).toBe(false);
    process.emit('SIGINT', 'SIGINT');
    await vi.advanceTimersByTimeAsync(0);
    expect(finished).toBe(true);
  });

  it('exits on org-stopped when a newer run owns runtime.json', async () => {
    setRuntime('running', 'run-20260925100000-cd34');
    appendFileSync(busFile, ev(1) + stopEvent(2));
    const done = eventsAction(ctx({ follow: true }), ORG);
    await vi.advanceTimersByTimeAsync(500);
    await expect(done).resolves.toMatchObject({ success: true });
    expect(ids()).toEqual([`${RUN}-1`, `${RUN}-2`]);
  });

  it('--since <eventId> still suppresses replay up to the cursor while following', async () => {
    setRuntime('running');
    appendFileSync(busFile, ev(1) + ev(2) + ev(3));
    const done = eventsAction(ctx({ follow: true, since: `${RUN}-2` }), ORG);
    await vi.advanceTimersByTimeAsync(0);
    expect(ids()).toEqual([`${RUN}-3`]);
    appendFileSync(busFile, ev(4));
    setRuntime('stopped');
    await vi.advanceTimersByTimeAsync(500);
    await done;
    expect(ids()).toEqual([`${RUN}-3`, `${RUN}-4`]);
  });

  it('--since <iso> still filters older events while following', async () => {
    setRuntime('running');
    appendFileSync(busFile, ev(1) + ev(2));
    const done = eventsAction(ctx({ follow: true, since: '2026-09-25T09:01:30Z' }), ORG);
    await vi.advanceTimersByTimeAsync(0);
    expect(ids()).toEqual([`${RUN}-2`]);
    appendFileSync(busFile, ev(3));
    setRuntime('crashed');
    await vi.advanceTimersByTimeAsync(500);
    await done;
    expect(ids()).toEqual([`${RUN}-2`, `${RUN}-3`]);
  });
});

const readOut = (f: string): string => {
  try {
    return readFileSync(f, 'utf8');
  } catch {
    return '';
  }
};

describe.skipIf(process.platform === 'win32')('real process', () => {
  it('an orphaned `org events --follow` exits when its parent is SIGKILLed', async () => {
    setRuntime('running');
    appendFileSync(busFile, ev(1));
    // sh is the follower's parent; the follower's stdout goes to a file, so
    // no pipe breaks — only the parent watchdog can notice it was orphaned.
    const outFile = join(root, 'follower.out');
    const parent = spawn(
      'sh',
      [
        '-c',
        `"${process.execPath}" "${CLI_BIN}" org events ${ORG} --follow >"${outFile}" 2>&1 & echo $!; wait`,
      ],
      { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const pid = await new Promise<number>((resolve, reject) => {
      parent.stdout.once('data', (d: Buffer) => resolve(Number(String(d).trim())));
      parent.once('error', reject);
    });
    const alive = (): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    try {
      // The first event is written right before the follow loop starts.
      const t = Date.now();
      while (!readOut(outFile).includes(`${RUN}-1`) && Date.now() - t < 12_000)
        await new Promise((r) => setTimeout(r, 100));
      expect(readOut(outFile)).toContain(`${RUN}-1`);
      await new Promise((r) => setTimeout(r, 700));
      expect(alive()).toBe(true);
      parent.kill('SIGKILL');
      const t0 = Date.now();
      while (alive() && Date.now() - t0 < 4000) await new Promise((r) => setTimeout(r, 100));
      expect(alive()).toBe(false);
      expect(Date.now() - t0).toBeLessThan(2500);
    } finally {
      if (alive()) process.kill(pid, 'SIGKILL');
    }
  }, 20_000);
});
