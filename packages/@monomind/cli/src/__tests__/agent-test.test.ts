/**
 * Tests for `monomind agent test <runtime> --json` (issue #390): the
 * orgrt/agent-test.ts engine and the commands/agent-test.ts CLI layer, with
 * mocked runners — no real agent CLI is spawned.
 */

import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isJsonTest, runAgentTestCommand } from '../commands/agent-test.js';
import type { AgentMessage, AgentRunArgs, AgentRunner } from '../orgrt/agent-runner.js';
import {
  AGENT_TEST_PROMPT,
  type AgentTestOptions,
  agentTestExitCode,
  isOkReply,
  resolveCost,
  runAgentTest,
} from '../orgrt/agent-test.js';
import type { CommandContext } from '../types.js';

/** Runner that records its args and yields a script (or throws). */
function mockRunner(
  script: AgentMessage[],
  opts: { throwAfter?: Error; hang?: boolean } = {},
): AgentRunner & { calls: AgentRunArgs[] } {
  const calls: AgentRunArgs[] = [];
  return {
    calls,
    async *run(args: AgentRunArgs) {
      calls.push(args);
      expect(existsSync(args.cwd ?? '')).toBe(true); // temp cwd exists during the turn
      for (const m of script) yield m;
      if (opts.throwAfter) throw opts.throwAfter;
      if (opts.hang) {
        await new Promise<void>((resolve) =>
          args.signal?.addEventListener('abort', () => resolve()),
        );
      }
    },
  };
}

const okTurn = (text: string, extra: Partial<AgentMessage> = {}): AgentMessage[] => [
  { type: 'assistant', text },
  { type: 'result', subtype: 'success', input_tokens: 12, output_tokens: 1, ...extra },
];

/** Clock that advances 100ms per call. */
function fakeClock(): () => number {
  let t = 1_000;
  return () => {
    t += 100;
    return t;
  };
}

const run = (runtime: string, runner: AgentRunner, over: Partial<AgentTestOptions> = {}) =>
  runAgentTest({
    runtime,
    timeoutMs: 5_000,
    runnerOverride: runner,
    findBinary: () => undefined,
    now: fakeClock(),
    ...over,
  });

describe('runAgentTest: turn setup', () => {
  it('sends one ok-prompt turn: max turns 1, no tools, scoped, fresh temp cwd removed after', async () => {
    const runner = mockRunner(okTurn('ok'));
    await run('claude', runner);
    expect(runner.calls).toHaveLength(1);
    const args = runner.calls[0];
    expect(args.maxTurns).toBe(1);
    expect(args.tools).toEqual([]);
    expect(args.access).toBe('scoped');
    expect(args.cwd).toMatch(/monomind-agent-test-/);
    expect(args.cwd).not.toBe(process.cwd());
    expect(existsSync(args.cwd ?? '')).toBe(false);
    const first = await (args.prompt as AsyncIterable<{ message: { content: string } }>)
      [Symbol.asyncIterator]()
      .next();
    expect(first.value.message.content).toBe(AGENT_TEST_PROMPT);
  });

  it('removes the temp cwd even when the runner throws', async () => {
    const runner = mockRunner([], { throwAfter: new Error('boom') });
    await run('claude', runner);
    expect(existsSync(runner.calls[0].cwd ?? '')).toBe(false);
  });

  it('passes --model through and echoes it', async () => {
    const runner = mockRunner(okTurn('ok'));
    const r = await run('claude', runner, { model: 'claude-sonnet-5' });
    expect(runner.calls[0].model).toBe('claude-sonnet-5');
    expect(r.model).toBe('claude-sonnet-5');
  });
});

