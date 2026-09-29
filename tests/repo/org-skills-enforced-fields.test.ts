/**
 * GH #400: mastermind-budgets wrote its limits to `.monomind/orgs/<org>-budgets.json`
 * and mastermind-routines its routines to `<org>-routines.json`. The Org Runtime
 * reads neither (only a dashboard route displayed them), so a user who "set a
 * $50 budget" had no cap at all. Both skills now edit only the org definition —
 * the fields the runtime enforces (roles[].budget_usd / budget_tokens,
 * run_config.budget_tokens, schedule) — and every file their shell code writes
 * must be that definition (via its `$tmp` swap file).
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (skill: string): string =>
  readFileSync(join(REPO_ROOT, '.claude/skills', skill, 'SKILL.md'), 'utf8');

/** Contents of the fenced shell blocks — the commands a model actually runs. */
function codeBlocks(md: string): string {
  return [...md.matchAll(/```(?:bash|sh)\n([\s\S]*?)```/g)].map((m) => m[1]).join('\n');
}

/** Files the shell code writes: `>`/`>>` redirect targets and `mv` destinations. */
function writeTargets(code: string): string[] {
  const targets: string[] = [];
  // A redirect is a `>` after whitespace whose target is a variable or a path —
  // not jq's `>=`, an awk `v>0` or a `>80%` inside a string.
  const redirect = /(?:^|\s)>>?\s*("\$[^"]+"|"[./][^"]*"|\$\w+|[./][^\s;|)]+)/gm;
  for (const m of code.matchAll(redirect)) targets.push(m[1]);
  for (const m of code.matchAll(/\bmv\s+("[^"]+"|\S+)\s+("[^"]+"|\S+)/g)) targets.push(m[2]);
  return targets.map((t) => t.replace(/^"|"$/g, '')).filter((t) => t !== '/dev/null');
}

describe('writeTargets', () => {
  it('finds redirects and mv destinations, not stderr redirects', () => {
    const code = [
      'echo x > "$budgetsFile"',
      'jq \'select(.n >= 1) | ">80%"\' a 2>/dev/null > "$tmp" && mv "$tmp" "$orgFile"',
      'awk -v v="$x" \'BEGIN{exit !(v>0)}\' >> .monomind/orgs/x-routines.json',
    ].join('\n');
    expect(writeTargets(code)).toEqual([
      '$budgetsFile',
      '$tmp',
      '.monomind/orgs/x-routines.json',
      '$orgFile',
    ]);
  });
});

describe.each([
  [
    'mastermind-budgets',
    ['budget_usd', 'budget_tokens', 'run_config.budget_tokens', 'org reload', 'org costs'],
  ],
  ['mastermind-routines', ['.schedule = $v', '.schedule = null', 'org serve']],
])('%s skill', (skill, enforcedRefs) => {
  const md = read(skill);
  const code = codeBlocks(md);

  it('writes only the org definition', () => {
    expect(new Set(writeTargets(code))).toEqual(new Set(['$tmp', '$orgFile']));
  });

  it('never writes an unenforced side-car file', () => {
    expect(code).not.toMatch(/-budgets\.json/);
    expect(code).not.toMatch(/(>|\bmv\b[^\n]*)\s*"?[^\s"]*-routines\.json/);
  });

  it('references the fields and commands the runtime enforces', () => {
    for (const ref of enforcedRefs) expect(md).toContain(ref);
  });
});
