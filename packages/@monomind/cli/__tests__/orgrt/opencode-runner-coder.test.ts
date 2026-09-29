/**
 * Coder mode on opencode (plan MM3): full-access permission override and
 * `always` replies, native tool parts → matched tool_use/tool_result with
 * canonical inputs, multi-step rounds, effort → model variant, resume.
 *
 * @opencode-ai/sdk and node:child_process are mocked (same shapes as
 * opencode-runner.test.ts) — no real opencode server, no model turns.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage, AgentRunArgs } from '../../src/orgrt/agent-runner.js';

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
const sessionGetMock = vi.fn();
const sessionPromptAsyncMock = vi.fn();
const eventSubscribeMock = vi.fn();
const configGetMock = vi.fn();
const configProvidersMock = vi.fn();
const mcpStatusMock = vi.fn();

vi.mock('@opencode-ai/sdk', () => ({
  createOpencodeClient: () => ({
    session: { create: sessionCreateMock, get: sessionGetMock, promptAsync: sessionPromptAsyncMock },
    event: { subscribe: eventSubscribeMock },
    config: { get: configGetMock, providers: configProvidersMock },
    mcp: { status: mcpStatusMock },
  }),
}));

const spawnMock = vi.fn();
vi.mock('node:child_process', () => ({
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
import {
  FULL_ACCESS_PERMISSION,
  RESTRICTED_PERMISSION,
} from '../../src/orgrt/opencode-runner-server.js';
import {
  canonicalOpencodeTool,
  OpencodeToolParts,
  parsePatchText,
} from '../../src/orgrt/opencode-runner-tools.js';

const S = 'ses_1';

function makeArgs(overrides?: Partial<AgentRunArgs>): AgentRunArgs {
  return {
    tools: [],
    prompt: (async function* () {
      yield 'do work';
    })(),
    systemPrompt: 'test role',
    cwd: '/tmp/proj',
    env: {},
    maxTurns: 5,
    ...overrides,
  };
}

async function collect(args: AgentRunArgs): Promise<AgentMessage[]> {
  const out: AgentMessage[] = [];
  for await (const m of new OpencodeAgentRunner().run(args)) out.push(m);
  return out;
}

const msg = (id: string, extra: Record<string, unknown> = {}) => ({
  type: 'message.updated',
  properties: {
    info: { id, sessionID: S, role: 'assistant', time: { created: 1 }, ...extra },
  },
});
const done = (id: string, finish: string, input: number, output: number, cost = 0) =>
  msg(id, {
    time: { created: 1, completed: 2 },
    finish,
    tokens: { input, output, cache: { read: 0, write: 0 } },
    cost,
  });
const toolPart = (messageID: string, callID: string, tool: string, state: unknown) => ({
  type: 'message.part.updated',
  properties: {
    part: { id: `prt_${callID}`, sessionID: S, messageID, type: 'tool', callID, tool, state },
  },
});
const textPart = (messageID: string, id: string, text: string) => ({
  type: 'message.part.updated',
  properties: { part: { id, sessionID: S, messageID, type: 'text', text } },
});

let es: ReturnType<typeof makeEventStream>;
const fetchMock = vi.fn();

beforeEach(() => {
  for (const m of [
    sessionCreateMock,
    sessionGetMock,
    sessionPromptAsyncMock,
    eventSubscribeMock,
    configGetMock,
    configProvidersMock,
    mcpStatusMock,
    spawnMock,
    fetchMock,
  ])
    m.mockReset();
  delete process.env.OPENCODE_URL;
  es = makeEventStream();
  eventSubscribeMock.mockResolvedValue({ stream: es.stream });
  sessionCreateMock.mockResolvedValue({ data: { id: S } });
  mcpStatusMock.mockResolvedValue({ data: { 'my-docs': { status: 'connected' } } });
  fetchMock.mockResolvedValue({ ok: true });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('canonicalOpencodeTool', () => {
  it('maps built-in tools to contract kinds and canonical inputs', () => {
    expect(
      canonicalOpencodeTool('bash', { command: 'ls', description: 'list', workdir: '/w' }),
    ).toEqual({ kind: 'shell', input: { command: 'ls', description: 'list', cwd: '/w' } });
    expect(
      canonicalOpencodeTool('edit', { filePath: '/a.ts', oldString: 'x', newString: 'y' }),
    ).toEqual({ kind: 'edit', input: { file_path: '/a.ts', old_string: 'x', new_string: 'y' } });
    expect(canonicalOpencodeTool('write', { filePath: '/b', content: 'c' })).toEqual({
      kind: 'write',
      input: { file_path: '/b', content: 'c' },
    });
    expect(canonicalOpencodeTool('read', { filePath: '/r', offset: 3 })).toEqual({
      kind: 'read',
      input: { file_path: '/r' },
    });
    expect(canonicalOpencodeTool('grep', { pattern: 'foo', path: 'src' })).toEqual({
      kind: 'search',
      input: { pattern: 'foo', path: 'src' },
    });
    expect(canonicalOpencodeTool('glob', { pattern: '**/*.ts' })).toEqual({
      kind: 'search',
      input: { pattern: '**/*.ts' },
    });
    expect(canonicalOpencodeTool('webfetch', { url: 'https://x', format: 'md' })).toEqual({
      kind: 'web',
      input: { url: 'https://x' },
    });
    expect(canonicalOpencodeTool('websearch', { query: 'q' })).toEqual({
      kind: 'web',
      input: { query: 'q' },
    });
    expect(canonicalOpencodeTool('task', { prompt: 'p' }).kind).toBe('task');
    expect(canonicalOpencodeTool('todowrite', { todos: [] }).kind).toBe('todo');
  });

  it('maps an MCP tool id (sanitized server + "_" + tool) to mcp {server, tool, arguments}', () => {
    expect(canonicalOpencodeTool('my-docs_search_all', { q: 1 }, ['my', 'my-docs'])).toEqual({
      kind: 'mcp',
      input: { server: 'my-docs', tool: 'search_all', arguments: { q: 1 } },
    });
    expect(canonicalOpencodeTool('g_h_pr_list', { a: 1 }, ['g.h'])).toEqual({
      kind: 'mcp',
      input: { server: 'g.h', tool: 'pr_list', arguments: { a: 1 } },
    });
    expect(canonicalOpencodeTool('mystery', { a: 1 })).toEqual({
      kind: 'other',
      input: { a: 1 },
    });
  });

  it('parses apply_patch text into patch files', () => {
    const text = [
      '*** Begin Patch',
      '*** Add File: new.txt',
      '+hello',
      '*** Update File: src/a.ts',
      '@@',
      '-x',
      '+y',
      '*** Delete File: old.txt',
      '*** End Patch',
    ].join('\n');
    expect(parsePatchText(text)).toEqual([
      { file_path: 'new.txt', action: 'add', diff: '+hello' },
      { file_path: 'src/a.ts', action: 'update', diff: '@@\n-x\n+y' },
      { file_path: 'old.txt', action: 'delete' },
    ]);
    expect(canonicalOpencodeTool('apply_patch', { patchText: text }).kind).toBe('patch');
  });
});