describe('runAgentTest: statuses', () => {
  it('ok — full result shape with latency fields', async () => {
    const r = await run('claude', mockRunner(okTurn('OK.', { cost_usd: 0.0001 })));
    expect(r).toEqual({
      v: 1,
      runtime: 'claude',
      model: null,
      status: 'ok',
      reply: 'OK.',
      latency_first_ms: expect.any(Number),
      latency_ms: expect.any(Number),
      input_tokens: 12,
      output_tokens: 1,
      cost_usd: 0.0001,
      cost_estimated: false,
      runtime_version: null,
      native_sandbox: 'monomind',
      error: null,
    });
    expect(r.latency_first_ms).toBeGreaterThan(0);
    expect(r.latency_ms).toBeGreaterThan(r.latency_first_ms as number);
  });

  it('ok_unexpected — the turn succeeded with other text', async () => {
    const r = await run('claude', mockRunner(okTurn('Sure! Here is the word you asked for: ok')));
    expect(r.status).toBe('ok_unexpected');
    expect(r.error).toBeNull();
  });

  it('auth — carries the runtime login hint', async () => {
    const r = await run(
      'codex',
      mockRunner([], { throwAfter: new Error('codex exec failed: 401 auth_error') }),
    );
    expect(r.status).toBe('auth');
    expect(r.error?.code).toBe('auth');
    expect(r.error?.login_hint).toBeTruthy();
  });

  it.each([
    // #473: messages from issue #473 (crush) and pi 0.87.1 run without credentials.
    [
      'crush',
      "CrushAgentRunner: crush run failed (exit 1)\nstderr: No providers configured - please run 'crush' to set up a provider interactively.",
    ],
    [
      'pi',
      'PiAgentRunner: pi failed (exit 1)\nstderr: No API key found for the selected model.\n\nUse /login to log into a provider via OAuth or API key.',
    ],
  ])('auth — %s sign-in failure carries its login hint (#473)', async (runtime, message) => {
    const r = await run(runtime, mockRunner([], { throwAfter: new Error(message) }));
    expect(r.status).toBe('auth');
    expect(r.error?.code).toBe('auth');
    expect(r.error?.login_hint).toBeTruthy();
  });

  it('quota', async () => {
    const r = await run('codex', mockRunner([], { throwAfter: new Error('usage limit reached') }));
    expect(r.status).toBe('quota');
    expect(r.error?.code).toBe('quota');
    expect(r.error?.login_hint).toBeUndefined();
  });

  it('model_unavailable — from an is_error result whose text is only in the assistant message', async () => {
    const r = await run(
      'claude',
      mockRunner([
        {
          type: 'assistant',
          text: "There's an issue with the selected model (claude-nonexistent-9). It may not exist or you may not have access to it.",
        },
        { type: 'result', subtype: 'success', is_error: true, input_tokens: 0, output_tokens: 0 },
      ]),
      { model: 'claude-nonexistent-9' },
    );
    expect(r.status).toBe('model_unavailable');
    expect(r.error?.code).toBe('model-unavailable');
  });

  it('model_unavailable — from a thrown runner error', async () => {
    const r = await run(
      'copilot',
      mockRunner([], {
        throwAfter: new Error(
          'Error: Model "gpt-nonexistent-9" from --model flag is not available.',
        ),
      }),
    );
    expect(r.status).toBe('model_unavailable');
  });

  it('timeout', async () => {
    const r = await run('claude', mockRunner([], { hang: true }), { timeoutMs: 30 });
    expect(r.status).toBe('timeout');
    expect(r.error?.code).toBe('timeout');
    expect(r.latency_first_ms).toBeNull();
  });

  it('missing_binary — binary absent on PATH, runner never started', async () => {
    const r = await runAgentTest({ runtime: 'codex', timeoutMs: 5_000, findBinary: () => null });
    expect(r.status).toBe('missing_binary');
    expect(r.error?.code).toBe('missing-binary');
    expect(r.error?.message).toMatch(/codex CLI not found/);
  });

  it('missing_binary — runner rethrew ENOENT as prose', async () => {
    const r = await run(
      'codex',
      mockRunner([], {
        throwAfter: new Error('CodexAgentRunner requires the Codex CLI (codex) on PATH.'),
      }),
    );
    expect(r.status).toBe('missing_binary');
  });

  it('error — anything else', async () => {
    const r = await run('claude', mockRunner([], { throwAfter: new Error('connection reset') }));
    expect(r.status).toBe('error');
    expect(r.error).toEqual({ code: 'runner-error', message: 'connection reset' });
  });

  it('reports runtime_version from the installed binary', async () => {
    const versionOf = vi.fn(async () => '2.1.281');
    const r = await run('claude', mockRunner(okTurn('ok')), {
      findBinary: () => '/opt/bin/claude',
      versionOf,
    });
    expect(versionOf).toHaveBeenCalledWith('claude', '/opt/bin/claude');
    expect(r.runtime_version).toBe('2.1.281');
  });
});

