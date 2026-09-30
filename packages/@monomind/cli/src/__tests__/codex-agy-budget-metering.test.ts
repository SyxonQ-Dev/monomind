/**
 * #550: codex and antigravity roles were metered on the provider's TOTAL
 * input (cache included) and checked only once a whole exec had ended, so
 * one turn spent 7-35x a role's budget_tokens and the org-wide ceiling (the
 * sum of the same numbers) closed every other role.
 *
 * The runners now split cached input out (runner-usage.ts), report each
 * step/exec as it completes, stop an agy exec at the step that exhausts the
 * budget, and refuse to start an exec below a small floor.
 */
import * as cp from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage, AgentRunner } from '../orgrt/agent-runner.js';
import { AntigravityAgentRunner } from '../orgrt/antigravity-runner.js';
import {
  exhaustedDetail,
  orgBudgetedUsage,
  reopenBudgetClosedRoles,
} from '../orgrt/budget-closure.js';
import { OrgBus } from '../orgrt/bus.js';
import { CodexAgentRunner } from '../orgrt/codex-runner.js';
import type { RunningOrg } from '../orgrt/daemon.js';
import { Mailbox } from '../orgrt/mailbox.js';
import { PolicyEngine } from '../orgrt/policy.js';
import {
  BUDGET_STOP_SUBTYPE,
  budgetExhausted,
  budgetRefusal,
  splitCachedInput,
  stepMeter,
  usageBeyond,
} from '../orgrt/runner-usage.js';
import { runAgentSession } from '../orgrt/session.js';
import type { OrgRole } from '../orgrt/types.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

/** A fake CLI process emitting `lines` on stdout. `hold` keeps stdout open
 *  after the lines until the child is killed (a turn still running). */
function mockChild(lines: string[], opts: { hold?: boolean } = {}): cp.ChildProcess {
  const child = new EventEmitter() as any;
  let release: () => void = () => {};
  const killed = new Promise<void>((r) => {
    release = r;
  });
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.stdout = new EventEmitter();
  child.stdout[Symbol.asyncIterator] = async function* () {
    for (const line of lines) yield Buffer.from(`${line}\n`);
    if (opts.hold) await killed;
  };
  child.stderr = new EventEmitter();
  child.stdin = { on: vi.fn(), end: vi.fn(), write: vi.fn() };
  child.kill = vi.fn(() => {
    child.killed = true;
    child.signalCode = 'SIGTERM';
    release();
    // A finished child's normal close comes from the timer below.
    if (opts.hold) setTimeout(() => child.emit('close', null), 1);
    return true;
  });
  if (!opts.hold)
    setTimeout(() => {
      child.exitCode = 0;
      child.emit('close', 0);
    }, 5);
  return child as cp.ChildProcess;
}

const codexTurn = (text: string, usage: object): string[] => [
  JSON.stringify({ type: 'thread.started', thread_id: 't1' }),
  JSON.stringify({ type: 'item.completed', item: { id: 'i0', type: 'agent_message', text } }),
  JSON.stringify({ type: 'turn.completed', usage }),
];

const agyResult = (usage: object): string =>
  JSON.stringify({ event: 'result', result: { conversation_id: 'c1', status: 'SUCCESS', usage } });

const agyStep = (index: number, state: string, text: string, usage?: object): string =>
  JSON.stringify({
    event: 'step_update',
    step_update: {
      conversation_id: 'c1',
      step_index: index,
      step_type: 'agent_response',
      state,
      text_delta: text,
      ...(usage ? { usage } : {}),
    },
  });

const ROLE = { id: 'designer', title: 'D', type: 'specialist', reports_to: 'boss' } as OrgRole;

let tmp: string;
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(cp.spawn).mockReset(); // drop unused mockReturnValueOnce children
  tmp = mkdtempSync(join(tmpdir(), 'budget-550-'));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

/** Run one session of `runner` over `prompts`; returns its bus events. */
async function session(
  runner: AgentRunner,
  policy: PolicyEngine,
  mailbox = new Mailbox(),
  closeFirst = true,
): Promise<any[]> {
  const bus = new OrgBus('o', 'run-1', join(tmp, `run-${Math.random()}`));
  const events: any[] = [];
  bus.subscribe((e) => events.push(e));
  mailbox.push('go');
  const wrapped: AgentRunner = {
    budgetFloorGated: runner.budgetFloorGated,
    run(args) {
      // Ends runAgentSession after this pass; the queue still drains. A
      // budget test leaves it open: the budget close must end the session.
      if (closeFirst) mailbox.close();
      return runner.run(args);
    },
  };
  await runAgentSession({
    org: 'o',
    role: ROLE,
    bus,
    policy,
    mailbox,
    cwd: tmp,
    deliver: async () => 'ok',
    runner: wrapped,
    maxTurns: 5,
  });
  return events;
}