describe('OpencodeToolParts', () => {
  it('skips pending, starts once on running, ends once on completed with duration + exit code', () => {
    const tp = new OpencodeToolParts(S);
    const part = (state: unknown) => ({ callID: 'c1', tool: 'bash', state });
    expect(tp.onPart(part({ status: 'pending', input: {}, raw: '' }))).toEqual([]);
    const running = { status: 'running', input: { command: 'ls' }, time: { start: 10 } };
    const [start] = tp.onPart(part(running));
    expect(start).toMatchObject({
      type: 'tool_use',
      tool_use_id: 'c1',
      tool: 'bash',
      kind: 'shell',
      input: { command: 'ls' },
    });
    expect(tp.onPart(part(running))).toEqual([]);
    const completed = {
      status: 'completed',
      input: { command: 'ls' },
      output: 'a\nb',
      metadata: { exit: 0 },
      time: { start: 10, end: 35 },
    };
    expect(tp.onPart(part(completed))).toEqual([
      {
        type: 'tool_result',
        session_id: S,
        tool_use_id: 'c1',
        tool: 'bash',
        is_error: false,
        text: 'a\nb',
        duration_ms: 25,
        exit_code: 0,
      },
    ]);
    expect(tp.onPart(part(completed))).toEqual([]);
  });

  it('emits start then an error end when the call failed before any running update', () => {
    const tp = new OpencodeToolParts(S);
    const out = tp.onPart({
      callID: 'c2',
      tool: 'read',
      state: { status: 'error', input: { filePath: '/x' }, error: 'ENOENT', time: { start: 1, end: 2 } },
    });
    expect(out.map((m) => m.type)).toEqual(['tool_use', 'tool_result']);
    expect(out[0]).toMatchObject({ kind: 'read', input: { file_path: '/x' } });
    expect(out[1]).toMatchObject({ tool_use_id: 'c2', is_error: true, text: 'ENOENT' });
  });
});

