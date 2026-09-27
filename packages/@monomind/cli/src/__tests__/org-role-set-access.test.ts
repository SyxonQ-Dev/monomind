// #365: `monomind org role set-access <org> <role> <full|scoped>` — the
// human-only write path for policy.access.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { setAccessAction } from '../commands/org-subcommands-role.js';
import { resolveRoleAccess } from '../orgrt/access-grant.js';
import { ORG_DIR, OrgDefSchema } from '../orgrt/types.js';
import type { CommandContext } from '../types.js';

function makeOrg(cwd: string, name: string, def: Record<string, unknown>): string {
  const dir = join(cwd, ORG_DIR);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.json`);
  writeFileSync(path, JSON.stringify(def, null, 2), 'utf8');
  return path;
}

function ctx(
  args: string[],
  flags: Record<string, unknown> = {},
  interactive = false,
): CommandContext {
  return {
    args,
    flags: { _: [], ...flags } as CommandContext['flags'],
    cwd: mkdtempSync(join(tmpdir(), 'org-role-set-access-')),
    interactive,
  };
}

describe('org role set-access', () => {
  it('usage error with too few args', async () => {
    const c = ctx(['myorg']);
    const res = await setAccessAction(c);
    expect(res.success).toBe(false);
  });

  it('org not found', async () => {
    const c = ctx(['nope', 'builder', 'full'], { 'yes-i-understand': true });
    const res = await setAccessAction(c);
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/org not found/);
  });

  it('non-interactive grant without --yes-i-understand is refused', async () => {
    const c = ctx(['myorg', 'builder', 'full']);
    makeOrg(c.cwd, 'myorg', {
      name: 'myorg',
      roles: [{ id: 'builder', runtime: 'claude' }],
    });
    const res = await setAccessAction(c);
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/--yes-i-understand/);
    const written = JSON.parse(readFileSync(join(c.cwd, ORG_DIR, 'myorg.json'), 'utf8'));
    expect(written.roles[0].policy).toBeUndefined();
  });

  it('refuses to grant full access on a runtime that does not support it', async () => {
    const c = ctx(['myorg', 'builder', 'full'], { 'yes-i-understand': true });
    makeOrg(c.cwd, 'myorg', { name: 'myorg', roles: [{ id: 'builder', runtime: 'codex' }] });
    const res = await setAccessAction(c);
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/does not support full access/);
  });

  it('--yes-i-understand grants full access and writes a matching access_ack', async () => {
    const c = ctx(['myorg', 'builder', 'full'], { 'yes-i-understand': true });
    const path = makeOrg(c.cwd, 'myorg', {
      name: 'myorg',
      roles: [{ id: 'builder', runtime: 'claude', responsibilities: ['ship it'] }],
    });
    const res = await setAccessAction(c);
    expect(res.success).toBe(true);
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    expect(raw.roles[0].policy.access).toBe('full');
    expect(raw.roles[0].policy.access_ack.by).toBe('human');
    expect(typeof raw.roles[0].policy.access_ack.hash).toBe('string');

    // The written grant must actually resolve to active for the runtime.
    const def = OrgDefSchema.parse(raw);
    const resolved = resolveRoleAccess(def, def.roles[0]);
    expect(resolved).toEqual({ access: 'full', declared: 'full', state: 'active' });
  });

  it('a subsequent unrelated config edit suspends the grant (drift)', async () => {
    const c = ctx(['myorg', 'builder', 'full'], { 'yes-i-understand': true });
    const path = makeOrg(c.cwd, 'myorg', {
      name: 'myorg',
      roles: [{ id: 'builder', runtime: 'claude', responsibilities: ['ship it'] }],
    });
    await setAccessAction(c);
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    raw.roles[0].responsibilities = ['ship something else entirely'];
    writeFileSync(path, JSON.stringify(raw, null, 2), 'utf8');
    const def = OrgDefSchema.parse(raw);
    const resolved = resolveRoleAccess(def, def.roles[0]);
    expect(resolved.state).toBe('suspended');
  });

  it('set-access scoped removes access and access_ack', async () => {
    const c = ctx(['myorg', 'builder', 'full'], { 'yes-i-understand': true });
    const path = makeOrg(c.cwd, 'myorg', {
      name: 'myorg',
      roles: [{ id: 'builder', runtime: 'claude' }],
    });
    await setAccessAction(c);
    const c2 = { ...ctx(['myorg', 'builder', 'scoped']), cwd: c.cwd };
    const res = await setAccessAction(c2);
    expect(res.success).toBe(true);
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    expect(raw.roles[0].policy.access).toBeUndefined();
    expect(raw.roles[0].policy.access_ack).toBeUndefined();
  });
});