const newPolicy = (maxTokens?: number): PolicyEngine =>
  new PolicyEngine('designer', { maxTokens } as any, { emit: () => {} } as any, tmp);

describe('splitCachedInput / stepMeter', () => {
  it('moves the cached part of a total input count out of input_tokens', () => {
    // Live codex turn.completed.usage.
    expect(splitCachedInput({ input: 13085, output: 5, cached: 9984, cacheWrite: 0 })).toEqual({
      input: 3101,
      output: 5,
      cacheRead: 9984,
      cacheCreation: 0,
    });
  });

  it('clamps cache counts to the total so the total never changes', () => {
    // Live agy: cache_read_tokens 8141 against input_tokens 8132.
    expect(splitCachedInput({ input: 8132, output: 35, cached: 8141 })).toEqual({
      input: 0,
      output: 35,
      cacheRead: 8132,
      cacheCreation: 0,
    });
    expect(splitCachedInput({ input: 100, cached: 60, cacheWrite: 70 })).toEqual({
      input: 0,
      output: 0,
      cacheRead: 60,
      cacheCreation: 40,
    });
  });

  it('counts a step reported twice (ACTIVE, then DONE) once', () => {
    const meter = stepMeter();
    expect(meter(1, { input: 100, output: 1, cached: 40 })).toEqual({
      input: 60,
      output: 1,
      cacheRead: 40,
      cacheCreation: 0,
    });
    expect(meter(1, { input: 100, output: 1, cached: 40 })).toBeUndefined();
    expect(meter(1, { input: 150, output: 3, cached: 40 })?.input).toBe(50);
    expect(meter(2, { input: 10 })?.input).toBe(10);
  });

  it('does not double-count input that two reports split differently into cache', () => {
    // Same 1000 input tokens: steps said 900 cached, the result 800.
    const steps = splitCachedInput({ input: 1000, cached: 900 });
    const result = splitCachedInput({ input: 1000, output: 5, cached: 800 });
    expect(usageBeyond(result, steps)).toEqual({
      input: 0,
      output: 5,
      cacheRead: 0,
      cacheCreation: 0,
    });
    // Real growth still splits into uncached and cache.
    expect(usageBeyond(splitCachedInput({ input: 1500, cached: 1200 }), steps)).toEqual({
      input: 200,
      output: 0,
      cacheRead: 300,
      cacheCreation: 0,
    });
  });
});

describe('budgetRefusal / budgetExhausted', () => {
  it('lets a turn start with no budget or enough of it left', () => {
    expect(budgetRefusal({})).toBeUndefined();
    expect(budgetRefusal({ tokenBudget: () => undefined })).toBeUndefined();
    expect(budgetRefusal({ tokenBudget: () => ({ left: 5000, max: 100_000 }) })).toBeUndefined();
  });

  it('refuses at 0 left and below the 5% floor', () => {
    expect(budgetRefusal({ tokenBudget: () => ({ left: 0 }) })).toMatch(/exhausted/);
    expect(budgetRefusal({ tokenBudget: () => ({ left: 4999, max: 100_000 }) })).toMatch(
      /below the 5% floor/,
    );
    expect(budgetExhausted({ tokenBudget: () => ({ left: 4999, max: 100_000 }) })).toBe(false);
    expect(budgetExhausted({ tokenBudget: () => ({ left: 0 }) })).toBe(true);
  });
});

// The issue's codex turn: 4,565,211 input, 65,318 output — here with the
// 4,500,000 cached tokens a cached run reports.
const CODEX_USAGE = {
  input_tokens: 4_565_211,
  cached_input_tokens: 4_500_000,
  cache_write_input_tokens: 0,
  output_tokens: 65_318,
};
const UNCACHED_BUDGETED = 65_211 + 65_318;

