/**
 * Rev 28 (capability `agent-exec-cost-null`): a runtime that reports no cost
 * has an UNKNOWN cost — `null` — never a $0 spend. Covers the usage tracker,
 * the org bus `usage` event, run summaries and the runners that used to
 * report a fake 0.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runEndLine } from '../commands/org-run-end.js';
import { UsageTracker } from '../orgrt/agent-exec-bridge.js';
import { OrgBus } from '../orgrt/bus.js';
import { summarizeRun } from '../orgrt/reporting.js';
import { emitUsage } from '../orgrt/session-usage.js';
import type { BusEvent } from '../orgrt/types.js';

const usage = (from: string, data: Record<string, unknown>, ts = 1): BusEvent =>
  ({ id: `${from}-${ts}`, ts, org: 'o', run: 'r', type: 'usage', from, data }) as BusEvent;

describe('UsageTracker', () => {
  it('a missing cost is null, not 0', () => {
    const t = new UsageTracker();
    expect(t.delta({ type: 'result', input_tokens: 4 })).toEqual({ in: 4, out: 0, usd: null });
  });

  it('keeps the last known cumulative cost across an unknown round', () => {
    const t = new UsageTracker();
    expect(t.delta({ type: 'result', session_id: 's', cost_usd: 1 }).usd).toBe(1);
    expect(t.delta({ type: 'result', session_id: 's' }).usd).toBeNull();
    expect(t.delta({ type: 'result', session_id: 's', cost_usd: 1.5 }).usd).toBe(0.5);
  });

  it('a non-finite cost is unknown', () => {
    const t = new UsageTracker();
    expect(t.delta({ type: 'result', cost_usd: Number.NaN }).usd).toBeNull();
  });
});

describe('org usage events', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('emitUsage writes cost_usd: null when the runtime reported no cost', () => {
    dir = mkdtempSync(join(tmpdir(), 'mm-cost-null-'));
    const bus = new OrgBus('o', 'r', dir);
    const seen: BusEvent[] = [];
    bus.subscribe((e) => seen.push(e));
    const t = { input: 3, output: 1, cacheRead: 0, cacheCreation: 0 };
    emitUsage(bus, 'dev', t, undefined, 'success');
    emitUsage(bus, 'dev', t, 0.25, 'success');
    expect((seen[0].data as { cost_usd: unknown }).cost_usd).toBeNull();
    expect((seen[1].data as { cost_usd: unknown }).cost_usd).toBe(0.25);
  });
});

describe('summarizeRun', () => {
  it('a role whose usage never carried a cost has costUsd null, and so does the total', () => {
    const s = summarizeRun([
      usage('dev', { tokens: 10, cost_usd: null }, 1),
      usage('dev', { tokens: 5 }, 2),
    ]);
    expect(s.roles.dev.tokens).toBe(15);
    expect(s.roles.dev.costUsd).toBeNull();
    expect(s.totalCostUsd).toBeNull();
  });

  it('sums the reported costs and ignores unknown ones', () => {
    const s = summarizeRun([
      usage('dev', { tokens: 10, cost_usd: 0.5 }, 1),
      usage('dev', { tokens: 5, cost_usd: null }, 2),
      usage('qa', { tokens: 5 }, 3),
    ]);
    expect(s.roles.dev.costUsd).toBe(0.5);
    expect(s.roles.qa.costUsd).toBeNull();
    expect(s.totalCostUsd).toBe(0.5);
  });

  it('a reported $0 stays a known 0', () => {
    const s = summarizeRun([usage('dev', { tokens: 1, cost_usd: 0 }, 1)]);
    expect(s.roles.dev.costUsd).toBe(0);
    expect(s.totalCostUsd).toBe(0);
  });

  it('the run-end line says unknown instead of $0.00', () => {
    const line = runEndLine({
      name: 'o',
      run: 'r',
      wallMs: 1000,
      final: { status: 'stopped' },
      events: [usage('dev', { tokens: 3 }, 1)],
    });
    expect(line).toContain('cost unknown');
    expect(line).not.toContain('$0.00');
  });
});

describe('runners that report no cost do not claim $0', () => {
  for (const file of ['vercel-runner.ts', 'hermes-runner.ts']) {
    it(`${file} yields no cost_usd`, () => {
      const src = readFileSync(fileURLToPath(new URL(`../orgrt/${file}`, import.meta.url)), 'utf8');
      expect(src).not.toMatch(/^\s*cost_usd:\s*0,/m);
    });
  }
});
