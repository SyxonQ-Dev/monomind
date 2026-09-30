/**
 * #562 — the session audit and the session ledger name the runtime that
 * actually hosts the role, the one runner-resolve picks, including a runtime
 * that comes from `provider.kind` (vercel-api-key -> vercel) rather than
 * `role.runtime ?? def.runtime ?? 'claude'`. A ledger entry an older build
 * wrote under the `claude` key for such a role is still resumed, and moves to
 * the right key when it is.
 */
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OrgBus } from '../../src/orgrt/bus.js';
import { PolicyEngine } from '../../src/orgrt/policy.js';
import { Mailbox } from '../../src/orgrt/mailbox.js';
import { runAgentSession } from '../../src/orgrt/session.js';
import { SessionLedger } from '../../src/orgrt/session-ledger.js';
import { resolveRoleRuntime } from '../../src/orgrt/runner-resolve.js';

const made: string[] = [];
const dir = () => {
  const d = mkdtempSync(join(tmpdir(), 'rtkey-562-'));
  made.push(d);
  return d;
};
/** The ledger's persisted records, reduced to their key and session id. */
const records = (file: string) =>
  (JSON.parse(readFileSync(file, 'utf8')).records as any[]).map(({ role, runtime, taskKey, sessionId }) => ({
    role,
    runtime,
    taskKey,
    sessionId,
  }));
/** A ledger file as a pre-#562 build left it: records carry no runtimeResolved. */
const oldBuildLedger = (records: object[]) => {
  const file = join(dir(), 'sessions.json');
  writeFileSync(file, JSON.stringify({ records, runs: [] }));
  return file;
};
const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));

// Runner selection reads MONOMIND_RUNTIME; the caller's shell must not decide these tests.
let savedRuntimeEnv: string | undefined;
beforeEach(() => {
  savedRuntimeEnv = process.env.MONOMIND_RUNTIME;
  delete process.env.MONOMIND_RUNTIME;
});
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  if (savedRuntimeEnv === undefined) delete process.env.MONOMIND_RUNTIME;
  else process.env.MONOMIND_RUNTIME = savedRuntimeEnv;
});

/** Fake SDK: a session id per query() unless resumed. */
function fakeSdk() {
  const calls: { resume?: string }[] = [];
  let n = 0;
  const queryFn = ({ prompt, options }: any) =>
    (async function* () {
      calls.push({ resume: options?.resume });
      const sid = options?.resume ?? `sid-${++n}`;
      yield { type: 'system', subtype: 'init', session_id: sid };
      for await (const _msg of prompt) {
        yield { type: 'assistant', session_id: sid, message: { content: [{ type: 'text', text: 'ok' }] } };
        yield {
          type: 'result',
          subtype: 'success',
          session_id: sid,
          usage: { input_tokens: 1, output_tokens: 1 },
          total_cost_usd: 0,
        };
      }
    })();
  return { queryFn, calls };
}

const taskDef = {
  name: 'o',
  goal: 'g',
  roles: [{ id: 'boss' }, { id: 'dev', reports_to: 'boss' }],
  run_config: { session_scope: 'task' },
} as any;

function run(
  mailbox: Mailbox,
  queryFn: any,
  extra: Record<string, unknown>,
  provider: Record<string, unknown> = { kind: 'vercel-api-key' },
) {
  const bus = new OrgBus('o', 'r', dir());
  const audits: any[] = [];
  bus.subscribe((e) => {
    if (e.type === 'audit' && e.reason === 'session-run') audits.push(e);
  });
  const policy = new PolicyEngine('dev', {}, bus, '/work');
  const role = {
    id: 'dev',
    title: 'Dev',
    type: 'coder',
    reports_to: 'boss',
    responsibilities: [],
    provider,
  } as any;
  const done = runAgentSession({
    org: 'o',
    role,
    bus,
    policy,
    mailbox,
    cwd: '/work',
    deliver: async () => 'delivered',
    queryFn,
    ...extra,
  } as any);
  return { done, audits };
}

describe('#562 resolveRoleRuntime', () => {
  it('is the runtime runner selection picks, provider.kind included', () => {
    expect(resolveRoleRuntime(undefined, undefined, 'vercel-api-key')).toBe('vercel');
    expect(resolveRoleRuntime(undefined, undefined, 'codex')).toBe('codex');
    expect(resolveRoleRuntime('claude', undefined, 'vercel-api-key')).toBe('claude');
    expect(resolveRoleRuntime(undefined, 'kimicode', 'vercel-api-key')).toBe('kimicode');
    expect(resolveRoleRuntime(undefined, undefined, 'subscription')).toBeUndefined();
  });
});