describe('usage events and budgetedUsage parity across runtimes', () => {
  it('codex: usage event carries uncached tokens_in and the cache as cache_read', async () => {
    vi.mocked(cp.spawn).mockReturnValue(mockChild(codexTurn('done', CODEX_USAGE)));
    const policy = newPolicy();
    const events = await session(new CodexAgentRunner('codex'), policy);
    const usage = events.filter((e) => e.type === 'usage');
    expect(usage).toHaveLength(1);
    expect(usage[0].data).toMatchObject({
      tokens: 4_630_529,
      tokens_in: 65_211,
      tokens_out: 65_318,
      cache_read: 4_500_000,
      cache_creation: 0,
    });
    expect(policy.budgetedUsage).toBe(UNCACHED_BUDGETED);
    expect(policy.usage).toBe(4_630_529);
  });

  it('antigravity: steps and the result top-up add up to the result, cache split out', async () => {
    vi.mocked(cp.spawn).mockReturnValue(
      mockChild([
        agyStep(1, 'DONE', 'half', {
          input_tokens: 3_000_000,
          output_tokens: 40_000,
          cache_read_tokens: 2_950_000,
        }),
        agyStep(2, 'DONE', 'done', {
          input_tokens: 1_565_211,
          output_tokens: 25_318,
          cache_read_tokens: 1_550_000,
        }),
        agyResult({ input_tokens: 4_565_211, output_tokens: 65_318, cache_read_tokens: 4_500_000 }),
      ]),
    );
    const policy = newPolicy();
    const events = await session(new AntigravityAgentRunner('agy'), policy);
    const usage = events.filter((e) => e.type === 'usage');
    expect(usage).toHaveLength(1);
    expect(usage[0].data).toMatchObject({
      tokens: 4_630_529,
      tokens_in: 65_211,
      tokens_out: 65_318,
      cache_read: 4_500_000,
    });
    expect(policy.budgetedUsage).toBe(UNCACHED_BUDGETED);
  });

  it('meters codex, antigravity and claude-shaped usage of the same turn identically', async () => {
    vi.mocked(cp.spawn).mockReturnValueOnce(mockChild(codexTurn('done', CODEX_USAGE)));
    const codex = newPolicy();
    await session(new CodexAgentRunner('codex'), codex);

    vi.mocked(cp.spawn).mockReturnValueOnce(
      mockChild([
        agyStep(1, 'DONE', 'done'),
        agyResult({ input_tokens: 4_565_211, output_tokens: 65_318, cache_read_tokens: 4_500_000 }),
      ]),
    );
    const agy = newPolicy();
    await session(new AntigravityAgentRunner('agy'), agy);

    // Claude/Anthropic convention: input_tokens is already the uncached part.
    const claude = newPolicy();
    const claudeShaped: AgentRunner = {
      async *run(args): AsyncIterable<AgentMessage> {
        for await (const _ of args.prompt) {
          yield {
            type: 'result',
            subtype: 'success',
            input_tokens: 65_211,
            output_tokens: 65_318,
            cache_read_input_tokens: 4_500_000,
          };
        }
      },
    };
    await session(claudeShaped, claude);

    expect(codex.tokenUsage).toEqual(claude.tokenUsage);
    expect(agy.tokenUsage).toEqual(claude.tokenUsage);
    expect(codex.budgetedUsage).toBe(UNCACHED_BUDGETED);
  });

  it("does not let one role's cache blow the org-wide run_config.budget_tokens", async () => {
    // Issue run xrv1: codex 9.7M and agy 5.3M against a 3M org ceiling.
    vi.mocked(cp.spawn).mockReturnValueOnce(
      mockChild(
        codexTurn('done', {
          input_tokens: 9_600_000,
          cached_input_tokens: 9_400_000,
          output_tokens: 139_036,
        }),
      ),
    );
    const codex = newPolicy();
    await session(new CodexAgentRunner('codex'), codex);
    vi.mocked(cp.spawn).mockReturnValueOnce(
      mockChild([
        agyStep(1, 'DONE', 'done'),
        agyResult({
          input_tokens: 4_750_000,
          output_tokens: 512_994,
          cache_read_tokens: 4_600_000,
        }),
      ]),
    );
    const agy = newPolicy();
    await session(new AntigravityAgentRunner('agy'), agy);

    const running = {
      agents: new Map([
        ['designer-codex', { policy: codex }],
        ['designer-agy', { policy: agy }],
      ]),
      roleSlots: new Map(),
    } as unknown as RunningOrg;
    const used = orgBudgetedUsage(running);
    expect(used).toBe(200_000 + 139_036 + 150_000 + 512_994);
    expect(used).toBeLessThan(3_000_000);
    // What the org ceiling saw before: every input token as uncached.
    expect(9_600_000 + 139_036 + 4_750_000 + 512_994).toBeGreaterThan(3_000_000);
  });
});

