// #365: org validate taint checks for policy.access: 'full' roles.
import { describe, expect, it } from 'vitest';
import { fullAccessTaintFindings, isUntrustedInputRole } from '../orgrt/access-taint.js';
import { OrgDefSchema } from '../orgrt/types.js';

describe('isUntrustedInputRole', () => {
  it('a role with non-empty webAllow is untrusted-input', () => {
    const def = OrgDefSchema.parse({
      name: 'o',
      roles: [{ id: 'a', policy: { webAllow: ['example.com'] } }],
    });
    expect(isUntrustedInputRole(def.roles[0])).toBe(true);
  });

  it('a role with an empty webAllow is not', () => {
    const def = OrgDefSchema.parse({ name: 'o', roles: [{ id: 'a', policy: { webAllow: [] } }] });
    expect(isUntrustedInputRole(def.roles[0])).toBe(false);
  });

  it('a role with a message/social tool provider is untrusted-input', () => {
    const def = OrgDefSchema.parse({
      name: 'o',
      roles: [
        {
          id: 'a',
          tool_providers: [{ kind: 'mcp-stdio', name: 'monoagent-messages', command: 'x' }],
        },
      ],
    });
    expect(isUntrustedInputRole(def.roles[0])).toBe(true);
  });

  it('an unrelated tool provider is not', () => {
    const def = OrgDefSchema.parse({
      name: 'o',
      roles: [{ id: 'a', tool_providers: [{ kind: 'mcp-stdio', name: 'weather', command: 'x' }] }],
    });
    expect(isUntrustedInputRole(def.roles[0])).toBe(false);
  });
});

describe('fullAccessTaintFindings', () => {
  it('no findings when there is no full-access role', () => {
    const def = OrgDefSchema.parse({
      name: 'o',
      roles: [{ id: 'a', policy: { webAllow: ['*'] } }],
    });
    expect(fullAccessTaintFindings(def)).toEqual({ errors: [], warnings: [] });
  });

  it('direct taint: the full-access role itself is untrusted-input — always an error', () => {
    const def = OrgDefSchema.parse({
      name: 'o',
      roles: [{ id: 'builder', policy: { access: 'full', webAllow: ['*'] } }],
    });
    const findings = fullAccessTaintFindings(def);
    expect(findings.errors).toHaveLength(1);
    expect(findings.errors[0]).toMatch(/itself is an untrusted-input role/);
  });

  it('indirect taint: an untrusted-input role reachable via reports_to is an error unless accepted', () => {
    const def = OrgDefSchema.parse({
      name: 'o',
      roles: [
        { id: 'lead' },
        { id: 'scraper', reports_to: 'lead', policy: { webAllow: ['*'] } },
        { id: 'builder', reports_to: 'lead', policy: { access: 'full' } },
      ],
    });
    const findings = fullAccessTaintFindings(def);
    expect(findings.errors).toHaveLength(1);
    expect(findings.errors[0]).toMatch(/scraper/);
    expect(findings.errors[0]).toMatch(/builder/);
  });

  it('an accepted path (endpoints form) downgrades to a warning', () => {
    const def = OrgDefSchema.parse({
      name: 'o',
      roles: [
        { id: 'lead' },
        { id: 'scraper', reports_to: 'lead', policy: { webAllow: ['*'] } },
        { id: 'builder', reports_to: 'lead', policy: { access: 'full' } },
      ],
      run_config: { accept_full_access_taint: ['scraper→builder'] },
    });
    const findings = fullAccessTaintFindings(def);
    expect(findings.errors).toHaveLength(0);
    expect(findings.warnings).toHaveLength(1);
    expect(findings.warnings[0]).toMatch(/accepted via run_config.accept_full_access_taint/);
  });

  it('an accepted path (full arrow-joined form, ascii arrow) also matches', () => {
    const def = OrgDefSchema.parse({
      name: 'o',
      roles: [
        { id: 'lead' },
        { id: 'scraper', reports_to: 'lead', policy: { webAllow: ['*'] } },
        { id: 'builder', reports_to: 'lead', policy: { access: 'full' } },
      ],
      run_config: { accept_full_access_taint: ['scraper -> lead -> builder'.replace(/->/g, '→')] },
    });
    const findings = fullAccessTaintFindings(def);
    expect(findings.errors).toHaveLength(0);
    expect(findings.warnings).toHaveLength(1);
  });

  it('no reports_to path between an untrusted role and the full-access role: no finding', () => {
    const def = OrgDefSchema.parse({
      name: 'o',
      roles: [
        { id: 'scraper', policy: { webAllow: ['*'] } },
        { id: 'builder', policy: { access: 'full' } },
      ],
    });
    expect(fullAccessTaintFindings(def)).toEqual({ errors: [], warnings: [] });
  });
});
