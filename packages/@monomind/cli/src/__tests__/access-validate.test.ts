// #365: `org validate` schema/runtime findings for policy.access: 'full'.
import { describe, expect, it } from 'vitest';
import { accessValidationFindings } from '../orgrt/access-validate.js';
import { OrgDefSchema } from '../orgrt/types.js';

describe('accessValidationFindings', () => {
  it('no findings for an ordinary scoped role', () => {
    const def = OrgDefSchema.parse({ name: 'o', roles: [{ id: 'a' }] });
    expect(accessValidationFindings(def)).toEqual({ errors: [], warnings: [] });
  });

  it('errors when the resolved runtime does not support full access', () => {
    const def = OrgDefSchema.parse({
      name: 'o',
      roles: [{ id: 'a', runtime: 'hermes', policy: { access: 'full' } }],
    });
    const { errors } = accessValidationFindings(def);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/not supported by runtime "hermes"/);
  });

  it('errors when policy.git is explicitly authored below push alongside access: full', () => {
    const raw = { name: 'o', roles: [{ id: 'a', policy: { access: 'full', git: 'read' } }] };
    const def = OrgDefSchema.parse(raw);
    const { errors } = accessValidationFindings(def, raw.roles);
    expect(errors.some((e) => /implies policy.git 'push'/.test(e))).toBe(true);
  });

  it('does NOT error when policy.git is simply left unset (schema default fills it in)', () => {
    const raw = { name: 'o', roles: [{ id: 'a', policy: { access: 'full' } }] };
    const def = OrgDefSchema.parse(raw);
    const { errors } = accessValidationFindings(def, raw.roles);
    expect(errors.some((e) => /policy.git/.test(e))).toBe(false);
  });

  it('skips the git check entirely when rawRoles is omitted', () => {
    const def = OrgDefSchema.parse({
      name: 'o',
      roles: [{ id: 'a', policy: { access: 'full', git: 'read' } }],
    });
    const { errors } = accessValidationFindings(def);
    expect(errors.some((e) => /policy.git/.test(e))).toBe(false);
  });

  it('warns when scoped-only fields are set alongside access: full', () => {
    const raw = {
      name: 'o',
      roles: [
        { id: 'a', policy: { access: 'full', fileWrite: ['src/**'], webAllow: ['example.com'] } },
      ],
    };
    const def = OrgDefSchema.parse(raw);
    const { warnings } = accessValidationFindings(def, raw.roles);
    expect(warnings.some((w) => /policy.fileWrite/.test(w) && /policy.webAllow/.test(w))).toBe(
      true,
    );
  });

  it('warns (not errors) that an unacknowledged full-access role runs scoped', () => {
    const def = OrgDefSchema.parse({
      name: 'o',
      roles: [{ id: 'a', policy: { access: 'full' } }],
    });
    const { errors, warnings } = accessValidationFindings(def);
    expect(errors).toHaveLength(0);
    expect(warnings.some((w) => /no human acknowledgement/.test(w))).toBe(true);
  });
});
