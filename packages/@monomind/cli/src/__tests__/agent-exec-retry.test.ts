/**
 * Rate-limit retry in `agent exec` (orgrt/agent-exec-retry.ts, protocol
 * §3.4 rev 20): a 429 is retried with backoff up to 3 attempts, only when it
 * is safe, and never multiplied on top of the runtime's own retries. Fake
 * runners (runnerOverride) and fake timers — no real CLI, no real waits.
 */

import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AgentExecOptions, runAgentExec } from '../orgrt/agent-exec.js';
import { backoffMs, RESUME_PROMPT } from '../orgrt/agent-exec-retry.js';
import type { AgentMessage, AgentRunArgs, AgentRunner } from '../orgrt/agent-runner.js';
import { withVendorRetries } from '../orgrt/provider-limit.js';

const OPENROUTER_429 =
  '429: {"message":"Provider returned error","code":429,"metadata":{"raw":"qwen/qwen3.8-27b:free is temporarily rate-limited upstream. Please retry shortly"}}';
const HINT = 'Free models are rate-limited; try again later or pick another model.';

const SUCCESS: AgentMessage = {
  type: 'result',
  session_id: 's2',
  subtype: 'success',
  is_error: false,
  input_tokens: 1,
  output_tokens: 1,
  cost_usd: 0,
};

interface Call {
  resume?: string;
  prompt: string;
}

/** A runner whose n-th run() plays `plans[n]`: messages, then an optional throw. */
function planned(plans: Array<{ yield?: AgentMessage[]; throw?: Error }>): {
  runner: AgentRunner;
  calls: Call[];
} {
  const calls: Call[] = [];
  const runner: AgentRunner = {
    async *run(args: AgentRunArgs) {
      let prompt = '';
      for await (const m of args.prompt as AsyncIterable<{ message: { content: string } }>)
        prompt = m.message.content;
      calls.push({ resume: args.resume, prompt });
      const plan = plans[Math.min(calls.length - 1, plans.length - 1)];
      for (const m of plan.yield ?? []) yield m;
      if (plan.throw) throw plan.throw;
    },
  };
  return { runner, calls };
}

let events: Record<string, unknown>[];
let stdin: PassThrough;

function exec(runner: AgentRunner, over: Partial<AgentExecOptions> = {}): Promise<number> {
  return runAgentExec({
    runtime: 'claude',
    prompt: 'do the thing',
    maxTurns: 5,
    toolTimeoutMs: 60_000,
    returnGraceMs: 10,
    ...over,
    runnerOverride: runner,
    emit: (ev) => events.push(ev),
    stdin,
  });
}

const ofType = (t: string) => events.filter((e) => e.type === t);
const notices = () => ofType('status').map((e) => e.message);

