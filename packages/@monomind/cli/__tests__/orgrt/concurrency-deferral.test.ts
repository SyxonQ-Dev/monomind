/**
 * #551: a task whose lazily-spawned assignee was deferred by
 * run_config.max_concurrent_agents took the role out of pendingRoles, so every
 * later dispatch pass reported `dispatch-assignee-unresolved` for a role the
 * org defines, and a deferral that gave up left the role's tasks 'ready' with
 * no owner.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OrgDaemon, type RunningOrg } from '../../src/orgrt/daemon.js';
import { dagCreateTask } from '../../src/orgrt/decisions.js';

async function waitUntil(pred: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return pred();
}

let daemon: OrgDaemon | undefined;
afterEach(async () => {
  await daemon?.stopAll();
  daemon = undefined;
});

/** boss + workerA fill max_concurrent_agents: 2; workerA holds its slot until
 *  `freeSlot()` crashes it. workerB is the role whose spawn gets deferred. */
async function startAtCeiling(opts: { maxAttempts?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'concurrency-deferral-'));
  mkdirSync(join(root, '.monomind/orgs'), { recursive: true });
  writeFileSync(
    join(root, '.monomind/orgs/o.json'),
    JSON.stringify({
      name: 'o',
      goal: 'g',
      run_config: { max_concurrent_agents: 2 },
      roles: [
        { id: 'boss', title: 'Boss', type: 'boss', reports_to: null },
        { id: 'workerA', title: 'A', type: 'specialist', reports_to: 'boss' },
        { id: 'workerB', title: 'B', type: 'specialist', reports_to: 'boss' },
      ],
    }),
  );
  let freeSlot: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    freeSlot = resolve;
  });
  const queryFn = ({ prompt, options }: any) => {
    const roleId = /You are agent "([^"]+)"/.exec(options.systemPrompt)?.[1];
    if (roleId === 'workerA')
      return (async function* () {
        for await (const _m of prompt) {
          await gate;
          throw new Error('workerA crashes to free its slot');
        }
      })();
    return (async function* () {
      await new Promise(() => {});
    })();
  };
  daemon = new OrgDaemon(root, {
    queryFn: queryFn as any,
    forward: false,
    stopWaitMs: 200,
    crashBackoffsMs: [],
    concurrencyDeferPollMs: 30,
    concurrencyDeferMaxAttempts: opts.maxAttempts ?? 10_000,
  });
  const running = await daemon.startOrg('o');
  await daemon.deliver('o', 'boss', 'workerA', 'task', 'go');
  expect(running.agents.has('workerA')).toBe(true);
  return { d: daemon, running, freeSlot };
}

const events = (running: RunningOrg, reason: string) =>
  running.busEvents().filter((e) => e.reason === reason);

describe('#551 — max_concurrent_agents deferral keeps the assignee resolvable', () => {
  it('tasks for a deferred role wait (no "does not resolve") and go out once a slot frees', async () => {
    const { d, running, freeSlot } = await startAtCeiling();
    const t1 = JSON.parse(dagCreateTask(d, 'o', 'boss', 'first', 'workerB', []));
    expect(running.agents.has('workerB')).toBe(false);
    expect(running.concurrencyDeferred?.has('workerB')).toBe(true);
    // Later dispatch passes (another task for the same role, one for another).
    const t2 = JSON.parse(dagCreateTask(d, 'o', 'boss', 'second', 'workerB', []));
    dagCreateTask(d, 'o', 'boss', 'third', 'workerA', []);

    expect(events(running, 'dispatch-assignee-unresolved')).toEqual([]);
    expect(running.taskDag!.get(t1.id)?.status).toBe('ready');
    expect(running.taskDag!.get(t2.id)?.status).toBe('ready');
    const waiting = events(running, 'concurrency-limit').filter(
      (e) => e.data?.taskId === t2.id,
    );
    expect(waiting).toHaveLength(1);
    expect(waiting[0].msg).toMatch(/deferred by max_concurrent_agents/);

    freeSlot();
    expect(await waitUntil(() => running.agents.has('workerB'))).toBe(true);
    expect(
      await waitUntil(
        () =>
          running.taskDag!.get(t1.id)?.status === 'running' &&
          running.taskDag!.get(t2.id)?.status === 'running',
      ),
    ).toBe(true);
    expect(running.concurrencyDeferred?.has('workerB')).toBe(false);
    expect(events(running, 'dispatch-assignee-unresolved')).toEqual([]);
  }, 15_000);

  it('a second deferral of the same role joins the first retry loop', async () => {
    const { d, running, freeSlot } = await startAtCeiling();
    dagCreateTask(d, 'o', 'boss', 'first', 'workerB', []);
    const receipt = await d.deliver('o', 'boss', 'workerB', 'hello', 'more context');
    expect(receipt).toMatch(/queued/);
    freeSlot();
    expect(await waitUntil(() => running.agents.has('workerB'))).toBe(true);
    await new Promise((r) => setTimeout(r, 150));
    expect(events(running, 'concurrency-recovered')).toHaveLength(1);
  }, 15_000);

  it('when the deferral gives up, the waiting tasks fail with the reason, the boss is told and the role stays pending', async () => {
    const { d, running } = await startAtCeiling({ maxAttempts: 3 });
    const boxed: string[] = [];
    const box = running.agents.get('boss')!.mailbox;
    const push = box.push.bind(box);
    box.push = (m: string) => {
      boxed.push(m);
      return push(m);
    };
    const t1 = JSON.parse(dagCreateTask(d, 'o', 'boss', 'first', 'workerB', []));
    expect(await waitUntil(() => events(running, 'concurrency-abandoned').length > 0)).toBe(true);

    const task = running.taskDag!.get(t1.id)!;
    expect(task.status).toBe('failed');
    expect(task.result).toMatch(
      /not started — "workerB" could not start: the org stayed at its max_concurrent_agents ceiling \(2\)/,
    );
    expect(events(running, 'concurrency-abandoned')[0].data).toMatchObject({
      roleId: 'workerB',
      failedTasks: [t1.id],
    });
    expect(running.pendingRoles?.has('workerB')).toBe(true);
    expect(running.concurrencyDeferred?.has('workerB')).toBe(false);
    expect(await waitUntil(() => boxed.some((m) => m.includes(t1.id)), 2000)).toBe(true);
    expect(boxed.find((m) => m.includes(t1.id))).toMatch(/marked failed/);

    // Still a known role: new work for it defers again instead of being unresolved.
    dagCreateTask(d, 'o', 'boss', 'later', 'workerB', []);
    expect(running.concurrencyDeferred?.has('workerB')).toBe(true);
    expect(events(running, 'dispatch-assignee-unresolved')).toEqual([]);
  }, 15_000);
});