describe('OpencodeAgentRunner coder mode', () => {
  it('full access: spawns serve with the permission override in its own process group', async () => {
    sessionPromptAsyncMock.mockImplementation(async () => {
      es.push(msg('m1'));
      es.push(done('m1', 'stop', 1, 1));
    });
    await collect(makeArgs({ access: 'full' }));
    const opts = spawnMock.mock.calls[0][2];
    expect(JSON.parse(opts.env.OPENCODE_PERMISSION)).toEqual(FULL_ACCESS_PERMISSION);
    expect(FULL_ACCESS_PERMISSION['*']).toBe('allow');
    expect(FULL_ACCESS_PERMISSION.bash).toBe('allow');
    expect(FULL_ACCESS_PERMISSION.question).toBe('deny');
    expect(opts.env.MONOMIND_EXEC_TREE).toBeTruthy();
    if (process.platform !== 'win32') expect(opts.detached).toBe(true);
  });

  it('scoped: no permission override, no process group (unchanged spawn)', async () => {
    sessionPromptAsyncMock.mockImplementation(async () => {
      es.push(msg('m1'));
      es.push(done('m1', 'stop', 1, 1));
    });
    await collect(makeArgs());
    const opts = spawnMock.mock.calls[0][2];
    expect(opts.env.OPENCODE_PERMISSION).toBeUndefined();
    expect(opts.detached).toBeUndefined();
  });

  it('runs a multi-step round: tool step (finish tool-calls) then a text step, summing usage', async () => {
    sessionPromptAsyncMock.mockImplementation(async () => {
      es.push({ type: 'message.updated', properties: { info: { id: 'u1', sessionID: S, role: 'user' } } });
      es.push(msg('m1'));
      es.push(toolPart('m1', 'call_1', 'bash', { status: 'pending', input: {}, raw: '' }));
      es.push(
        toolPart('m1', 'call_1', 'bash', {
          status: 'running',
          input: { command: 'echo hi' },
          time: { start: 1 },
        }),
      );
      es.push(
        toolPart('m1', 'call_1', 'bash', {
          status: 'completed',
          input: { command: 'echo hi' },
          output: 'hi',
          title: 'echo',
          metadata: { exit: 0 },
          time: { start: 1, end: 5 },
        }),
      );
      es.push(done('m1', 'tool-calls', 10, 2, 0.01));
      es.push(msg('m2'));
      es.push(textPart('m2', 'p2', 'all done'));
      es.push(done('m2', 'stop', 20, 3, 0.02));
    });
    const out = await collect(makeArgs({ access: 'full', extras: { includePartialMessages: true } }));
    expect(out.map((m) => m.type)).toEqual(['tool_use', 'tool_result', 'assistant', 'result']);
    expect(out[0]).toMatchObject({ tool_use_id: 'call_1', kind: 'shell', input: { command: 'echo hi' } });
    expect(out[1]).toMatchObject({ tool_use_id: 'call_1', text: 'hi', exit_code: 0, duration_ms: 4 });
    expect(out[2].text).toBe('all done');
    expect(out[3]).toMatchObject({ input_tokens: 30, output_tokens: 5 });
    expect(out[3].cost_usd).toBeCloseTo(0.03);
  });

  it('does not emit tool messages without includePartialMessages/includeToolUseEvents (org runtime)', async () => {
    sessionPromptAsyncMock.mockImplementation(async () => {
      es.push(msg('m1'));
      es.push(
        toolPart('m1', 'c', 'read', { status: 'completed', input: {}, output: 'x', time: { start: 1, end: 2 } }),
      );
      es.push(done('m1', 'tool-calls', 1, 1));
      es.push(msg('m2'));
      es.push(done('m2', 'stop', 1, 1));
    });
    const out = await collect(makeArgs());
    expect(out.map((m) => m.type)).toEqual(['result']);
    expect(mcpStatusMock).not.toHaveBeenCalled();
  });

  it('includeToolUseEvents alone opts into tool messages', async () => {
    sessionPromptAsyncMock.mockImplementation(async () => {
      es.push(msg('m1'));
      es.push(
        toolPart('m1', 'c', 'my-docs_find', {
          status: 'completed',
          input: { q: 'x' },
          output: 'r',
          time: { start: 1, end: 2 },
        }),
      );
      es.push(done('m1', 'stop', 1, 1));
    });
    const out = await collect(makeArgs({ extras: { includeToolUseEvents: true } }));
    expect(out[0]).toMatchObject({
      type: 'tool_use',
      kind: 'mcp',
      input: { server: 'my-docs', tool: 'find', arguments: { q: 'x' } },
    });
  });

  it('ends the round on session.idle once every step it saw has completed', async () => {
    sessionPromptAsyncMock.mockImplementation(async () => {
      es.push({ type: 'session.idle', properties: { sessionID: S } }); // stale, ignored
      es.push(msg('m1'));
      es.push(done('m1', 'tool-calls', 1, 1));
      es.push({ type: 'session.status', properties: { sessionID: S, status: { type: 'idle' } } });
    });
    const out = await collect(makeArgs());
    expect(out.map((m) => m.type)).toEqual(['result']);
  });

  it('full access answers permission requests "always" for its own and child sessions only', async () => {
    sessionPromptAsyncMock.mockImplementation(async () => {
      es.push(msg('m1'));
      es.push({ type: 'permission.asked', properties: { id: 'per_1', sessionID: S } });
      es.push({
        type: 'session.created',
        properties: { info: { id: 'ses_child', parentID: S } },
      });
      es.push({ type: 'permission.asked', properties: { id: 'per_2', sessionID: 'ses_child' } });
      es.push({ type: 'permission.asked', properties: { id: 'per_3', sessionID: 'ses_other' } });
      es.push({ type: 'permission.updated', properties: { id: 'per_4', sessionID: S } });
      es.push(done('m1', 'stop', 1, 1));
    });
    await collect(makeArgs({ access: 'full' }));
    const calls = fetchMock.mock.calls.map(([url, init]) => [String(url), JSON.parse(init.body)]);
    expect(calls).toEqual([
      ['http://127.0.0.1:41234/permission/per_1/reply?directory=%2Ftmp%2Fproj', { reply: 'always' }],
      ['http://127.0.0.1:41234/permission/per_2/reply?directory=%2Ftmp%2Fproj', { reply: 'always' }],
      [
        'http://127.0.0.1:41234/session/ses_1/permissions/per_4?directory=%2Ftmp%2Fproj',
        { response: 'always' },
      ],
    ]);
  });

  it('scoped mode never answers permission requests', async () => {
    sessionPromptAsyncMock.mockImplementation(async () => {
      es.push(msg('m1'));
      es.push({ type: 'permission.asked', properties: { id: 'per_1', sessionID: S } });
      es.push(done('m1', 'stop', 1, 1));
    });
    await collect(makeArgs());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('#482 --sandbox restricted: edit/bash/task/external_directory ask, and every ask is rejected', async () => {
    sessionPromptAsyncMock.mockImplementation(async () => {
      es.push(msg('m1'));
      es.push({ type: 'permission.asked', properties: { id: 'per_1', sessionID: S } });
      es.push({ type: 'permission.updated', properties: { id: 'per_2', sessionID: S } });
      es.push(done('m1', 'stop', 1, 1));
    });
    for (const access of ['scoped', 'full'] as const) {
      spawnMock.mockClear();
      fetchMock.mockClear();
      await collect(makeArgs({ access, sandbox: 'restricted' }));
      const env = spawnMock.mock.calls[0][2].env;
      expect(JSON.parse(env.OPENCODE_PERMISSION), access).toEqual(RESTRICTED_PERMISSION);
      const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body));
      expect(bodies, access).toEqual([{ reply: 'reject' }, { response: 'reject' }]);
    }
    expect(Object.values(RESTRICTED_PERMISSION)).toEqual(['ask', 'ask', 'ask', 'ask']);
  });

  it('#482 --sandbox restricted refuses an attached server (its rules cannot be set)', async () => {
    process.env.OPENCODE_URL = 'http://127.0.0.1:9';
    await expect(collect(makeArgs({ sandbox: 'restricted' }))).rejects.toThrow(/OPENCODE_URL/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('maps effort to a variant the model lists, and omits one it does not', async () => {
    configProvidersMock.mockResolvedValue({
      data: {
        providers: [{ id: 'openai', models: { 'gpt-5': { variants: { low: {}, high: {}, none: {} } } } }],
        default: {},
      },
    });
    sessionPromptAsyncMock.mockImplementation(async () => {
      es.push(msg('m1'));
      es.push(done('m1', 'stop', 1, 1));
    });
    await collect(makeArgs({ model: 'openai/gpt-5', effort: 'high' }));
    expect(sessionPromptAsyncMock.mock.calls[0][0].body.variant).toBe('high');

    es = makeEventStream();
    eventSubscribeMock.mockResolvedValue({ stream: es.stream });
    await collect(makeArgs({ model: 'openai/gpt-5', effort: 'off' }));
    expect(sessionPromptAsyncMock.mock.calls[1][0].body.variant).toBe('none');

    es = makeEventStream();
    eventSubscribeMock.mockResolvedValue({ stream: es.stream });
    await collect(makeArgs({ model: 'openai/gpt-5', effort: 'max' }));
    expect('variant' in sessionPromptAsyncMock.mock.calls[2][0].body).toBe(false);
  });

  it('uses the served config model for effort when args.model is unset', async () => {
    configGetMock.mockResolvedValue({ data: { model: 'anthropic/claude-x' } });
    configProvidersMock.mockResolvedValue({
      data: { providers: [{ id: 'anthropic', models: { 'claude-x': { variants: { max: {} } } } }] },
    });
    sessionPromptAsyncMock.mockImplementation(async () => {
      es.push(msg('m1'));
      es.push(done('m1', 'stop', 1, 1));
    });
    await collect(makeArgs({ effort: 'max' }));
    expect(sessionPromptAsyncMock.mock.calls[0][0].body.variant).toBe('max');
  });

  it('resume: fails clearly when the session does not exist', async () => {
    sessionGetMock.mockResolvedValue({ error: { name: 'NotFoundError', data: { message: 'gone' } } });
    await expect(collect(makeArgs({ resume: 'ses_missing' }))).rejects.toThrow(
      /cannot resume opencode session ses_missing: gone/,
    );
    expect(sessionCreateMock).not.toHaveBeenCalled();
  });
});
