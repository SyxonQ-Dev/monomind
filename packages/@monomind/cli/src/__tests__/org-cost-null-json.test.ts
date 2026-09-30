/**
 * #537 review: an unknown cost (`cost_usd: null`, rev 28) must reach
 * `org report --json` and `org costs --json` as null — with `cost_complete:
 * false` when the total is only a lower bound — and the dashboard's usage
 * accumulators must keep it null instead of turning it into $0.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { costsAction, reportAction } from '../commands/org-observe.js';
import type { CommandContext, ParsedFlags } from '../types.js';
import { _accumulateAgentUsage } from '../ui/server-mastermind-usage.mjs';

const ORG = 'acme';
const RUN = 'run-20260930090000-cafe';
let root: string;
let out: string[];

const ctx = (flags: Record<string, unknown> = {}): CommandContext => ({
  args: [],
  flags: { ...flags } as ParsedFlags,
  cwd: root,
  interactive: false,
});

function writeRun(usage: Array<{ from: string; data: Record<string, unknown> }>): void {
  const dir = join(root, '.monomind', 'orgs', ORG, RUN);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(root, '.monomind', 'orgs', `${ORG}.json`),
    JSON.stringify({
      name: ORG,
      goal: 'g',
      roles: [
        { id: 'lead', type: 'boss', reports_to: null },
        { id: 'coder', type: 'specialist', reports_to: 'lead' },
      ],
    }),
  );
  writeFileSync(
    join(root, '.monomind', 'orgs', ORG, 'runtime.json'),
    JSON.stringify({ status: 'stopped', run: RUN }),
  );
  const events = usage.map((u, i) => ({
    id: `${RUN}-${i}`,
    ts: Date.parse('2026-09-30T09:00:00Z') + i,
    org: ORG,
    run: RUN,
    type: 'usage',
    ...u,
  }));
  writeFileSync(join(dir, 'bus.jsonl'), `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
}

const json = () =>
  out
    .join('')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .at(-1);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'org-cost-null-537-'));
  out = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(((c: string | Uint8Array) => {
    out.push(String(c));
    return true;
  }) as typeof process.stdout.write);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('org report / org costs --json with unknown cost', () => {
  it('every cost unknown: totals null, cost_complete false', async () => {
    writeRun([
      { from: 'lead', data: { tokens: 10, cost_usd: null } },
      { from: 'coder', data: { tokens: 5 } },
    ]);
    await reportAction(ctx({ format: 'json' }), ORG);
    expect(json()).toMatchObject({ total_cost_usd: null, cost_complete: false, total_tokens: 15 });

    out = [];
    await costsAction(ctx({ format: 'json' }), ORG);
    const c = json();
    expect(c.totals).toMatchObject({ tokens: 15, cost_usd: null, cost_complete: false });
    expect(c.items.map((i: { cost_usd: unknown }) => i.cost_usd)).toEqual([null, null]);
  });

  it('some cost unknown: the total is a lower bound, cost_complete false', async () => {
    writeRun([
      { from: 'lead', data: { tokens: 10, cost_usd: 0.4 } },
      { from: 'coder', data: { tokens: 5, cost_usd: null } },
    ]);
    await reportAction(ctx({ format: 'json' }), ORG);
    expect(json()).toMatchObject({ total_cost_usd: 0.4, cost_complete: false });
    out = [];
    await costsAction(ctx({ format: 'json' }), ORG);
    expect(json().totals).toMatchObject({ cost_usd: 0.4, cost_complete: false });
  });

  it('every cost reported: cost_complete true', async () => {
    writeRun([
      { from: 'lead', data: { tokens: 10, cost_usd: 0.4 } },
      { from: 'coder', data: { tokens: 5, cost_usd: 0 } },
    ]);
    await reportAction(ctx({ format: 'json' }), ORG);
    expect(json()).toMatchObject({ total_cost_usd: 0.4, cost_complete: true });
    out = [];
    await costsAction(ctx({ format: 'json' }), ORG);
    expect(json().totals).toMatchObject({ cost_usd: 0.4, cost_complete: true });
  });
});

describe('org costs --json from live runtime metrics only (#540)', () => {
  it('a live $0 stays 0; a live null stays unknown', async () => {
    writeRun([]);
    writeFileSync(
      join(root, '.monomind', 'orgs', ORG, 'runtime.json'),
      JSON.stringify({
        status: 'running',
        run: RUN,
        roleMetrics: {
          lead: { tokens: 10, costUsd: 0 },
          coder: { tokens: 5, costUsd: null },
        },
      }),
    );
    await costsAction(ctx({ format: 'json' }), ORG);
    const c = json();
    const byRole = Object.fromEntries(
      c.items.map((i: { role: string; cost_usd: unknown }) => [i.role, i.cost_usd]),
    );
    expect(byRole).toEqual({ lead: 0, coder: null });
    expect(c.totals).toMatchObject({ tokens: 15, cost_usd: 0, cost_complete: false });
  });
});

describe('dashboard state.json usage accumulation', () => {
  const state = () =>
    JSON.parse(readFileSync(join(root, '.monomind', 'orgs', `${ORG}-state.json`), 'utf8'));

  it('a null cost stays null; a later real cost is summed', () => {
    mkdirSync(join(root, '.monomind', 'orgs'), { recursive: true });
    _accumulateAgentUsage(
      { type: 'org:usage', from: 'coder', ts: 1, data: { tokens: 3, cost_usd: null } },
      root,
      ORG,
    );
    expect(state().agents.coder.total_cost_usd).toBeNull();
    _accumulateAgentUsage(
      { type: 'org:usage', from: 'coder', ts: 2, data: { tokens: 3, cost_usd: 0.2 } },
      root,
      ORG,
    );
    expect(state().agents.coder.total_cost_usd).toBe(0.2);
    _accumulateAgentUsage({ type: 'agent:usage', role: 'coder', ts: 3, tokens_in: 1 }, root, ORG);
    expect(state().agents.coder.total_cost_usd).toBe(0.2);
  });
});
