/**
 * monomind-dev org wiring that a config edit could silently drop:
 *  - an independent test-author commits failing tests BEFORE the developer
 *    builds, and nobody else may change them (verifier and integrator check);
 *  - review findings become cross-run lessons (org_remember), the roles that
 *    plan/build recall them (org_recall), and FINISH only proposes rule changes.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

interface Role {
  id: string;
  reports_to: string | null;
  adapter_config?: { model?: string };
  policy?: { git?: string };
  responsibilities?: string[];
}
const def = JSON.parse(
  readFileSync(join(repoRoot, '.monomind', 'orgs', 'monomind-dev.json'), 'utf8'),
) as { roles: Role[]; run_config: { max_concurrent_agents?: number } };
const rules = readFileSync(
  join(repoRoot, '.monomind', 'org-skills', 'monomind-dev-rules', 'SKILL.md'),
  'utf8',
);
const role = (id: string): Role => {
  const r = def.roles.find((x) => x.id === id);
  if (!r) throw new Error(`no role ${id}`);
  return r;
};
const text = (id: string): string => (role(id).responsibilities ?? []).join('\n');

describe('monomind-dev org: independent test step', () => {
  it('has a test-author on the latest model that can commit, under dev-lead', () => {
    const ta = role('test-author');
    expect(ta.adapter_config?.model).toBe('claude-sonnet-5');
    expect(ta.policy?.git).toBe('commit');
    expect(ta.reports_to).toBe('dev-lead');
  });

  it('lets every role be live at once', () => {
    expect(def.run_config.max_concurrent_agents).toBeGreaterThanOrEqual(def.roles.length);
  });

  it('orders TESTS after PLAN and before BUILD in the pipeline', () => {
    const pipeline = (role('dev-lead').responsibilities ?? []).find((s) =>
      s.startsWith('PIPELINE per item'),
    );
    expect(pipeline).toBeDefined();
    const plan = pipeline!.indexOf('(1) architect PLAN');
    const tests = pipeline!.indexOf('(2) test-author TESTS');
    const build = pipeline!.indexOf('(3) BUILD');
    expect(plan).toBeGreaterThan(-1);
    expect(tests).toBeGreaterThan(plan);
    expect(build).toBeGreaterThan(tests);
  });

  it('forbids developers to edit the protected tests but lets them add more', () => {
    for (const id of ['developer-1', 'developer-2']) {
      const t = text(id);
      expect(t).toMatch(/Never edit, rename or delete a protected test file/);
      expect(t).toMatch(/You may add further tests in other files/);
      expect(t).not.toMatch(/worktree add -b dev\/<item-id>/);
    }
    expect(text('test-author')).toMatch(/worktree add -b dev\/<item-id>/);
  });

  it('has verifier and integrator enforce TEST INTEGRITY from the rules skill', () => {
    expect(text('verifier')).toMatch(/TEST INTEGRITY/);
    expect(text('integrator')).toMatch(/TEST INTEGRITY[\s\S]*REFUSE/);
    expect(rules).toMatch(/## Independent tests/);
    expect(rules).toContain('`git -C WT diff --name-only T..HEAD -- P` prints nothing');
    expect(rules).toMatch(/line 1 `TESTS: <full SHA of that commit>`/);
  });
});

describe('monomind-dev org: cross-run lessons', () => {
  it('records each finding as one deduplicated org-scoped lesson', () => {
    expect(rules).toMatch(/## Lessons across runs/);
    expect(rules).toMatch(/First\s+`org_recall` with `lesson <area>/);
    expect(rules).toMatch(/`org_remember` with scope `org`\s+and content `lesson: /);
    expect(text('dev-lead')).toMatch(/LESSONS: turn every FAIL, REJECT and REVISE finding/);
  });

  it('has the planning and building roles recall lessons at the start of each task', () => {
    for (const id of ['architect', 'test-author', 'developer-1', 'developer-2']) {
      expect(role(id).responsibilities?.[0]).toMatch(/Lessons across runs/);
      expect(rules).toContain(id);
    }
  });

  it('only proposes permanent rules at FINISH', () => {
    expect(text('dev-lead')).toMatch(/## Lessons[^;]*propose, never apply/);
    expect(rules).toMatch(/Never edit this skill or an org config\s+yourself: the owner decides/);
  });
});
