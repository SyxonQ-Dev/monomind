/**
 * #552: once run_config.budget_tokens was spent, enforceOrgBudget closed every
 * open mailbox and cleared pendingRoles — but a role whose spawn was already
 * deferred by max_concurrent_agents kept its retry loop, which spawned it with
 * an open mailbox after "closing all roles" as soon as the closure freed a
 * slot. It then ran until idle-stop.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OrgDaemon, type RunningOrg } from '../../src/orgrt/daemon.js';
import { dagCreateTask } from '../../src/orgrt/decisions.js';

function writeOrg(root: string, budgetTokens: number): void {
  mkdirSync(join(root, '.monomind/orgs'), { recursive: true });
  const role = (id: string) => ({
    id,
    title: id,
    type: id === 'boss' ? 'boss' : 'specialist',
    reports_to: id === 'boss' ? null : 'boss',
    // Own large caps, so only the org-wide ceiling can close them.
    budget_tokens: 50_000,
  });
  writeFileSync(
    join(root, '.monomind/orgs/o.json'),
    JSON.stringify({
      name: 'o',
      goal: 'g',
      run_config: { budget_tokens: budgetTokens, max_concurrent_agents: 2 },
      roles: ['boss', 'workerA', 'workerB', 'workerC'].map(role),
    }),
  );
}

// A message's input tokens are read from its text: the largest `tok=<n>` in
// it (a coalesced turn-end nudge can repeat an earlier task's title).
const tokQuery = ({ prompt }: any) =>
  (async function* () {
    for await (const m of prompt) {
      const toks = [...String(m.message.content).matchAll(/tok=(\d+)/g)].map((x) => Number(x[1]));
      const tok = Math.max(1, ...toks);
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } };
      yield {
        type: 'result',
        subtype: 'success',
        session_id: 'sess',
        usage: { input_tokens: tok, output_tokens: 1 },
        total_cost_usd: 0,
      };
    }
  })();

async function waitUntil(pred: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return pred();
}

const events = (running: RunningOrg, reason: string) =>
  running.busEvents().filter((e) => e.reason === reason);

let daemon: OrgDaemon | undefined;
afterEach(async () => {
  await daemon?.stopAll();
  daemon = undefined;
});

/** boss + workerA fill max_concurrent_agents: 2, then a task for workerB
 *  defers its spawn. */
async function startWithDeferredWorkerB() {
  const root = mkdtempSync(join(tmpdir(), 'budget-deferred-spawn-'));
  writeOrg(root, 1000);
  daemon = new OrgDaemon(root, {
    queryFn: tokQuery as any,
    forward: false,
    stopWaitMs: 200,
    crashBackoffsMs: [],
    concurrencyDeferPollMs: 30,
  });
  const running = await daemon.startOrg('o');
  const a1 = JSON.parse(dagCreateTask(daemon, 'o', 'boss', 'warm up tok=5', 'workerA', []));
  expect(running.agents.has('workerA')).toBe(true);
  expect(await waitUntil(() => running.taskDag!.get(a1.id)?.status === 'running')).toBe(true);
  const b = JSON.parse(dagCreateTask(daemon, 'o', 'boss', 'b work tok=5', 'workerB', []));
  expect(running.concurrencyDeferred?.has('workerB')).toBe(true);
  return { root, d: daemon, running, bTask: b.id as string };
}

describe('#552 — budget closure cancels deferred lazy spawns', () => {
  it('a spawn deferred by max_concurrent_agents does not start after the org-wide ceiling closes the org', async () => {
    const { root, d, running, bTask } = await startWithDeferredWorkerB();
    dagCreateTask(d, 'o', 'boss', 'spend tok=1200', 'workerA', []);
    expect(await waitUntil(() => events(running, 'org-budget-exhausted').length === 1)).toBe(true);
    // The closure frees workerA's slot; the deferred loop polls every 30ms.
    expect(
      await waitUntil(() => running.agents.get('workerA')?.status !== 'running', 3000),
    ).toBe(true);
    await new Promise((r) => setTimeout(r, 300));

    expect(running.agents.has('workerB')).toBe(false);
    expect(events(running, 'concurrency-recovered')).toEqual([]);
    const cancelled = events(running, 'deferred-spawn-cancelled');
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0].from).toBe('workerB');
    expect(cancelled[0].msg).toMatch(/org-wide budget_tokens exhausted/);
    // Its task is held with the reason, not reported as an unknown assignee.
    const task = running.taskDag!.get(bTask)!;
    expect(task.status).toBe('blocked');
    expect(task.blockedReason).toMatch(
      /assignee "workerB" closed: org-wide budget_tokens exhausted \(\d+ \/ 1000\)/,
    );
    expect(events(running, 'dispatch-assignee-unresolved')).toEqual([]);

    // A reload that raises the ceiling brings it back: its task is released
    // and its spawn deferred again (boss and workerA are respawned at the cap).
    writeOrg(root, 100_000);
    d.reloadOrgDef('o');
    expect(running.orgBudgetClosed).toBeUndefined();
    expect(running.taskDag!.get(bTask)?.status).toBe('ready');
    expect(running.concurrencyDeferred?.has('workerB')).toBe(true);
  }, 20_000);

  it('spawnRole refuses while the org-wide ceiling is spent', async () => {
    const { d, running } = await startWithDeferredWorkerB();
    dagCreateTask(d, 'o', 'boss', 'spend tok=1200', 'workerA', []);
    expect(await waitUntil(() => events(running, 'org-budget-exhausted').length === 1)).toBe(true);
    const workerB = running.def.roles.find((r) => r.id === 'workerB')!;
    running.spawnRole!(workerB);
    expect(running.agents.has('workerB')).toBe(false);
    expect(events(running, 'spawn-refused').map((e) => e.from)).toEqual(['workerB']);
  }, 20_000);

  it("a deferred spawn re-checks the role's own budget closure before it starts", async () => {
    const { d, running } = await startWithDeferredWorkerB();
    // workerC's spawn is deferred, and by the time a slot frees it is closed
    // for its own budget (its own caps or #550's turn floor).
    const role = running.def.roles.find((r) => r.id === 'workerC')!;
    running.pendingRoles!.delete('workerC');
    const spawned: string[] = [];
    d.scheduleConcurrencyDeferredSpawn('o', running, role, (r) => spawned.push(r.id));
    running.spawnRole!(role);
    const rt = running.agents.get('workerC')!;
    (running.budgetClosed ??= new Set()).add('workerC');
    rt.mailbox.close('token-budget');
    // Free a slot: close workerA the same way.
    running.agents.get('workerA')!.mailbox.close('token-budget');
    expect(
      await waitUntil(() =>
        events(running, 'deferred-spawn-cancelled').some((e) => e.from === 'workerC'),
      ),
    ).toBe(true);
    expect(spawned).toEqual([]);
    expect(running.concurrencyDeferred?.has('workerC')).toBe(false);
  }, 20_000);
});
