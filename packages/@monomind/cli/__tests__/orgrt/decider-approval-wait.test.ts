// packages/@monomind/cli/__tests__/orgrt/decider-approval-wait.test.ts
/**
 * #553: an approval the org's autonomy routes to a rule or a decider (per
 * mono-agent's level × tier routing) holds the tool call until mono-agent
 * resolves it, bounded by the decider's timeout_seconds + 25s, instead of
 * denying it as "pending human approval" and making the role retry.
 * Human-owned approvals are unchanged.
 */
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  approvalOwnership,
  awaitApproval,
  classForAction,
  DECIDER_WAIT_MAX_S,
  tierFor,
} from '../../src/orgrt/approval-decider.js';
import { checkApproval, setApproval } from '../../src/orgrt/approvals.js';
import type { OrgDaemon } from '../../src/orgrt/daemon.js';
import type { Decision, PolicyEngine } from '../../src/orgrt/policy.js';
import { gatedCanUseTool } from '../../src/orgrt/session-gate.js';
import { ORG_DIR } from '../../src/orgrt/types.js';

const allowPolicy = {
  decide: async (): Promise<Decision> => ({ behavior: 'allow', updatedInput: {} }),
} as unknown as PolicyEngine;

let fileTick = 0;
function writeOrgFile(root: string, autonomy?: unknown): void {
  mkdirSync(join(root, ORG_DIR), { recursive: true });
  const path = join(root, ORG_DIR, 'o.json');
  writeFileSync(path, JSON.stringify({ name: 'o', roles: [], ...(autonomy ? { autonomy } : {}) }));
  // Distinct mtimes so the mtime cache sees every rewrite.
  const t = new Date(Date.now() + ++fileTick * 1000);
  utimesSync(path, t, t);
}

function fakeDaemon(root: string, autonomy?: unknown) {
  writeOrgFile(root, autonomy);
  const mailbox: string[] = [];
  const kinds: string[] = [];
  const box = { isClosed: false, push: (m: string) => mailbox.push(m) };
  const daemon = {
    root,
    approvals: new Map(),
    approvalLocks: new Map(),
    recordDecision: () => {},
    orgs: new Map([
      [
        'o',
        {
          // Deliberately NOT the autonomy block: it must be read from the file.
          def: { roles: [{ id: 'boss' }] },
          agents: new Map([['boss', { mailbox: box }]]),
          bus: { emit: () => {} },
        },
      ],
    ]),
  } as unknown as OrgDaemon;
  const gate = gatedCanUseTool(
    allowPolicy,
    (r, tool, input) => awaitApproval(daemon, 'o', r, tool, input),
    'boss',
    undefined,
    (_t, _i, _d, kind) => kinds.push(kind),
  );
  return { daemon, gate, mailbox, kinds, box };
}

const full = (timeout_seconds?: number) => ({
  level: 'full',
  decider: { kind: 'model', model: 'claude-opus', timeout_seconds },
});

/** Resolves the queued request(s) once the gate has queued `count`. */
async function resolveWhenQueued(
  daemon: OrgDaemon,
  approved: boolean,
  resolvedBy = 'model:claude-opus',
  count = 1,
): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if ((daemon.approvals.get('o')?.length ?? 0) >= count) {
      await setApproval(daemon, 'o', 'boss', 'Bash', approved, { resolvedBy });
      return;
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('request never queued');
}

describe('#553 mono-agent routing port', () => {
  it('ClassForAction (route.go:42-54)', () => {
    expect(classForAction('Bash')).toBe('tool:Bash');
    expect(classForAction('monoagent__automation_publish')).toBe('grant:publish');
    expect(classForAction('monoagent__org_start')).toBe('org_start');
    expect(classForAction('org_complete')).toBe('org_complete');
  });

  it('TierFor: exact, then tool:*/grant:* wildcard, then default; unknown is irreversible', () => {
    expect(tierFor('tool:Bash', {})).toBe('routine');
    expect(tierFor('tool:Bash', { 'tool:*': 'consequential' })).toBe('consequential');
    expect(tierFor('tool:Bash', { 'tool:*': 'consequential', 'tool:Bash': 'irreversible' })).toBe(
      'irreversible',
    );
    // mono-agent rejects bare tool names as tier keys; they never match.
    expect(tierFor('tool:Bash', { Bash: 'irreversible' })).toBe('routine');
    expect(tierFor('grant:publish', {})).toBe('irreversible');
    expect(tierFor('grant:publish', { 'grant:*': 'consequential' })).toBe('consequential');
    expect(tierFor('org_complete', {})).toBe('consequential');
    expect(tierFor('something_else', {})).toBe('irreversible');
    expect(tierFor('tool:Bash', { 'tool:Bash': 'bogus' })).toBe('routine');
  });
});

