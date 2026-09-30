/**
 * #559: ~/.monomind/deps is read-only inside an org role (#527), so a role
 * cannot do the first-use install of the Claude Agent SDK that
 * `agent exec --runtime claude` needs. The org runtime host, which runs
 * outside the sandbox, installs it before it spawns a role; inside a role a
 * missing SDK fails at once with the operator command that installs it.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { depsCommand } from '../../src/commands/deps.js';
import { OrgBus } from '../../src/orgrt/bus.js';
import { Mailbox } from '../../src/orgrt/mailbox.js';
import { PolicyEngine } from '../../src/orgrt/policy.js';
import { ensureRoleDeps, type RoleDepsProbe } from '../../src/orgrt/role-deps.js';
import { runAgentSession, type SessionOpts } from '../../src/orgrt/session.js';
import { OrgDefSchema } from '../../src/orgrt/types.js';
import type { CommandContext } from '../../src/types.js';
import {
  depsRoot,
  ensureOptionalDependency,
  manualInstallCommand,
  OptionalDependencyError,
} from '../../src/utils/optional-deps.js';
import {
  FAKE_PINS,
  fakeNpm,
  HOST,
  notFound,
  SDK,
} from '../../src/__tests__/fixtures/optional-deps-fixture.js';

function probe(over: Partial<RoleDepsProbe> = {}): RoleDepsProbe & { installs: number } {
  const p = {
    env: {} as NodeJS.ProcessEnv,
    sdkPresent: () => false,
    claudeOnPath: () => false,
    installs: 0,
    install: async () => {
      p.installs++;
    },
    ...over,
  };
  return p;
}

describe('ensureRoleDeps (host side)', () => {
  it('installs the SDK for a claude-runtime role when it is missing', async () => {
    const p = probe();
    expect(await ensureRoleDeps('claude', p)).toEqual({ status: 'installed' });
    expect(p.installs).toBe(1);
  });

  it('installs it for any role when the claude runtime is available (agent exec may use it)', async () => {
    const p = probe({ claudeOnPath: () => true });
    expect(await ensureRoleDeps('codex', p)).toEqual({ status: 'installed' });
    expect(p.installs).toBe(1);
  });

  it('does nothing when the SDK is already present', async () => {
    const p = probe({ sdkPresent: () => true });
    expect(await ensureRoleDeps('claude', p)).toEqual({ status: 'present' });
    expect(p.installs).toBe(0);
  });

  it('does nothing for a non-claude role on a host without the claude runtime', async () => {
    const p = probe();
    expect(await ensureRoleDeps('hermes', p)).toEqual({ status: 'not-needed' });
    expect(p.installs).toBe(0);
  });

  it('never installs from inside a role, where the deps dir is read-only', async () => {
    const p = probe({ env: { MONOMIND_ORG_ROLE: 'builder' } });
    expect(await ensureRoleDeps('claude', p)).toEqual({ status: 'in-role' });
    expect(p.installs).toBe(0);
  });

  it('reports a failed install instead of throwing', async () => {
    const p = probe({
      install: async () => {
        throw new Error('npm exited 1: ETIMEDOUT');
      },
    });
    const r = await ensureRoleDeps('claude', p);
    expect(r).toMatchObject({ status: 'failed' });
    expect(r.status === 'failed' && r.error).toContain('ETIMEDOUT');
  });
});

describe('runOneSession', () => {
  it('ensures the role deps on the host before it spawns the runner', async () => {
    const order: string[] = [];
    const runner = {
      run: async function* (args: any) {
        order.push('spawn');
        for await (const _ of args.prompt) {
          yield { type: 'result', subtype: 'success', result: 'done' };
          return;
        }
      },
    };
    const def = OrgDefSchema.parse({ name: 'x', roles: [{ id: 'worker', runtime: 'codex' }] });
    const bus = new OrgBus('x', 'run-1', mkdtempSync(join(tmpdir(), 'role-deps-')));
    const mailbox = new Mailbox();
    mailbox.push('go');
    mailbox.close();
    const ensure = vi.fn(async (runtime: string) => {
      order.push(`ensure:${runtime}`);
      return { status: 'installed' as const };
    });
    const opts = {
      org: 'x',
      role: def.roles[0],
      bus,
      policy: new PolicyEngine('worker', {}, bus, '/tmp'),
      mailbox,
      cwd: '/tmp',
      def,
      deliver: async () => 'ok',
      runner,
      ensureRoleDeps: ensure,
    } as unknown as SessionOpts;
    await runAgentSession(opts).catch(() => {});
    expect(order[0]).toBe('ensure:codex');
    expect(order).toContain('spawn');
    expect(order.indexOf('ensure:codex')).toBeLessThan(order.indexOf('spawn'));
  });
});

describe('in a role, a missing SDK fails fast (#559)', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'mm-role-deps-'));
  });
  afterEach(() => {
    chmodSync(depsRoot({ MONOMIND_HOME: home }), 0o700);
    rmSync(home, { recursive: true, force: true });
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'names the operator command and never runs npm when the deps dir is read-only',
    async () => {
      const env = { MONOMIND_HOME: home, MONOMIND_ORG_ROLE: 'builder' };
      mkdirSync(depsRoot(env), { recursive: true, mode: 0o700 });
      chmodSync(depsRoot(env), 0o555);
      const npm = fakeNpm('unused');
      const log = vi.fn();
      const err = (await ensureOptionalDependency(SDK, {
        env,
        resolveOwn: notFound,
        log,
        host: HOST,
        pins: FAKE_PINS,
        runNpm: npm.run,
      }).catch((e: unknown) => e)) as Error;
      expect(err).toBeInstanceOf(OptionalDependencyError);
      expect(err.message).toContain('monomind deps install');
      expect(err.message).toContain(manualInstallCommand(SDK, env));
      expect(err.message).not.toMatch(/^EROFS|^EACCES/);
      expect(npm.calls).toHaveLength(0);
      expect(log.mock.calls.flat().join('\n')).not.toMatch(/Installing it once/);
    },
  );
});

describe('monomind deps install', () => {
  it('refuses to run inside an org role', async () => {
    const install = depsCommand.subcommands?.find((c) => c.name === 'install');
    const saved = process.env.MONOMIND_ORG_ROLE;
    process.env.MONOMIND_ORG_ROLE = 'builder';
    try {
      const r = await install!.action!({ args: [], flags: {} } as unknown as CommandContext);
      expect(r).toMatchObject({ success: false });
    } finally {
      if (saved === undefined) delete process.env.MONOMIND_ORG_ROLE;
      else process.env.MONOMIND_ORG_ROLE = saved;
    }
  });
});