describe('runAgentTest: --sandbox and --env (#474)', () => {
  it('passes --sandbox and --env to the turn and reports native_sandbox from start', async () => {
    const runner = mockRunner(okTurn('ok'));
    const r = await run('codex', runner, { sandbox: 'read-only', env: { FOO: 'bar' } });
    expect(runner.calls[0].sandbox).toBe('read-only');
    expect(runner.calls[0].env?.FOO).toBe('bar');
    expect(runner.calls[0].access).toBe('scoped');
    expect(r.status).toBe('ok');
    expect(r.native_sandbox).toBe('read-only');
  });

  it('reports the default sandbox when none is asked for', async () => {
    const r = await run('codex', mockRunner(okTurn('ok')));
    expect(r.native_sandbox).toBe('full');
  });

  it('--env MONOMIND_GIT_LEVEL can only tighten: a restricted level caps --sandbox full', async () => {
    const runner = mockRunner(okTurn('ok'));
    const r = await run('codex', runner, {
      sandbox: 'full',
      env: { MONOMIND_GIT_LEVEL: 'read' },
    });
    expect(runner.calls[0].sandbox).toBe('workspace-write');
    expect(r.native_sandbox).toBe('workspace-write');
  });

  it('--env MONOMIND_GIT_LEVEL=push does not loosen --sandbox read-only', async () => {
    const runner = mockRunner(okTurn('ok'));
    const r = await run('codex', runner, {
      sandbox: 'read-only',
      env: { MONOMIND_GIT_LEVEL: 'push' },
    });
    expect(runner.calls[0].sandbox).toBe('read-only');
    expect(r.native_sandbox).toBe('read-only');
  });

  it('a mode the runtime lacks is status error / code unsupported, and no turn runs', async () => {
    const runner = mockRunner(okTurn('ok'));
    const r = await run('pi', runner, { sandbox: 'workspace-write' });
    expect(runner.calls).toHaveLength(0);
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('unsupported');
    expect(r.error?.message).toMatch(/not supported by runtime "pi"/);
    expect(r.native_sandbox).toBeNull();
    expect(agentTestExitCode(r.status)).toBe(1);
  });

  it('--sandbox full is accepted on every runtime', async () => {
    const r = await run('pi', mockRunner(okTurn('ok')), { sandbox: 'full' });
    expect(r.status).toBe('ok');
    expect(r.native_sandbox).toBe('none');
  });
});

describe('cost', () => {
  it('cost_estimated:false when the runtime reports cost', () => {
    expect(resolveCost('gpt-5', 0.002, 100, 10)).toEqual({
      cost_usd: 0.002,
      cost_estimated: false,
    });
  });

  it('cost_estimated:true from the pricing table when the runtime reports none', async () => {
    const r = await run('codex', mockRunner(okTurn('ok')), { model: 'gpt-5' });
    expect(r.cost_estimated).toBe(true);
    expect(r.cost_usd).toBeCloseTo(12 * 2.5e-6 + 1 * 10e-6, 12);
  });

  it('cost_usd null when unreported and the model is unpriced', () => {
    expect(resolveCost('mystery-model', 0, 5, 1)).toEqual({
      cost_usd: null,
      cost_estimated: false,
    });
    expect(resolveCost(undefined, 0, 5, 1)).toEqual({ cost_usd: null, cost_estimated: false });
  });

  it('zero tokens = zero cost, not estimated', () => {
    expect(resolveCost('gpt-5', 0, 0, 0)).toEqual({ cost_usd: 0, cost_estimated: false });
  });
});

