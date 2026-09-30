// #586: reconcileStaleRun re-read runtime.json, then renamed a `crashed`
// record over it. A new run that wrote its record between the two lost it
// until its next state write. The record is now swapped only while it is
// still the dead run's: a newer record always survives.
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hook = vi.hoisted(() => ({
  /** The first rename/link touching this path runs `inject` before or after it. */
  target: '',
  when: 'before' as 'before' | 'after',
  inject: undefined as (() => void) | undefined,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const wrap =
    <A extends [fs.PathLike, fs.PathLike]>(fn: (...a: A) => void) =>
    (...a: A) => {
      const fire = hook.inject && (String(a[0]) === hook.target || String(a[1]) === hook.target);
      const inject = fire ? hook.inject : undefined;
      if (fire) hook.inject = undefined;
      if (inject && hook.when === 'before') inject();
      fn(...a);
      if (inject && hook.when === 'after') inject();
    };
  return {
    ...actual,
    renameSync: wrap(actual.renameSync as (a: fs.PathLike, b: fs.PathLike) => void),
    linkSync: wrap(actual.linkSync as (a: fs.PathLike, b: fs.PathLike) => void),
  };
});

const { reconcileStaleRun } = await import('../commands/org-stale-run.js');

const ORG = 'acme';
const RUN = 'run-20260930120000-dead';
let root: string;

const orgDir = () => join(root, '.monomind', 'orgs', ORG);
const rtPath = () => join(orgDir(), 'runtime.json');
const readRt = () => JSON.parse(fs.readFileSync(rtPath(), 'utf8'));
const deadPid = (): number => spawnSync(process.execPath, ['-e', '']).pid as number;

/** What a new run's persistState writes (tmp + rename), in another process. */
const NEW_RECORD = {
  status: 'running',
  run: 'run-20260930120500-live',
  pid: 424242,
  pidStart: 'x:new',
};
const newRunWrites = () => {
  const tmp = `${rtPath()}.new.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(NEW_RECORD));
  fs.renameSync(tmp, rtPath());
};

beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), 'org-stale-586-'));
  fs.mkdirSync(orgDir(), { recursive: true });
  fs.writeFileSync(
    join(root, '.monomind', 'orgs', `${ORG}.json`),
    JSON.stringify({ name: ORG, roles: [{ id: 'lead', runtime: 'claude' }] }),
  );
  fs.writeFileSync(
    rtPath(),
    JSON.stringify({ status: 'running', run: RUN, pid: deadPid(), pidStart: 'linux:x:1' }),
  );
  hook.target = rtPath();
});

afterEach(() => {
  hook.inject = undefined;
  fs.rmSync(root, { recursive: true, force: true });
});

const leftovers = () => fs.readdirSync(orgDir()).filter((f) => f.startsWith('runtime.json.'));

describe('reconcileStaleRun racing a new run (#586)', () => {
  it("keeps a new run's record written after the re-read, just before the swap", () => {
    hook.when = 'before';
    hook.inject = newRunWrites;
    expect(reconcileStaleRun(root, ORG, 'org status')).toEqual({ outcome: 'none' });
    expect(readRt()).toEqual(NEW_RECORD);
    expect(leftovers()).toEqual([]);
    expect(fs.existsSync(join(orgDir(), 'liveness.jsonl'))).toBe(false);
  });

  it("keeps a new run's record written while the dead record is being swapped", () => {
    hook.when = 'after';
    hook.inject = newRunWrites;
    expect(reconcileStaleRun(root, ORG, 'org status')).toEqual({ outcome: 'none' });
    expect(readRt()).toEqual(NEW_RECORD);
    expect(leftovers()).toEqual([]);
  });

  it('still marks the dead run crashed when nothing races it', () => {
    expect(reconcileStaleRun(root, ORG, 'org status')).toMatchObject({
      outcome: 'crashed',
      run: RUN,
    });
    expect(readRt()).toMatchObject({ status: 'crashed', run: RUN, closedBy: 'liveness-check' });
    expect(leftovers()).toEqual([]);
  });
});
