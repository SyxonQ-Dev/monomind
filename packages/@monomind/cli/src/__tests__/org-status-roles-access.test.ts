// #367: `org status <name> --format json` reports roles_access from the org's
// config whether or not the org has run — a stopped org is when a human
// reviews and grants full access.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { statusAction } from '../commands/org-lifecycle.js';
import type { CommandContext } from '../types.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'org-status-access-'));
  mkdirSync(join(root, '.monomind', 'orgs'), { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

function writeOrg(name: string, roles: unknown[], extra: Record<string, unknown> = {}): void {
  writeFileSync(
    join(root, '.monomind', 'orgs', `${name}.json`),
    JSON.stringify({ name, roles, ...extra }),
  );
}

async function statusJson(name: string): Promise<Record<string, any>> {
  let out = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
    out += String(chunk);
    return true;
  });
  const ctx = { cwd: root, args: [name], flags: { format: 'json' } } as unknown as CommandContext;
  await statusAction(ctx);
  vi.restoreAllMocks();
  return JSON.parse(out.trim());
}

describe('org status --format json: roles_access for an org that never ran (#367)', () => {
  it('lists an unacknowledged full-access role as scoped, suspended, with the reason', async () => {
    writeOrg('growth', [
      { id: 'builder', runtime: 'claude', policy: { access: 'full' } },
      { id: 'lead', runtime: 'claude' },
    ]);
    const st = await statusJson('growth');
    expect(st.status).toBe('never run');
    expect(st.roles_access).toHaveLength(1);
    expect(st.roles_access[0]).toMatchObject({
      role: 'builder',
      access: 'scoped',
      access_state: 'suspended',
    });
    expect(st.roles_access[0].reason).toMatch(/no human acknowledgement/);
  });

  it('omits roles_access for an org with no full-access role', async () => {
    writeOrg('plain', [{ id: 'lead', runtime: 'claude' }]);
    const st = await statusJson('plain');
    expect(st.status).toBe('never run');
    expect('roles_access' in st).toBe(false);
  });
});
