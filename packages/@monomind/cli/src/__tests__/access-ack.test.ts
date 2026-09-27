// #365: access_ack.hash covers exactly the fields access-ack.ts documents,
// is stable across re-serialization, and changes when any of them do.
import { describe, expect, it } from 'vitest';
import { computeAccessAckHash } from '../orgrt/access-ack.js';
import { type OrgDef, OrgDefSchema } from '../orgrt/types.js';

function def(overrides: Record<string, unknown> = {}): OrgDef {
  return OrgDefSchema.parse({
    name: 'o',
    roles: [
      {
        id: 'builder',
        reports_to: null,
        responsibilities: ['ship the thing'],
        runtime: 'claude',
        adapter_config: { model: 'claude-x' },
        policy: { access: 'full' },
      },
    ],
    ...overrides,
  });
}

describe('access-ack: computeAccessAckHash', () => {
  it('is stable for the same logical config re-parsed independently', () => {
    const a = computeAccessAckHash(def(), def().roles[0]);
    const b = computeAccessAckHash(def(), def().roles[0]);
    expect(a).toBe(b);
  });

  it('is unaffected by object key order', () => {
    const d = def();
    const role = d.roles[0];
    const reordered = { ...role, adapter_config: { model: role.adapter_config?.model } };
    const shuffled = Object.fromEntries(Object.entries(reordered).reverse());
    expect(computeAccessAckHash(d, shuffled as typeof role)).toBe(computeAccessAckHash(d, role));
  });

  it('changes when the role prompt/responsibilities change', () => {
    const d = def();
    const role = d.roles[0];
    const edited = { ...role, responsibilities: ['ship something else'] };
    expect(computeAccessAckHash(d, edited)).not.toBe(computeAccessAckHash(d, role));
  });

  it('changes when the model changes', () => {
    const d = def();
    const role = d.roles[0];
    const edited = { ...role, adapter_config: { model: 'claude-y' } };
    expect(computeAccessAckHash(d, edited)).not.toBe(computeAccessAckHash(d, role));
  });

  it('changes when the org-level unattended/taint knobs change', () => {
    const d1 = def();
    const d2 = def({ run_config: { allow_unattended_full_access: true } });
    expect(computeAccessAckHash(d1, d1.roles[0])).not.toBe(
      computeAccessAckHash(d2, { ...d1.roles[0] }),
    );
  });

  it('changes when reports_to changes', () => {
    const d = def({
      roles: [
        { id: 'lead' },
        {
          id: 'builder',
          reports_to: 'lead',
          responsibilities: ['ship the thing'],
          runtime: 'claude',
          policy: { access: 'full' },
        },
      ],
    });
    const role = d.roles.find((r) => r.id === 'builder')!;
    const edited = { ...role, reports_to: null };
    expect(computeAccessAckHash(d, edited)).not.toBe(computeAccessAckHash(d, role));
  });
});
