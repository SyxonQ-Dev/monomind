// #573: a standalone `org run` killed from outside left runtime.json saying
// "running" with a dead pid, and `org status` kept reporting it as running.
// Readers now check that the recorded pid is still the process that wrote the
// record (pid + start identity), and `org status` / `org run` / `org serve`
// mark a dead run crashed with an audit line.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { statusAction, stopAction } from '../commands/org-lifecycle.js';
import { listAction } from '../commands/org-manage.js';
import { reconcileAllStaleRuns, reconcileStaleRun } from '../commands/org-stale-run.js';
import { ownStartId, processStartId, recordedPidLiveness } from '../orgrt/run-liveness.js';
import type { CommandContext } from '../types.js';
import { runtimeView } from '../ui/org-runtime.mjs';

const ORG = 'acme';
const RUN = 'run-20260930120000-abcd';
let root: string;
let child: ChildProcess | undefined;

const orgDir = () => join(root, '.monomind', 'orgs', ORG);
const rtPath = () => join(orgDir(), 'runtime.json');
const readRt = () => JSON.parse(readFileSync(rtPath(), 'utf8'));
const writeRt = (rt: Record<string, unknown>) =>
  writeFileSync(rtPath(), JSON.stringify({ status: 'running', run: RUN, ...rt }));

/** The pid of a process that has already exited. */
const deadPid = (): number => {
  const r = spawnSync(process.execPath, ['-e', '']);
  return r.pid as number;
};

async function capture(fn: () => Promise<unknown>): Promise<string> {
  let out = '';
  const log = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    out += `${a.join(' ')}\n`;
  });
  const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
    out += String(chunk);
    return true;
  });
  try {
    await fn();
  } finally {
    log.mockRestore();
    write.mockRestore();
  }
  return out;
}

const ctx = (args: string[], flags: Record<string, unknown> = {}) =>
  ({ cwd: root, args, flags }) as unknown as CommandContext;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'org-stale-573-'));
  mkdirSync(orgDir(), { recursive: true });
  writeFileSync(
    join(root, '.monomind', 'orgs', `${ORG}.json`),
    JSON.stringify({ name: ORG, roles: [{ id: 'lead', runtime: 'claude' }] }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  child?.kill('SIGKILL');
  child = undefined;
  rmSync(root, { recursive: true, force: true });
});

describe('recordedPidLiveness (#573)', () => {
  it('knows this process by its start identity', () => {
    const id = processStartId(process.pid);
    expect(id).toBeTruthy();
    expect(ownStartId()).toBe(id);
    expect(recordedPidLiveness(process.pid, id)).toBe('alive');
  });

  it('calls a pid with no process dead', () => {
    expect(recordedPidLiveness(deadPid(), 'linux:x:1')).toBe('dead');
    expect(recordedPidLiveness(deadPid())).toBe('dead');
  });

  it('calls a live pid with a different start identity reused', () => {
    expect(recordedPidLiveness(process.pid, 'linux:not-this-boot:1')).toBe('reused');
  });

  it('trusts a live pid on a record written before start identities existed', () => {
    expect(recordedPidLiveness(process.pid, undefined)).toBe('alive');
  });
});

describe('org status on a dead run (#573)', () => {
  it('shows it as crashed (pid gone) and marks the record, with an audit line', async () => {
    const pid = deadPid();
    writeRt({ pid, pidStart: 'linux:x:1' });
    const out = await capture(() => statusAction(ctx([ORG])));
    expect(out).toContain(`crashed (pid ${pid} gone)`);
    expect(out).not.toMatch(/acme: running/);
    const rt = readRt();
    expect(rt).toMatchObject({ status: 'crashed', closedBy: 'liveness-check', run: RUN, pid });
    expect(rt.error).toBe(`pid ${pid} gone`);
    const audit = readFileSync(join(orgDir(), 'liveness.jsonl'), 'utf8').trim().split('\n');
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0])).toMatchObject({
      run: RUN,
      pid,
      status: 'crashed',
      by: 'org status',
    });
  });

  it('--format json reports crashed with the reason and marks the record', async () => {
    const pid = deadPid();
    writeRt({ pid });
    const st = JSON.parse(await capture(() => statusAction(ctx([ORG], { format: 'json' }))));
    expect(st).toMatchObject({ status: 'crashed', closed_by: 'liveness-check' });
    expect(st.error).toBe(`pid ${pid} gone`);
    expect(readRt().status).toBe('crashed');
  });

  it('treats a reused pid (alive, different process) as dead', async () => {
    // Not process.pid: reconcile skips the caller's own pid, so a live child
    // carries the stale identity instead.
    child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { stdio: 'ignore' });
    writeRt({ pid: child.pid, pidStart: 'linux:not-this-boot:1' });
    const out = await capture(() => statusAction(ctx([ORG])));
    expect(out).toContain(`pid ${child.pid} now belongs to another process`);
    expect(readRt()).toMatchObject({ status: 'crashed', closedBy: 'liveness-check' });
  });

  it('leaves a live run running and its record untouched', async () => {
    child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 50));
    const pidStart = processStartId(child.pid as number);
    writeRt({ pid: child.pid, pidStart });
    const before = readFileSync(rtPath(), 'utf8');
    const out = await capture(() => statusAction(ctx([ORG])));
    expect(out).toContain(`${ORG}: running`);
    const st = JSON.parse(await capture(() => statusAction(ctx([ORG], { format: 'json' }))));
    expect(st.status).toBe('running');
    expect(readFileSync(rtPath(), 'utf8')).toBe(before);
    expect(existsSync(join(orgDir(), 'liveness.jsonl'))).toBe(false);
  });
});