describe('#553 approvalOwnership', () => {
  it('full autonomy: waits timeout_seconds + 25s', () => {
    expect(approvalOwnership(full(120), 'Bash')).toEqual({
      owner: 'decider',
      decider: 'rule (routine at full)',
      waitMs: 145_000,
    });
    expect(approvalOwnership(full(), 'org_complete')).toEqual({
      owner: 'decider',
      decider: 'decider model claude-opus',
      waitMs: 145_000,
    });
  });

  it('caps the wait below the PreToolUse hook timeout', () => {
    const o = approvalOwnership(full(10_000), 'Bash');
    expect(o.owner === 'decider' && o.waitMs).toBe(DECIDER_WAIT_MAX_S * 1000);
  });

  it('mid: tool:Bash (routine) and org_complete (consequential) are automated', () => {
    const mid = { level: 'mid', decider: { kind: 'model' } };
    expect(approvalOwnership(mid, 'Bash').owner).toBe('decider');
    expect(approvalOwnership(mid, 'org_complete').owner).toBe('decider');
  });

  it('mid: tool:Bash marked irreversible (exact or tool:*) goes to a person', () => {
    const d = { kind: 'model' };
    expect(
      approvalOwnership({ level: 'mid', decider: d, tiers: { 'tool:Bash': 'irreversible' } }, 'Bash'),
    ).toEqual({ owner: 'human' });
    expect(
      approvalOwnership({ level: 'mid', decider: d, tiers: { 'tool:*': 'irreversible' } }, 'Bash'),
    ).toEqual({ owner: 'human' });
  });

  it('mid: a grant with no known tier is irreversible, so human-owned; grant:* can lower it', () => {
    const d = { kind: 'model' };
    const grant = 'monoagent__automation_publish';
    expect(approvalOwnership({ level: 'mid', decider: d }, grant)).toEqual({ owner: 'human' });
    expect(
      approvalOwnership({ level: 'mid', decider: d, tiers: { 'grant:*': 'consequential' } }, grant)
        .owner,
    ).toBe('decider');
    // At full, even an irreversible grant goes to the decider.
    expect(approvalOwnership({ level: 'full', decider: d }, grant).owner).toBe('decider');
  });

  it('manual, missing, unknown or malformed autonomy is human-owned', () => {
    expect(approvalOwnership(undefined, 'Bash')).toEqual({ owner: 'human' });
    expect(approvalOwnership({ level: 'manual', decider: { kind: 'model' } }, 'Bash').owner).toBe(
      'human',
    );
    expect(approvalOwnership({ level: 'turbo', decider: { kind: 'model' } }, 'Bash').owner).toBe(
      'human',
    );
    expect(approvalOwnership({ level: 'full', decider: { kind: 'oracle' } }, 'Bash').owner).toBe(
      'human',
    );
    expect(approvalOwnership({ level: 'full' }, 'Bash').owner).toBe('human');
    expect(
      approvalOwnership({ level: 'full', decider: { kind: 'model' }, tiers: 'x' }, 'Bash').owner,
    ).toBe('human');
    expect(
      approvalOwnership({ level: 'full', decider: { kind: 'model', timeout_seconds: 'x' } }, 'Bash')
        .owner,
    ).toBe('human');
  });

  it('an active pause (paused_until in the future, or paused: true) is human-owned', () => {
    const now = Date.parse('2026-09-30T12:00:00Z');
    const a = (extra: object) => ({ ...full(60), ...extra });
    expect(approvalOwnership(a({ paused_until: '2026-09-30T13:00:00Z' }), 'Bash', now).owner).toBe(
      'human',
    );
    expect(approvalOwnership(a({ paused: true }), 'Bash', now).owner).toBe('human');
    expect(approvalOwnership(a({ paused_until: 'soon' }), 'Bash', now).owner).toBe('human');
    // An expired pause no longer applies.
    expect(approvalOwnership(a({ paused_until: '2026-09-30T11:00:00Z' }), 'Bash', now).owner).toBe(
      'decider',
    );
  });
});

