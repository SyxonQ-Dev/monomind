import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appendFullAccessAudit, fullAccessAuditLogPath } from '../../src/orgrt/full-access-audit.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('full-access audit log (#360)', () => {
  it('appends one JSON line per turn to the overridable log path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fa-audit-'));
    dirs.push(dir);
    const env = { MONOMIND_FULL_ACCESS_LOG: join(dir, 'logs', 'fa.log') };
    expect(fullAccessAuditLogPath(env)).toBe(env.MONOMIND_FULL_ACCESS_LOG);
    const rec = { ts: '2026-09-28T00:00:00.000Z', cwd: '/w', runtime: 'claude', exitCode: 0, toolCalls: 2 };
    appendFullAccessAudit(rec, env);
    appendFullAccessAudit({ ...rec, org: 'o', role: 'builder', toolCalls: 5 }, env);
    const lines = readFileSync(env.MONOMIND_FULL_ACCESS_LOG, 'utf8').trim().split('\n');
    expect(lines.map((l) => JSON.parse(l))).toEqual([rec, { ...rec, org: 'o', role: 'builder', toolCalls: 5 }]);
  });

  it('never throws when the log cannot be written', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fa-audit-'));
    dirs.push(dir);
    const notADir = join(dir, 'file');
    writeFileSync(notADir, '');
    expect(() =>
      appendFullAccessAudit(
        { ts: 'x', cwd: '/w', runtime: 'claude', exitCode: 1, toolCalls: 0 },
        { MONOMIND_FULL_ACCESS_LOG: join(notADir, 'logs', 'fa.log') },
      ),
    ).not.toThrow();
  });
});
