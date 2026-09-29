/**
 * #389 on opencode: `agent exec --access full --tools stdio` through the real
 * OpencodeAgentRunner. Caller tools ride the fence protocol: the served
 * session's assistant text carries the tool_call fence, the next
 * promptAsync carries the tool_result back.
 *
 * @opencode-ai/sdk and node:child_process are mocked (same shapes as
 * opencode-runner-coder.test.ts) — no real opencode server, no model turns.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  callerFence,
  expectAllCallsBeforeResults,
  expectCallerRoundTrip,
  rosterResult,
  runFullAccessToolTurn,
} from '../../src/__tests__/caller-tool-turn.js';

function makeEventStream() {
  const queue: unknown[] = [];
  const waiters: Array<(r: IteratorResult<unknown>) => void> = [];
  const stream = {
    [Symbol.asyncIterator]() {
      return this;
    },
    next(): Promise<IteratorResult<unknown>> {
      if (queue.length > 0) return Promise.resolve({ value: queue.shift(), done: false });
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
  return {
    stream,
    push(ev: unknown) {
      const w = waiters.shift();
      if (w) w({ value: ev, done: false });
      else queue.push(ev);
    },
  };
}

const sessionCreateMock = vi.fn();
const sessionPromptAsyncMock = vi.fn();
const eventSubscribeMock = vi.fn();
const mcpStatusMock = vi.fn();

vi.mock('@opencode-ai/sdk', () => ({
  createOpencodeClient: () => ({
    session: { create: sessionCreateMock, get: vi.fn(), promptAsync: sessionPromptAsyncMock },
    event: { subscribe: eventSubscribeMock },
    config: { get: vi.fn(), providers: vi.fn() },
    mcp: { status: mcpStatusMock },
  }),
}));

const spawnMock = vi.fn();
vi.mock('node:child_process', async (orig) => ({
  ...(await orig<typeof import('node:child_process')>()),
  spawn: (...a: unknown[]) => {
    spawnMock(...a);
    const listeners = new Map<string, Array<(...x: any[]) => void>>();
    const on = (ev: string, fn: (...x: any[]) => void) => {
      listeners.set(ev, [...(listeners.get(ev) ?? []), fn]);
      return { on };
    };
    setTimeout(() => {
      for (const fn of listeners.get('data') ?? [])
        fn(Buffer.from('opencode server listening on http://127.0.0.1:41234\n'));
    }, 0);
    return { stdout: { on }, stderr: { on }, on, kill: vi.fn() };
  },
}));

import { OpencodeAgentRunner } from '../../src/orgrt/opencode-runner.js';
import { FULL_ACCESS_PERMISSION } from '../../src/orgrt/opencode-runner-server.js';

const S = 'ses_1';

const msg = (id: string, extra: Record<string, unknown> = {}) => ({
  type: 'message.updated',
  properties: {
    info: { id, sessionID: S, role: 'assistant', time: { created: 1 }, ...extra },
  },
});
const done = (id: string) =>
  msg(id, {
    time: { created: 1, completed: 2 },
    finish: 'stop',
    tokens: { input: 1, output: 1, cache: { read: 0, write: 0 } },
  });
const textPart = (messageID: string, id: string, text: string) => ({
  type: 'message.part.updated',
  properties: { part: { id, sessionID: S, messageID, type: 'text', text } },
});

/** One assistant step per promptAsync call, replying with `replies[i]`. */
function scriptReplies(replies: string[]) {
  let i = 0;
  sessionPromptAsyncMock.mockImplementation(async () => {
    const id = `m${++i}`;
    es.push(msg(id));
    es.push(textPart(id, `p${i}`, replies[i - 1]));
    es.push(done(id));
  });
}

let es: ReturnType<typeof makeEventStream>;

beforeEach(() => {
  for (const m of [sessionCreateMock, sessionPromptAsyncMock, eventSubscribeMock, mcpStatusMock, spawnMock])
    m.mockReset();
  delete process.env.OPENCODE_URL;
  es = makeEventStream();
  eventSubscribeMock.mockResolvedValue({ stream: es.stream });
  sessionCreateMock.mockResolvedValue({ data: { id: S } });
  mcpStatusMock.mockResolvedValue({ data: {} });
});

describe('#389 opencode: full access + stdio caller tools', () => {
  it('a full-access turn calls a stdio tool and gets the result back', async () => {
    scriptReplies([`Checking.\n${callerFence('core')}`, 'done']);
    const turn = await runFullAccessToolTurn('opencode', new OpencodeAgentRunner());
    expectCallerRoundTrip(turn, ['core']);
    // Full access: the served process carries the allow-everything permission map.
    expect(JSON.parse(spawnMock.mock.calls[0][2].env.OPENCODE_PERMISSION)).toEqual(
      FULL_ACCESS_PERMISSION,
    );
    // Tool protocol on the first prompt, the caller's answer in the next one (same session).
    const prompts = sessionPromptAsyncMock.mock.calls.map((c) => c[0]);
    expect(prompts).toHaveLength(2);
    expect(prompts[0].body.system).toContain('org_roster');
    expect(prompts[1].path.id).toBe(S);
    expect(prompts[1].body.parts[0].text).toContain(rosterResult('core'));
  });

  it('two parallel caller calls: both tool_call frames before either tool_result', async () => {
    scriptReplies([`Checking both.\n${callerFence('core')}\n${callerFence('qa')}`, 'done']);
    const turn = await runFullAccessToolTurn('opencode', new OpencodeAgentRunner(), {
      expectCalls: 2,
    });
    expectCallerRoundTrip(turn, ['core', 'qa']);
    expectAllCallsBeforeResults(turn, 2);
    const second = sessionPromptAsyncMock.mock.calls[1][0].body.parts[0].text as string;
    expect(second).toContain(rosterResult('core'));
    expect(second).toContain(rosterResult('qa'));
  });
});