describe('#553 the gate waits for an automated approval', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'decider-553-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('the decider approves while the call waits: the call proceeds, no retry message', async () => {
    const { daemon, gate, mailbox, kinds } = fakeDaemon(root, full(30));
    const [decision] = await Promise.all([
      gate('Bash', { command: 'npm test' }),
      resolveWhenQueued(daemon, true),
    ]);
    expect(decision.behavior).toBe('allow');
    expect(kinds).toEqual([]);
    // The waiting call already ran — telling the role to repeat it would run it twice.
    expect(mailbox).toEqual([]);
  });

  it('the decider denies: the call gets a denial naming the decider, not a human', async () => {
    const { daemon, gate, kinds } = fakeDaemon(root, full(30));
    const [decision] = await Promise.all([
      gate('Bash', { command: 'rm -rf build' }),
      resolveWhenQueued(daemon, false),
    ]);
    expect(decision.behavior).toBe('deny');
    const m = decision.behavior === 'deny' ? decision.message : '';
    expect(m).toMatch(/the org's decider \(model:claude-opus\) refused this one Bash call/);
    expect(m).not.toMatch(/human/);
    expect(kinds).toEqual(['approval-denied']);
  });

  it('timeout message: an honest "decider or human", not "pending human approval"', async () => {
    const kinds: string[] = [];
    const gate = gatedCanUseTool(
      allowPolicy,
      async () => ({ approved: null, owner: 'decider', decider: 'decider model x', waitedMs: 50 }),
      'boss',
      undefined,
      (_t, _i, _d, kind) => kinds.push(kind),
    );
    const decision = await gate('Bash', { command: 'npm run lint' });
    const m = decision.behavior === 'deny' ? decision.message : '';
    expect(m).toMatch(/waited for the org's autonomy \(decider model x\)/);
    expect(m).toMatch(/no decision within 0s/);
    expect(m).toMatch(/a decider or a human will resolve it, and an \[approval\] message follows/);
    expect(m).not.toMatch(/pending human approval/);
    expect(kinds).toEqual(['approval-pending']);
  });

  it('timeout through the real wait: the request stays queued and a late decision is mailed', async () => {
    const { daemon, gate, mailbox, kinds } = fakeDaemon(root, full(30));
    const { setTimeout: realSetTimeout } = globalThis;
    // Shrink only the long wait timer; keep everything else real.
    globalThis.setTimeout = ((fn: () => void, ms?: number) =>
      realSetTimeout(fn, ms !== undefined && ms > 10_000 ? 30 : ms)) as typeof setTimeout;
    let decision: Decision;
    try {
      decision = await gate('Bash', { command: 'npm run lint' });
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    expect(decision.behavior).toBe('deny');
    expect(kinds).toEqual(['approval-pending']);
    expect(daemon.approvals.get('o')?.[0]).toMatchObject({ approved: null });
    await setApproval(daemon, 'o', 'boss', 'Bash', true, { resolvedBy: 'model:claude-opus' });
    expect(mailbox[0]).toMatch(
      /the org's decider \(model:claude-opus\) approved your pending Bash call/,
    );
  });

  it('reads autonomy fresh from the org file: lowering to manual stops the wait', async () => {
    const { gate, kinds } = fakeDaemon(root, full(30));
    writeOrgFile(root, { level: 'manual' });
    const started = Date.now();
    const decision = await gate('Bash', { command: 'ls' });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(decision.behavior === 'deny' && decision.message).toMatch(/pending human approval/);
    expect(kinds).toEqual(['approval-pending']);
  });

  it('a mid-level grant with no known tier does not wait (irreversible → person)', async () => {
    const { daemon } = fakeDaemon(root, { level: 'mid', decider: { kind: 'model' } });
    (
      daemon.orgs.get('o') as unknown as { def: { roles: unknown[] } }
    ).def.roles = [{ id: 'boss', policy: { approvalTools: ['monoagent__automation_publish'] } }];
    const started = Date.now();
    const v = await awaitApproval(daemon, 'o', 'boss', 'monoagent__automation_publish', {});
    expect(Date.now() - started).toBeLessThan(1000);
    expect(v).toMatchObject({ approved: null, owner: 'human' });
  });

  it('org_complete at full waits for the decider', async () => {
    const { daemon } = fakeDaemon(root, full(30));
    const [v] = await Promise.all([
      awaitApproval(daemon, 'o', 'boss', 'mcp__org__org_complete', { outcome: 'achieved' }),
      (async () => {
        for (let i = 0; i < 400 && !daemon.approvals.get('o')?.length; i++)
          await new Promise((r) => setTimeout(r, 5));
        await setApproval(daemon, 'o', 'boss', 'org_complete', true, {
          resolvedBy: 'model:claude-opus',
        });
      })(),
    ]);
    expect(v).toMatchObject({ approved: true, owner: 'decider' });
  });

  it('a role closing cancels the wait', async () => {
    const { daemon, gate, box } = fakeDaemon(root, full(30));
    const pending = gate('Bash', { command: 'sleep 1' });
    for (let i = 0; i < 400 && !daemon.approvals.get('o')?.length; i++)
      await new Promise((r) => setTimeout(r, 5));
    box.isClosed = true;
    const started = Date.now();
    const decision = await pending;
    expect(Date.now() - started).toBeLessThan(2000);
    expect(decision.behavior === 'deny' && decision.message).toMatch(/is stopping/);
  });

  it('the org stopping cancels the wait', async () => {
    const { daemon, gate } = fakeDaemon(root, full(30));
    const pending = gate('Bash', { command: 'sleep 2' });
    for (let i = 0; i < 400 && !daemon.approvals.get('o')?.length; i++)
      await new Promise((r) => setTimeout(r, 5));
    daemon.orgs.delete('o');
    const decision = await pending;
    expect(decision.behavior === 'deny' && decision.message).toMatch(/is stopping/);
  });

  it('a human approving a waited and a not-waited entry together does not tell the waited call to repeat', async () => {
    const { daemon, gate, mailbox } = fakeDaemon(root, full(30));
    // An earlier call that is no longer waiting (queued without a waiter).
    writeOrgFile(root, { level: 'manual' });
    await checkApproval(daemon, 'o', 'boss', 'Bash', { command: 'echo old' });
    writeOrgFile(root, full(30));
    const [decision] = await Promise.all([
      gate('Bash', { command: 'echo new' }),
      resolveWhenQueued(daemon, true, 'alice', 2),
    ]);
    expect(decision.behavior).toBe('allow');
    expect(mailbox).toHaveLength(1);
    expect(mailbox[0]).toMatch(/a human \(alice\) approved/);
    expect(mailbox[0]).toMatch(/echo old/);
    expect(mailbox[0]).not.toMatch(/echo new/);
    expect(mailbox[0]).toMatch(/already got it — do not repeat that one/);
  });

  it('human approvals are unchanged: pending at once, with the human message', async () => {
    const { daemon, gate, kinds, mailbox } = fakeDaemon(root);
    const started = Date.now();
    const decision = await gate('Bash', { command: 'npm publish' });
    expect(Date.now() - started).toBeLessThan(1000);
    const m = decision.behavior === 'deny' ? decision.message : '';
    expect(m).toMatch(/pending human approval/);
    expect(kinds).toEqual(['approval-pending']);
    await setApproval(daemon, 'o', 'boss', 'Bash', true);
    expect(mailbox[0]).toMatch(/a human approved your pending Bash call/);
  });
});