describe('other runtime.json readers (#573)', () => {
  it('org list reports a reused pid as crashed', async () => {
    child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { stdio: 'ignore' });
    writeRt({ pid: child.pid, pidStart: 'linux:not-this-boot:1' });
    const list = JSON.parse(await capture(() => listAction(ctx([], { format: 'json' }))));
    expect(list.items[0]).toMatchObject({ name: ORG, status: 'crashed' });
  });

  it('the dashboard runtime view reports a dead run as crashed, a live one as running', async () => {
    const prevBroker = process.env.MONOMIND_ORGRT_BROKER_DIR;
    process.env.MONOMIND_ORGRT_BROKER_DIR = join(root, 'broker');
    try {
      writeRt({ pid: deadPid() });
      expect((await runtimeView(root, ORG))?.status).toBe('crashed');
      child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { stdio: 'ignore' });
      await new Promise((r) => setTimeout(r, 50));
      writeRt({ pid: child.pid, pidStart: processStartId(child.pid as number) });
      expect((await runtimeView(root, ORG))?.status).toBe('running');
    } finally {
      if (prevBroker === undefined) delete process.env.MONOMIND_ORGRT_BROKER_DIR;
      else process.env.MONOMIND_ORGRT_BROKER_DIR = prevBroker;
    }
  });

  it('org stop does not signal a run whose pid was reused', async () => {
    child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { stdio: 'ignore' });
    writeRt({ pid: child.pid, pidStart: 'linux:not-this-boot:1' });
    const res = await capture(() => stopAction(ctx([ORG])));
    expect(res).toContain('is not running');
    expect(existsSync(join(orgDir(), 'stop'))).toBe(false);
  });
});

describe('reconcileStaleRun at org run / serve start (#573)', () => {
  it('marks a dead run crashed and says so', () => {
    const pid = deadPid();
    writeRt({ pid, pidStart: 'linux:x:1' });
    expect(reconcileStaleRun(root, ORG, 'org run')).toMatchObject({
      outcome: 'crashed',
      run: RUN,
      pid,
      reason: `pid ${pid} gone`,
    });
    expect(readRt().status).toBe('crashed');
  });

  it('reports a live run with its pid so a second run is refused', async () => {
    child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 50));
    writeRt({ pid: child.pid, pidStart: processStartId(child.pid as number) });
    expect(reconcileStaleRun(root, ORG, 'org run')).toEqual({ outcome: 'live', pid: child.pid });
    expect(readRt().status).toBe('running');
  });

  it('ignores records that are not running, and the calling process own record', () => {
    writeRt({ status: 'stopped', pid: deadPid() });
    expect(reconcileStaleRun(root, ORG, 'org run')).toEqual({ outcome: 'none' });
    writeRt({ pid: process.pid });
    expect(reconcileStaleRun(root, ORG, 'org run')).toEqual({ outcome: 'none' });
  });

  it('reconcileAllStaleRuns closes every dead run in the project', () => {
    const pid = deadPid();
    writeRt({ pid });
    expect(reconcileAllStaleRuns(root, 'org serve')).toEqual([
      { org: ORG, outcome: 'crashed', run: RUN, pid, reason: `pid ${pid} gone` },
    ]);
    expect(reconcileAllStaleRuns(root, 'org serve')).toEqual([]);
  });
});
