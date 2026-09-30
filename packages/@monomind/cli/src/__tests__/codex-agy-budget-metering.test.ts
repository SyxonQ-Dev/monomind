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
import { orgBudgetedUsage } from '../orgrt/budget-closure.js';
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
    setTimeout(() => child.emit('close', null), 1);
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
  tmp = mkdtempSync(join(tmpdir(), 'budget-550-'));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

/** Run one session of `runner` over `prompts`; returns its bus events. */
async function session(
  runner: AgentRunner,
  policy: PolicyEngine,
  prompts: string[] = ['go'],
): Promise<any[]> {
  const bus = new OrgBus('o', 'run-1', join(tmp, `run-${Math.random()}`));
  const events: any[] = [];
  bus.subscribe((e) => events.push(e));
  const mailbox = new Mailbox();
  for (const p of prompts) mailbox.push(p);
  const wrapped: AgentRunner = {
    run(args) {
      // Ends runAgentSession after this pass; the queue still drains.
      mailbox.close();
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
    const events = await session(new AntigravityAgentRunner('agy'), policy);

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
    const events = await session(new CodexAgentRunner('codex'), policy);

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
    const events = await session(new CodexAgentRunner('codex'), policy);

    expect(cp.spawn).not.toHaveBeenCalled();
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
