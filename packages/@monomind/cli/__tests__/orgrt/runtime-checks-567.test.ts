/**
 * #567 (follow-up to #562): full access, the sandbox choice, their audits and
 * `org sign`'s review name the runtime whose runner hosts a role, including
 * one `provider.kind` selects (vercel-api-key -> vercel, codex -> codex),
 * instead of `role.runtime ?? def.runtime ?? 'claude'`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sandboxCalls = vi.hoisted(() => ({ git: [] as any[], mask: [] as any[] }));
vi.mock('../../src/orgrt/role-sandbox.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/orgrt/role-sandbox.js')>();
  return {
    ...real,
    resolveRoleGitEnforcement: (args: any) => {
      sandboxCalls.git.push(args);
      return real.resolveRoleGitEnforcement(args);
    },
    roleAuthorityMask: (args: any) => {
      sandboxCalls.mask.push(args);
      return real.roleAuthorityMask(args);
    },
  };
});

import { resolveRoleAccess } from '../../src/orgrt/access-grant.js';
import { accessValidationFindings } from '../../src/orgrt/access-validate.js';
import { OrgBus } from '../../src/orgrt/bus.js';
import { Mailbox } from '../../src/orgrt/mailbox.js';
import { describeOrgAuthority, unconfinedRoles } from '../../src/orgrt/org-sign-review.js';
import { PolicyEngine } from '../../src/orgrt/policy.js';
import { effectiveRoleRuntime } from '../../src/orgrt/runner-specs.js';
import { runAgentSession } from '../../src/orgrt/session.js';

const made: string[] = [];
const dir = () => {
  const d = mkdtempSync(join(tmpdir(), 'rtchk-567-'));
  made.push(d);
  return d;
};
let savedRuntimeEnv: string | undefined;
beforeEach(() => {
  savedRuntimeEnv = process.env.MONOMIND_RUNTIME;
  delete process.env.MONOMIND_RUNTIME;
  sandboxCalls.git.length = 0;
  sandboxCalls.mask.length = 0;
});
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  if (savedRuntimeEnv === undefined) delete process.env.MONOMIND_RUNTIME;
  else process.env.MONOMIND_RUNTIME = savedRuntimeEnv;
});

const vercelRole = (extra: Record<string, unknown> = {}) =>
  ({
    id: 'dev',
    title: 'Dev',
    type: 'coder',
    reports_to: 'boss',
    responsibilities: [],
    provider: { kind: 'vercel-api-key' },
    ...extra,
  }) as any;
const defWith = (role: any) => ({ name: 'o', goal: 'g', roles: [{ id: 'boss' }, role] }) as any;

/** Fake SDK: one reply per mailbox message. */
const queryFn = ({ prompt }: any) =>
  (async function* () {
    yield { type: 'system', subtype: 'init', session_id: 'sid-1' };
    for await (const _m of prompt) {
      yield {
        type: 'result',
        subtype: 'success',
        session_id: 'sid-1',
        usage: { input_tokens: 1, output_tokens: 1 },
        total_cost_usd: 0,
      };
    }
  })();

/** One session for `role`; returns the audit events it emitted. */
async function runSession(role: any): Promise<any[]> {
  const bus = new OrgBus('o', 'r', dir());
  const audits: any[] = [];
  bus.subscribe((e) => {
    if (e.type === 'audit') audits.push(e);
  });
  const mailbox = new Mailbox();
  mailbox.push('hello');
  const done = runAgentSession({
    org: 'o',
    role,
    def: defWith(role),
    bus,
    policy: new PolicyEngine('dev', {}, bus, '/work'),
    mailbox,
    cwd: dir(),
    deliver: async () => 'delivered',
    queryFn,
  } as any);
  await new Promise((r) => setTimeout(r, 30));
  mailbox.close();
  await done;
  return audits;
}