describe('#562 session runtime key for a provider.kind role', () => {
  it('audits and records the run under the resolved runtime, not claude', async () => {
    const sdk = fakeSdk();
    const mailbox = new Mailbox();
    mailbox.push('hello');
    const ledger = new SessionLedger();
    const { done, audits } = run(mailbox, sdk.queryFn, { sessionLedger: ledger });
    await tick();
    mailbox.close();
    await done;
    expect(ledger.runs()[0]).toMatchObject({ role: 'dev', runtime: 'vercel' });
    expect(audits).toHaveLength(1);
    expect(audits[0].data).toMatchObject({ runtime: 'vercel' });
  });

  it('keys a new task-scoped ledger entry under the resolved runtime', async () => {
    const sdk = fakeSdk();
    const mailbox = new Mailbox();
    mailbox.push('[task:task-1] a');
    const file = join(dir(), 'sessions.json');
    const ledger = new SessionLedger(file);
    const { done } = run(mailbox, sdk.queryFn, { def: taskDef, sessionLedger: ledger });
    await tick(40);
    mailbox.close();
    await done;
    expect(records(file)).toEqual([{ role: 'dev', runtime: 'vercel', taskKey: 'task-1', sessionId: 'sid-1' }]);
  });

  it('resumes an entry an older build keyed under claude, and moves it to the new key', async () => {
    const sdk = fakeSdk();
    const mailbox = new Mailbox();
    mailbox.push('[task:task-1] a');
    const file = oldBuildLedger([
      {
        role: 'dev',
        runtime: 'claude',
        taskKey: 'task-1',
        cwd: '/work',
        promptHash: '*',
        sessionId: 'legacy-sid',
      },
    ]);
    const ledger = new SessionLedger(file);
    const { done } = run(mailbox, sdk.queryFn, { def: taskDef, sessionLedger: ledger });
    await tick(40);
    mailbox.close();
    await done;
    expect(sdk.calls[0].resume).toBe('legacy-sid');
    expect(ledger.runs()[0]).toMatchObject({ runtime: 'vercel', reason: 'resumed' });
    expect(records(file)).toEqual([
      { role: 'dev', runtime: 'vercel', taskKey: 'task-1', sessionId: 'legacy-sid' },
    ]);
  });
});

describe('#562 session runtime key without a runner', () => {
  it('keys a role an unknown MONOMIND_RUNTIME leaves on Claude under claude', async () => {
    process.env.MONOMIND_RUNTIME = 'no-such-runtime';
    const sdk = fakeSdk();
    const mailbox = new Mailbox();
    mailbox.push('hello');
    const ledger = new SessionLedger();
    const { done, audits } = run(mailbox, sdk.queryFn, { sessionLedger: ledger }, {});
    await tick();
    mailbox.close();
    await done;
    expect(ledger.runs()[0]).toMatchObject({ role: 'dev', runtime: 'claude' });
    expect(audits[0].data).toMatchObject({ runtime: 'claude' });
  });
});

describe('#562 SessionLedger legacy lookup', () => {
  const q = { role: 'dev', taskKey: 'task-1', cwd: '/work', promptHash: '*' };
  const legacy = { ...q, runtime: 'claude', sessionId: 'legacy-sid' };

  it('reads the legacy key only when asked to', () => {
    const ledger = new SessionLedger(oldBuildLedger([legacy]));
    expect(ledger.resumeFor({ ...q, runtime: 'vercel' }).sessionId).toBeUndefined();
    expect(ledger.resumeFor({ ...q, runtime: 'vercel', legacyRuntime: 'claude' }).sessionId).toBe(
      'legacy-sid',
    );
  });

  it('never moves a claude record this build wrote to another runtime', () => {
    // The role ran on Claude, then its provider (or MONOMIND_RUNTIME) changed:
    // that Claude session id must not reach the new runner.
    const file = join(dir(), 'sessions.json');
    new SessionLedger(file).set(legacy);
    const ledger = new SessionLedger(file);
    expect(ledger.resumeFor({ ...q, runtime: 'vercel', legacyRuntime: 'claude' })).toEqual({
      reason: 'fresh-no-record',
    });
    expect(records(file)).toEqual([
      { role: 'dev', runtime: 'claude', taskKey: 'task-1', sessionId: 'legacy-sid' },
    ]);
  });

  it('prefers a record under the new key over the legacy one', () => {
    const ledger = new SessionLedger(oldBuildLedger([legacy]));
    ledger.set({ ...q, runtime: 'vercel', sessionId: 'new-sid' });
    expect(ledger.resumeFor({ ...q, runtime: 'vercel', legacyRuntime: 'claude' }).sessionId).toBe(
      'new-sid',
    );
  });
});