describe('stopping overspend within a turn', () => {
  it('antigravity: kills the exec at the step that exhausts the budget', async () => {
    const child = mockChild(
      [
        agyStep(1, 'DONE', 'first', {
          input_tokens: 30_000,
          output_tokens: 500,
          cache_read_tokens: 10_000,
        }),
        agyStep(2, 'DONE', 'second', { input_tokens: 90_000, output_tokens: 900 }),
      ],
      { hold: true },
    );
    vi.mocked(cp.spawn).mockReturnValue(child);
    const policy = newPolicy(10_000);
    const mailbox = new Mailbox();
    const events = await session(new AntigravityAgentRunner('agy'), policy, mailbox, false);
    expect(mailbox.closeReason).toBe('token-budget');

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    const chat = events.filter((e) => e.type === 'chat').map((e) => e.msg);
    expect(chat).toContain('first');
    expect(chat).not.toContain('second');
    expect(policy.budgetedUsage).toBe(20_500); // step 1 only, cache split out
    const usage = events.filter((e) => e.type === 'usage');
    expect(usage.map((e) => e.data.subtype)).toEqual([BUDGET_STOP_SUBTYPE]);
    expect(events.some((e) => e.reason === 'budget-exhausted')).toBe(true);
    expect(events.some((e) => e.reason === 'session-result-error')).toBe(false);
  });

  it('codex: does not start another exec round once the budget is spent', async () => {
    const fence = 'calling\n\n```tool_call\n{"name": "org_send", "arguments": {"to": "boss"}}\n```';
    vi.mocked(cp.spawn)
      .mockReturnValueOnce(mockChild(codexTurn(fence, { input_tokens: 20_000, output_tokens: 10 })))
      .mockReturnValueOnce(mockChild(codexTurn('second', { input_tokens: 1, output_tokens: 1 })));
    const policy = newPolicy(10_000);
    const mailbox = new Mailbox();
    const events = await session(new CodexAgentRunner('codex'), policy, mailbox, false);

    expect(mailbox.closeReason).toBe('token-budget');
    expect(cp.spawn).toHaveBeenCalledTimes(1);
    expect(policy.budgetedUsage).toBe(20_010);
    expect(events.filter((e) => e.type === 'usage').map((e) => e.data.subtype)).toEqual([
      BUDGET_STOP_SUBTYPE,
    ]);
    expect(events.some((e) => e.reason === 'budget-exhausted')).toBe(true);
  });

  it('codex: refuses to start an exec below the 5% floor and closes the role', async () => {
    const policy = newPolicy(100_000);
    policy.setTokenUsage({ input: 96_000, output: 0, cacheRead: 0, cacheCreation: 0 });
    const mailbox = new Mailbox();
    const events = await session(new CodexAgentRunner('codex'), policy, mailbox, false);

    expect(cp.spawn).not.toHaveBeenCalled();
    expect(mailbox.closeReason).toBe('token-budget');
    // Not over its cap, but out of budget for this runtime (budget-closure.ts).
    expect(policy.overBudget).toBe(false);
    expect(exhaustedDetail(policy)).toBe(
      'budget_tokens exhausted (96000 / 100000: 4000 left, under the 5000 a codex/antigravity turn needs)',
    );
    expect(policy.budgetedUsage).toBe(96_000);
    const chat = events.filter((e) => e.type === 'chat').map((e) => e.msg);
    expect(chat.join('\n')).toMatch(/below the 5% floor/);
    expect(events.some((e) => e.reason === 'budget-exhausted')).toBe(true);
    expect(events.some((e) => e.reason === 'session-result-error')).toBe(false);
  });

  it('antigravity: starts no exec for a role already closed for budget', async () => {
    const args = {
      tools: [],
      prompt: (async function* () {
        yield 'go';
      })(),
      systemPrompt: '',
      cwd: tmp,
      env: {},
      maxTurns: 5,
      tokenBudget: () => ({ left: 0 }),
    };
    const out: AgentMessage[] = [];
    for await (const m of new AntigravityAgentRunner('agy').run(args)) out.push(m);
    expect(cp.spawn).not.toHaveBeenCalled();
    expect(out.at(-1)).toMatchObject({ type: 'result', subtype: BUDGET_STOP_SUBTYPE });
  });
});

