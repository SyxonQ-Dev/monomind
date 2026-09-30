// packages/@monomind/cli/__tests__/orgrt/decider-approval-wait.test.ts
/**
 * #553: an approval a decider owns (org `autonomy` with a model/boss/parent/jev
 * decider) holds the tool call until the decider resolves it, bounded by the
 * decider's timeout_seconds, instead of denying it as "pending human
 * approval" and making the role retry. Human-owned approvals are unchanged.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  approvalOwnership,
  awaitApproval,
  DECIDER_WAIT_MAX_S,
} from '../../src/orgrt/approval-decider.js';
import { setApproval } from '../../src/orgrt/approvals.js';
import type { OrgDaemon } from '../../src/orgrt/daemon.js';
import type { Decision, PolicyEngine } from '../../src/orgrt/policy.js';
import { gatedCanUseTool } from '../../src/orgrt/session-gate.js';

const allowPolicy = {
  decide: async (): Promise<Decision> => ({ behavior: 'allow', updatedInput: {} }),
} as unknown as PolicyEngine;

function fakeDaemon(root: string, autonomy?: unknown) {
  const mailbox: string[] = [];
  const kinds: string[] = [];
  const daemon = {
    root,
    approvals: new Map(),
    approvalLocks: new Map(),
    recordDecision: () => {},
    orgs: new Map([
      [
        'o',
        {
          def: { roles: [{ id: 'boss' }], ...(autonomy ? { autonomy } : {}) },
          agents: new Map([['boss', { mailbox: { isClosed: false, push: (m: string) => mailbox.push(m) } }]]),
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
  return { daemon, gate, mailbox, kinds };
}

const deciderAutonomy = (timeout_seconds: number) => ({
  level: 'full',
  decider: { kind: 'model', model: 'claude-opus', timeout_seconds },
});

/** Resolves the one queued request once the gate has queued it. */
async function resolveWhenQueued(daemon: OrgDaemon, approved: boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (daemon.approvals.get('o')?.length) {
      await setApproval(daemon, 'o', 'boss', 'Bash', approved, { resolvedBy: 'decider:model' });
      return;
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('request never queued');
}

describe('#553 approvalOwnership', () => {
  it('a full-autonomy org with a model decider owns approvals, bounded by timeout_seconds', () => {
    expect(approvalOwnership({ autonomy: deciderAutonomy(120) }, 'Bash')).toEqual({
      owner: 'decider',
      decider: 'model claude-opus',
      waitMs: 120_000,
    });
  });

  it('caps the wait below the PreToolUse hook timeout', () => {
    const o = approvalOwnership({ autonomy: deciderAutonomy(10_000) }, 'Bash');
    expect(o.owner === 'decider' && o.waitMs).toBe(DECIDER_WAIT_MAX_S * 1000);
  });

  it('manual level, no autonomy, or a mid-level irreversible tier stays human-owned', () => {
    expect(approvalOwnership({}, 'Bash')).toEqual({ owner: 'human' });
    expect(
      approvalOwnership({ autonomy: { level: 'manual', decider: { kind: 'model' } } }, 'Bash'),
    ).toEqual({ owner: 'human' });
    expect(
      approvalOwnership(
        { autonomy: { level: 'mid', decider: { kind: 'model' }, tiers: { Bash: 'irreversible' } } },
        'Bash',
      ),
    ).toEqual({ owner: 'human' });
  });
});

describe('#553 the gate waits for a decider-owned approval', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'decider-553-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('the decider approves while the call waits: the call proceeds, no retry message', async () => {
    const { daemon, gate, mailbox, kinds } = fakeDaemon(root, deciderAutonomy(30));
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
    const { daemon, gate, kinds } = fakeDaemon(root, deciderAutonomy(30));
    const [decision] = await Promise.all([
      gate('Bash', { command: 'rm -rf build' }),
      resolveWhenQueued(daemon, false),
    ]);
    expect(decision.behavior).toBe('deny');
    const m = decision.behavior === 'deny' ? decision.message : '';
    expect(m).toMatch(/the org's decider \(decider:model\) refused this one Bash call/);
    expect(m).not.toMatch(/human/);
    expect(kinds).toEqual(['approval-denied']);
  });

  it('timeout: the call is held for the bound, then told the decider (not a human) will decide', async () => {
    const { daemon, gate, kinds, mailbox } = fakeDaemon(root, deciderAutonomy(0.05));
    const started = Date.now();
    const decision = await gate('Bash', { command: 'npm run lint' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(40);
    expect(decision.behavior).toBe('deny');
    const m = decision.behavior === 'deny' ? decision.message : '';
    expect(m).toMatch(/waiting on the org's decider \(model claude-opus\), not a human/);
    expect(m).not.toMatch(/pending human approval/);
    expect(kinds).toEqual(['approval-pending']);
    // Still queued; a late decision reaches the role by mailbox, naming the decider.
    expect(daemon.approvals.get('o')?.[0]).toMatchObject({ approved: null });
    await setApproval(daemon, 'o', 'boss', 'Bash', true, { resolvedBy: 'decider:model' });
    expect(mailbox[0]).toMatch(/the decider \(decider:model\) approved your pending Bash call/);
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