beforeEach(() => {
  events = [];
  stdin = new PassThrough();
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0.5); // no jitter: 2s, 4s
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('agent exec rate-limit retry', () => {
  it('retries a 429 after a backoff and succeeds: one start, one done, a notice', async () => {
    const { runner, calls } = planned([{ throw: new Error(OPENROUTER_429) }, { yield: [SUCCESS] }]);
    const p = exec(runner, { model: 'openrouter/qwen/qwen3.8-27b:free' });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual({ resume: undefined, prompt: 'do the thing' });
    expect(notices()).toEqual([
      'Rate limited (429) by openrouter/qwen/qwen3.8-27b:free; retrying in 2s (attempt 2/3)',
    ]);
    expect(ofType('start')).toHaveLength(1);
    expect(ofType('error')).toHaveLength(0);
    expect(ofType('done')).toEqual([{ v: 1, type: 'done', exit_code: 0 }]);
    expect(ofType('result')[0]).toMatchObject({ subtype: 'success' });
  });

  it('three 429s: exponential waits, then a fatal rate-limited error and exit 1', async () => {
    const { runner, calls } = planned([{ throw: new Error('HTTP 429 Too Many Requests') }]);
    const p = exec(runner, { runtime: 'codex' });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(3_999);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toBe(1);
    expect(calls).toHaveLength(3);
    expect(notices()).toEqual([
      'Rate limited (429) by codex; retrying in 2s (attempt 2/3)',
      'Rate limited (429) by codex; retrying in 4s (attempt 3/3)',
    ]);
    expect(ofType('error')).toEqual([
      {
        v: 1,
        type: 'error',
        code: 'rate-limited',
        fatal: true,
        message: `Rate limited by codex (429) after 3 attempts. ${HINT}`,
      },
    ]);
    expect(ofType('start')).toHaveLength(1);
    expect(ofType('done')).toEqual([{ v: 1, type: 'done', exit_code: 1 }]);
    expect(events.at(-1)?.type).toBe('done');
  });

  it('does not retry after a tool ran when the runtime cannot resume', async () => {
    const { runner, calls } = planned([
      {
        yield: [{ type: 'tool_use', session_id: 'c1', text: 'bash' }],
        throw: new Error('rate limit exceeded'),
      },
    ]);
    const code = await exec(runner, { runtime: 'crush' });
    expect(code).toBe(1);
    expect(calls).toHaveLength(1);
    expect(notices()).toEqual([]);
    expect(ofType('error')[0]).toMatchObject({
      code: 'rate-limited',
      fatal: true,
      message: `Rate limited by crush (429) after 1 attempt; not retried because the turn had already run tools and crush cannot resume it. ${HINT}`,
    });
  });

  it('after a tool ran, retries by resuming the bound session with a continue prompt', async () => {
    const { runner, calls } = planned([
      {
        yield: [
          {
            type: 'tool_use',
            session_id: 's1',
            tool_use_id: 'toolu_1',
            tool: 'Bash',
            input: { command: 'ls' },
          } as AgentMessage,
          {
            type: 'tool_result',
            tool_use_id: 'toolu_1',
            tool: 'Bash',
            is_error: false,
            text: 'ok',
          },
        ],
        throw: new Error(OPENROUTER_429),
      },
      { yield: [SUCCESS] },
    ]);
    const p = exec(runner);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await p).toBe(0);
    expect(calls[1]).toEqual({ resume: 's1', prompt: RESUME_PROMPT });
  });

  it('quota exhaustion is not retried', async () => {
    const { runner, calls } = planned([
      { throw: new Error('429 insufficient_quota: You exceeded your current quota') },
    ]);
    expect(await exec(runner)).toBe(1);
    expect(calls).toHaveLength(1);
    expect(ofType('error')[0]).toMatchObject({ code: 'quota', fatal: true });
    expect(notices()).toEqual([]);
  });

  it('honors the provider Retry-After hint', async () => {
    const { runner, calls } = planned([
      { throw: new Error('Rate limit reached for model. Please try again in 7s.') },
      { yield: [SUCCESS] },
    ]);
    const p = exec(runner);
    await vi.advanceTimersByTimeAsync(6_999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toBe(0);
    expect(notices()[0]).toContain('retrying in 7s (attempt 2/3)');
  });

  it('a cancel frame during the backoff ends the turn as cancelled (exit 130)', async () => {
    const { runner, calls } = planned([{ throw: new Error(OPENROUTER_429) }]);
    const p = exec(runner, { stdioFrames: true });
    await vi.advanceTimersByTimeAsync(500);
    stdin.write('{"type":"cancel"}\n');
    expect(await p).toBe(130);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(1);
    expect(ofType('error')).toEqual([
      { v: 1, type: 'error', code: 'cancelled', fatal: false, message: 'cancelled by caller' },
    ]);
    expect(ofType('done')).toEqual([{ v: 1, type: 'done', exit_code: 130 }]);
  });

  it('does not multiply the runtime’s own retries (pi auto_retry)', async () => {
    const { runner, calls } = planned([
      { throw: withVendorRetries(new Error(`PiAgentRunner: error: ${OPENROUTER_429}`), 3) },
    ]);
    expect(await exec(runner, { runtime: 'pi' })).toBe(1);
    expect(calls).toHaveLength(1);
    expect(ofType('error')[0]).toMatchObject({
      code: 'rate-limited',
      message: `Rate limited by pi (429) after 4 attempts (pi retried it itself 3 times). ${HINT}`,
    });
  });

  it('a wait that would outlast --timeout ends the turn instead', async () => {
    const { runner, calls } = planned([{ throw: new Error(OPENROUTER_429) }]);
    expect(await exec(runner, { timeoutMs: 1_500 })).toBe(1);
    expect(calls).toHaveLength(1);
    expect(String(ofType('error')[0]?.message)).toContain('would outlast --timeout');
  });

  it('retries a rate-limited error result (claude "API Error: 429")', async () => {
    const { runner, calls } = planned([
      {
        yield: [
          {
            type: 'result',
            session_id: 's1',
            subtype: 'error',
            is_error: true,
            text: 'API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}',
          } as AgentMessage,
        ],
      },
      { yield: [SUCCESS] },
    ]);
    const p = exec(runner);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await p).toBe(0);
    expect(calls).toHaveLength(2);
    expect(ofType('result')).toHaveLength(1);
  });

  it('backoff: 2s then 4s with ±20% jitter, capped at 30s; a hint wins', () => {
    expect(backoffMs(2, undefined, () => 0)).toBe(1_600);
    expect(backoffMs(2, undefined, () => 1)).toBe(2_400);
    expect(backoffMs(3, undefined, () => 0.5)).toBe(4_000);
    expect(backoffMs(9, undefined, () => 0.5)).toBe(30_000);
    expect(backoffMs(2, 12_000)).toBe(12_000);
  });
});