describe('helpers', () => {
  it('isOkReply allows case, whitespace and trailing punctuation only', () => {
    for (const s of ['ok', 'OK', ' Ok.\n', 'ok!', 'ok…']) expect(isOkReply(s)).toBe(true);
    for (const s of ['okay', 'ok ok', 'not ok', '', null]) expect(isOkReply(s)).toBe(false);
  });

  it('exit codes: 0 for ok/ok_unexpected, 124 timeout, 1 otherwise', () => {
    expect(agentTestExitCode('ok')).toBe(0);
    expect(agentTestExitCode('ok_unexpected')).toBe(0);
    expect(agentTestExitCode('timeout')).toBe(124);
    for (const s of ['auth', 'quota', 'model_unavailable', 'missing_binary', 'error'] as const) {
      expect(agentTestExitCode(s)).toBe(1);
    }
  });
});

describe('runAgentTestCommand (CLI layer)', () => {
  const ctx = (args: string[], flags: Record<string, unknown> = {}): CommandContext => ({
    args,
    flags: { _: [], ...flags },
    cwd: process.cwd(),
    interactive: false,
  });
  afterEach(() => vi.restoreAllMocks());

  it('--json prints exactly one JSON object and returns 0 on ok', async () => {
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
      out.push(String(s));
      return true;
    });
    const code = await runAgentTestCommand(ctx(['claude'], { json: true, model: 'x' }), {
      runnerOverride: mockRunner(okTurn('ok')),
      findBinary: () => undefined,
    });
    expect(code).toBe(0);
    expect(out).toHaveLength(1);
    const parsed = JSON.parse(out[0]);
    expect(parsed).toMatchObject({ v: 1, runtime: 'claude', model: 'x', status: 'ok' });
  });

  it('--json reports a timeout as status timeout with exit 124', async () => {
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
      out.push(String(s));
      return true;
    });
    const code = await runAgentTestCommand(ctx(['claude'], { json: true, timeout: '30ms' }), {
      runnerOverride: mockRunner([], { hang: true }),
      findBinary: () => undefined,
    });
    expect(code).toBe(124);
    expect(JSON.parse(out.join(''))).toMatchObject({ status: 'timeout' });
  });

  it('only --json (or --format json) selects the structured result', () => {
    expect(isJsonTest(ctx(['claude'], { json: true }))).toBe(true);
    expect(isJsonTest(ctx(['claude'], { format: 'json' }))).toBe(true);
    expect(isJsonTest(ctx(['claude']))).toBe(false);
  });

  it('usage errors exit 2', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(await runAgentTestCommand(ctx([]))).toBe(2);
    expect(await runAgentTestCommand(ctx(['claude'], { timeout: 'soon' }))).toBe(2);
  });

  it('#474: bad --sandbox or --env is a usage error (exit 2)', async () => {
    const err: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((s) => {
      err.push(String(s));
      return true;
    });
    expect(await runAgentTestCommand(ctx(['codex'], { json: true, sandbox: 'strict' }))).toBe(2);
    expect(err.join('')).toMatch(/--sandbox must be one of read-only, workspace-write, full/);
    expect(await runAgentTestCommand(ctx(['codex'], { json: true, env: ['NOPE'] }))).toBe(2);
    expect(err.join('')).toMatch(/invalid --env entry/);
  });

  it('#474: --sandbox and repeatable --env reach the turn; native_sandbox is in the JSON', async () => {
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
      out.push(String(s));
      return true;
    });
    const runner = mockRunner(okTurn('ok'));
    const code = await runAgentTestCommand(
      ctx(['codex'], { json: true, sandbox: 'workspace-write', env: ['A=1', 'B=x=y'] }),
      { runnerOverride: runner, findBinary: () => undefined },
    );
    expect(code).toBe(0);
    expect(runner.calls[0].env).toMatchObject({ A: '1', B: 'x=y' });
    expect(JSON.parse(out.join(''))).toMatchObject({
      status: 'ok',
      native_sandbox: 'workspace-write',
    });
  });
});