describe('#567 effectiveRoleRuntime', () => {
  it('follows provider.kind when nothing is configured', () => {
    expect(effectiveRoleRuntime(undefined, undefined, 'vercel-api-key')).toBe('vercel');
    expect(effectiveRoleRuntime(undefined, undefined, 'codex')).toBe('codex');
    expect(effectiveRoleRuntime(undefined, undefined, undefined)).toBe('claude');
  });

  it('keeps a configured runtime as is, known or not', () => {
    expect(effectiveRoleRuntime('claude', undefined, 'vercel-api-key')).toBe('claude');
    expect(effectiveRoleRuntime(undefined, 'grok', 'vercel-api-key')).toBe('grok');
    expect(effectiveRoleRuntime('no-such-runtime', undefined, undefined)).toBe('no-such-runtime');
  });

  it('maps a MONOMIND_RUNTIME no runner answers to onto claude, which then runs', () => {
    process.env.MONOMIND_RUNTIME = 'no-such-runtime';
    expect(effectiveRoleRuntime(undefined, undefined, undefined)).toBe('claude');
    process.env.MONOMIND_RUNTIME = 'codex';
    expect(effectiveRoleRuntime(undefined, undefined, undefined)).toBe('codex');
  });
});

describe('#567 full access for a provider.kind -> vercel role', () => {
  const role = vercelRole({ policy: { access: 'full' } });

  it('is checked against the vercel runner, which has no full access', () => {
    const r = resolveRoleAccess(defWith(role), role, { getuid: () => 1000 });
    expect(r).toMatchObject({ access: 'scoped', state: 'suspended' });
    expect(r.reason).toContain('runtime "vercel" does not support full access');
    expect(accessValidationFindings(defWith(role)).errors.join('\n')).toContain(
      `policy.access 'full' is not supported by runtime "vercel"`,
    );
  });

  it("is audited under the vercel runtime when the session starts", async () => {
    const audits = await runSession(role);
    const notActive = audits.find((e) => e.reason === 'full-access-not-active');
    expect(notActive?.msg).toContain('runtime "vercel" does not support full access');
    expect(audits.some((e) => e.reason === 'full-access-active')).toBe(false);
  });

  it('a role still on claude keeps its existing check', () => {
    const claudeRole = { ...role, provider: undefined };
    const r = resolveRoleAccess(defWith(claudeRole), claudeRole, { getuid: () => 1000 });
    expect(r.reason).not.toContain('does not support full access');
  });
});

describe('#567 sandbox choice for a provider.kind role', () => {
  it('treats a vercel role as in-process and names vercel to git enforcement', async () => {
    await runSession(vercelRole());
    expect(sandboxCalls.mask.at(-1)).toMatchObject({ inProcess: true });
    expect(sandboxCalls.git.at(-1)).toMatchObject({ runtime: 'vercel' });
  });

  it('names codex for a codex role and keeps its mask', async () => {
    await runSession(vercelRole({ provider: { kind: 'codex' } }));
    expect(sandboxCalls.mask.at(-1)).toMatchObject({ inProcess: false });
    expect(sandboxCalls.git.at(-1)).toMatchObject({ runtime: 'codex' });
  });
});

describe('#567 org sign review for a provider.kind role', () => {
  const raw = (provider: unknown) => ({
    name: 'o',
    roles: [{ id: 'dev', policy: { git: 'read' }, provider }],
  });

  it('warns about a codex role that the SDK sandbox does not cover', () => {
    const loose = unconfinedRoles(raw({ kind: 'codex' }), {
      sdkSandbox: { available: true },
      mask: { available: false, reason: 'no bwrap' },
    });
    expect(loose).toEqual([{ id: 'dev', why: 'runtime codex, and no bubblewrap mask (no bwrap)' }]);
  });

  it('does not count a vercel role as a shell that needs confining', () => {
    const loose = unconfinedRoles(raw({ kind: 'vercel-api-key' }), {
      sdkSandbox: { available: false, reason: 'no sandbox' },
      mask: { available: false, reason: 'no bwrap' },
    });
    expect(loose).toEqual([]);
  });

  it('shows the runtime the role runs on', () => {
    expect(describeOrgAuthority(raw({ kind: 'vercel-api-key' })).join('\n')).toContain(
      'dev: runtime vercel',
    );
  });
});
