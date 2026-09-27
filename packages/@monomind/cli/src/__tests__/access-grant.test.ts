// #365: resolveRoleAccess is the runtime's single source of truth for
// whether a role actually gets full access this session.
import { describe, expect, it } from 'vitest';
import { computeAccessAckHash } from '../orgrt/access-ack.js';
import { isUnattendedRun, resolveRoleAccess } from '../orgrt/access-grant.js';
import { type OrgDef, OrgDefSchema } from '../orgrt/types.js';

function def(overrides: Record<string, unknown> = {}): OrgDef {
  return OrgDefSchema.parse({
    name: 'o',
    roles: [{ id: 'builder', runtime: 'claude', policy: { access: 'full' } }],
    ...overrides,
  });
}

function ackedDef(overrides: Record<string, unknown> = {}): OrgDef {
  const d = def(overrides);
  const role = d.roles[0];
  role.policy = {
    ...role.policy,
    access: 'full',
    access_ack: {
      by: 'human',
      at: '2026-01-01T00:00:00.000Z',
      hash: computeAccessAckHash(d, role),
    },
  };
  return d;
}

describe('resolveRoleAccess', () => {
  it('a role with no policy.access is scoped, no state', () => {
    const d = OrgDefSchema.parse({ name: 'o', roles: [{ id: 'a' }] });
    const r = resolveRoleAccess(d, d.roles[0]);
    expect(r).toEqual({ access: 'scoped', declared: 'scoped' });
  });

  it('declared full with no access_ack runs scoped, suspended', () => {
    const d = def();
    const r = resolveRoleAccess(d, d.roles[0]);
    expect(r.access).toBe('scoped');
    expect(r.declared).toBe('full');
    expect(r.state).toBe('suspended');
  });

  it('declared full on a runtime without full-access support runs scoped, suspended', () => {
    const d = def({ roles: [{ id: 'builder', runtime: 'codex', policy: { access: 'full' } }] });
    const r = resolveRoleAccess(d, d.roles[0]);
    expect(r.access).toBe('scoped');
    expect(r.state).toBe('suspended');
    expect(r.reason).toMatch(/does not support full access/);
  });

  it('a correctly acknowledged grant is active', () => {
    const d = ackedDef();
    const r = resolveRoleAccess(d, d.roles[0]);
    expect(r).toEqual({ access: 'full', declared: 'full', state: 'active' });
  });

  it('an ack not from a human is ignored (suspended)', () => {
    const d = def();
    const role = d.roles[0];
    role.policy = {
      ...role.policy,
      access_ack: { by: 'human', at: 'x', hash: 'not-a-real-hash' } as any,
    };
    const r = resolveRoleAccess(d, role);
    expect(r.access).toBe('scoped');
    expect(r.state).toBe('suspended');
  });

  it('editing the role after the grant (responsibilities) suspends it', () => {
    const d = ackedDef();
    d.roles[0].responsibilities = ['a new, unacknowledged job'];
    const r = resolveRoleAccess(d, d.roles[0]);
    expect(r.access).toBe('scoped');
    expect(r.state).toBe('suspended');
    expect(r.reason).toMatch(/config changed since the access grant/);
  });

  it('editing run_config.allow_unattended_full_access after the grant suspends it', () => {
    const d = ackedDef();
    (d.run_config as Record<string, unknown>).allow_unattended_full_access = true;
    const r = resolveRoleAccess(d, d.roles[0]);
    expect(r.state).toBe('suspended');
  });

  it('an acknowledged grant on an unattended (scheduled) run is blocked without the org opt-in', () => {
    const d = ackedDef({ schedule: '30m' });
    const r = resolveRoleAccess(d, d.roles[0], { unattended: isUnattendedRun(d) });
    expect(r.access).toBe('scoped');
    expect(r.state).toBe('unattended-blocked');
  });

  it('an acknowledged grant on an unattended run IS active once allow_unattended_full_access is set and acknowledged with it in place', () => {
    // ackedDef computes the hash AFTER run_config overrides are applied, so
    // this reproduces "set allow_unattended_full_access, THEN run
    // `org role set-access ... full`" — the required order.
    const d = ackedDef({ schedule: '30m', run_config: { allow_unattended_full_access: true } });
    const r = resolveRoleAccess(d, d.roles[0], { unattended: isUnattendedRun(d) });
    expect(r).toEqual({ access: 'full', declared: 'full', state: 'active' });
  });

  it('isUnattendedRun: false with no schedule, true with one', () => {
    expect(isUnattendedRun(OrgDefSchema.parse({ name: 'o', roles: [{ id: 'a' }] }))).toBe(false);
    expect(
      isUnattendedRun(OrgDefSchema.parse({ name: 'o', roles: [{ id: 'a' }], schedule: '1h' })),
    ).toBe(true);
  });
});
