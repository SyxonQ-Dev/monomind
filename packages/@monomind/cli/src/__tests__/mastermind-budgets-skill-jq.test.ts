/**
 * #537 review B1: the shipped mastermind-budgets skill feeds `org costs --json`
 * into jq. Since rev 28 a role whose runtime reports no cost has
 * `cost_usd: null`, and jq's `null * 10000` is an error — the whole `show` /
 * `alert` output died. These tests run the skill's own jq filters (extracted
 * from SKILL.md, so a later edit is tested as shipped) on a null-cost payload.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SKILL = fileURLToPath(
  new URL('../../.claude/skills/mastermind-budgets/SKILL.md', import.meta.url),
);
const hasJq = spawnSync('jq', ['--version']).status === 0;

/** The single-quoted jq programs passed as `jq -r --argjson spend "$spendJson" … '<prog>' "$orgFile"`. */
function filters(): { show: string; alert: string } {
  const md = readFileSync(SKILL, 'utf8');
  const progs = [
    ...md.matchAll(/jq -r --argjson spend "\$spendJson"[^']*'([\s\S]*?)' "\$orgFile"/g),
  ].map((m) => m[1]);
  expect(progs).toHaveLength(2);
  return { show: progs[0], alert: progs[1] };
}

const org = {
  run_config: { budget_tokens: 1_000_000 },
  roles: [
    { id: 'lead', budget_usd: 5 },
    { id: 'coder', runtime: 'codex', budget_usd: 2 },
    { id: 'hook', kind: 'endpoint' },
  ],
};
const spend = {
  v: 1,
  run: 'r1',
  items: [
    { role: 'lead', tokens: 1000, cost_usd: 4.5, messages: 3 },
    { role: 'coder', tokens: 900_000, cost_usd: null, messages: 2 },
  ],
  totals: { tokens: 901_000, cost_usd: 4.5, cost_complete: false, messages: 5 },
};

function runJq(prog: string, spendJson: unknown, extra: string[] = []): string {
  return execFileSync(
    'jq',
    ['-r', '--argjson', 'spend', JSON.stringify(spendJson), ...extra, prog],
    { input: JSON.stringify(org), encoding: 'utf8' },
  );
}

describe.skipIf(!hasJq)('mastermind-budgets skill jq filters with a null cost', () => {
  it('show: prints "unknown" for a null-cost role and does not error', () => {
    const out = runJq(filters().show, spend, ['--arg', 'only', '']);
    expect(out).toContain('USD:    $4.5 / $5');
    expect(out).toMatch(
      /coder.*\n\s+USD:\s+unknown \/ \$2 \(cost not reported: this cap cannot fire\)/,
    );
    expect(out).toContain('spent 901000 tokens / $4.5');
  });

  it('show: a null org total prints unknown', () => {
    const out = runJq(
      filters().show,
      {
        ...spend,
        items: [spend.items[1]],
        totals: { tokens: 900_000, cost_usd: null, messages: 2 },
      },
      ['--arg', 'only', ''],
    );
    expect(out).toContain('spent 900000 tokens / unknown');
  });

  it('alert: flags by tokens and USD, printing unknown for the null-cost role', () => {
    const out = runJq(filters().alert, spend);
    expect(out).toContain('lead: $4.5 / $5');
    expect(out).toContain('coder: unknown / $2, 900000 / ');
  });
});