// Captured live from agy 1.2.14 (#550 review): one exec, four model calls
// with three view_file tool steps between them (text/tool fields trimmed).
// result.usage is the exact sum of the steps' usage, so a step's usage is its
// own model call, not a running total.
const LIVE_AGY_MULTI_STEP = [
  agyStep(1, 'DONE', 'reading a', {
    input_tokens: 12374,
    output_tokens: 285,
    thinking_tokens: 224,
    cache_read_tokens: 0,
    total_tokens: 12659,
  }),
  agyStep(3, 'DONE', 'reading b', {
    input_tokens: 12859,
    output_tokens: 125,
    thinking_tokens: 64,
    cache_read_tokens: 0,
    total_tokens: 12984,
  }),
  agyStep(5, 'DONE', 'reading c', {
    input_tokens: 13184,
    output_tokens: 113,
    thinking_tokens: 52,
    cache_read_tokens: 0,
    total_tokens: 13297,
  }),
  agyStep(7, 'ACTIVE', ''),
  agyStep(7, 'DONE', 'alpha-beta-gamma', {
    input_tokens: 13497,
    output_tokens: 492,
    thinking_tokens: 487,
    cache_read_tokens: 0,
    total_tokens: 13989,
  }),
  agyResult({
    input_tokens: 51914,
    output_tokens: 1015,
    thinking_tokens: 827,
    cache_read_tokens: 0,
    total_tokens: 52929,
  }),
];

describe('antigravity per-step usage semantics', () => {
  it('meters a live multi-step exec at exactly its result.usage', async () => {
    vi.mocked(cp.spawn).mockReturnValue(mockChild(LIVE_AGY_MULTI_STEP));
    const policy = newPolicy();
    const events = await session(new AntigravityAgentRunner('agy'), policy);
    expect(policy.tokenUsage).toEqual({
      input: 51914,
      output: 1015,
      cacheRead: 0,
      cacheCreation: 0,
    });
    const usage = events.filter((e) => e.type === 'usage');
    expect(usage.map((e) => [e.data.tokens_in, e.data.tokens_out])).toEqual([[51914, 1015]]);
  });

  it('counts a step reported ACTIVE and then DONE once', async () => {
    const u = { input_tokens: 1000, output_tokens: 10, cache_read_tokens: 400 };
    vi.mocked(cp.spawn).mockReturnValue(
      mockChild([
        agyStep(1, 'ACTIVE', 'par', u),
        agyStep(1, 'DONE', 'partial', u),
        agyResult({ input_tokens: 1000, output_tokens: 10, cache_read_tokens: 400 }),
      ]),
    );
    const out: AgentMessage[] = [];
    const run = new AntigravityAgentRunner('agy').run({
      tools: [],
      prompt: (async function* () {
        yield 'go';
      })(),
      systemPrompt: '',
      cwd: tmp,
      env: {},
      maxTurns: 5,
    });
    for await (const m of run) out.push(m);
    const metered = out.filter((m) => m.type === 'assistant' && m.text === undefined);
    expect(metered).toHaveLength(1);
    expect(metered[0]).toMatchObject({ input_tokens: 600, cache_read_input_tokens: 400 });
    expect(out.at(-1)).toMatchObject({
      type: 'result',
      input_tokens: 600,
      output_tokens: 10,
      cache_read_input_tokens: 400,
    });
  });
});

describe('a role closed by the budget floor (#550)', () => {
  const floorClosed = (gated: boolean): { policy: PolicyEngine; mailbox: Mailbox } => {
    const policy = newPolicy(100_000);
    policy.budgetFloorGated = gated;
    policy.setTokenUsage({ input: 96_000, output: 0, cacheRead: 0, cacheCreation: 0 });
    const mailbox = new Mailbox();
    mailbox.close('token-budget');
    return { policy, mailbox };
  };

  it('counts as exhausted only on a floor-gated runtime, and not once raised', () => {
    expect(exhaustedDetail(floorClosed(false).policy)).toBeUndefined();
    const { policy } = floorClosed(true);
    expect(exhaustedDetail(policy)).toMatch(/96000 \/ 100000: 4000 left/);
    policy.setBudgetCaps({ maxTokens: 200_000 });
    expect(exhaustedDetail(policy)).toBeUndefined();
  });

  it('is not reopened by a reload that leaves it under the floor', () => {
    const { policy, mailbox } = floorClosed(true);
    const spawnRole = vi.fn();
    const emitted: any[] = [];
    const running = {
      def: { roles: [ROLE], run_config: {} },
      agents: new Map([[ROLE.id, { policy, mailbox }]]),
      roleSlots: new Map(),
      budgetClosed: new Set([ROLE.id]),
      spawnRole,
      bus: { emit: (e: unknown) => emitted.push(e) },
    } as unknown as RunningOrg;
    expect(reopenBudgetClosedRoles({} as never, 'o', running)).toEqual([]);
    expect(spawnRole).not.toHaveBeenCalled();
    expect(running.budgetClosed?.has(ROLE.id)).toBe(true);
    expect(emitted.some((e) => e.reason === 'role-budget-reopened')).toBe(false);
  });
});
