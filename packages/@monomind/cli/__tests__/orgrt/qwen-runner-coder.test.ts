/**
 * Coder mode on qwen: qwen-code's Claude-compatible stream-json carries its
 * own tool calls (assistant tool_use blocks) and results (user tool_result
 * blocks with is_error) — they become matched tool_use/tool_result pairs.
 * Full access keeps --yolo and spawns qwen as a process-group leader.
 */
import * as cp from 'node:child_process';
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage, AgentRunArgs } from '../../src/orgrt/agent-runner.js';
import { QwenAgentRunner } from '../../src/orgrt/qwen-runner.js';
import { parseQwenEvents } from '../../src/orgrt/qwen-runner.js';
import {
  callerFence,
  expectAllCallsBeforeResults,
  expectCallerRoundTrip,
  rosterResult,
  runFullAccessToolTurn,
} from '../../src/__tests__/caller-tool-turn.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

function mockChild(lines: string[]): cp.ChildProcess {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stdout[Symbol.asyncIterator] = async function* () {
    for (const line of lines) yield Buffer.from(`${line}\n`);
  };
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  child.exitCode = 0;
  setTimeout(() => child.emit('close', 0), 5);
  return child as cp.ChildProcess;
}

const j = JSON.stringify;
const TURN = [
  j({ type: 'system', subtype: 'init', session_id: 'q1' }),
  j({
    type: 'assistant',
    session_id: 'q1',
    message: {
      content: [
        { type: 'text', text: 'Running it.' },
        { type: 'tool_use', id: 'call_a', name: 'run_shell_command', input: { command: 'ls', directory: '/w' } },
      ],
    },
  }),
  j({
    type: 'user',
    session_id: 'q1',
    parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_a', is_error: false, content: 'a.txt' }] },
  }),
  j({
    type: 'assistant',
    session_id: 'q1',
    message: { content: [{ type: 'tool_use', id: 'call_b', name: 'write_file', input: { file_path: '/w/b', content: 'hi' } }] },
  }),
  j({
    type: 'user',
    session_id: 'q1',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_b', is_error: true, content: 'denied' }] },
  }),
  j({ type: 'assistant', session_id: 'q1', message: { content: [{ type: 'text', text: 'Done.' }] } }),
  j({ type: 'result', subtype: 'success', session_id: 'q1', usage: { input_tokens: 9, output_tokens: 3 } }),
];

async function collect(extra: Partial<AgentRunArgs> = {}): Promise<AgentMessage[]> {
  const out: AgentMessage[] = [];
  const args: AgentRunArgs = {
    tools: [],
    prompt: (async function* () {
      yield 'go';
    })(),
    systemPrompt: 'sys',
    cwd: '/w',
    env: {},
    maxTurns: 5,
    ...extra,
  };
  for await (const m of new QwenAgentRunner('/bin/qwen').run(args)) out.push(m);
  return out;
}

describe('QwenAgentRunner coder mode', () => {
  beforeEach(() => vi.clearAllMocks());

  it('pairs tool_use blocks with user tool_result blocks by id, canonical inputs', async () => {
    vi.mocked(cp.spawn).mockReturnValue(mockChild(TURN));
    const msgs = await collect();
    const starts = msgs.filter((m) => m.type === 'tool_use' && m.tool_use_id);
    expect(starts.map((m) => [m.tool_use_id, m.tool, (m as { kind?: string }).kind, m.input])).toEqual([
      ['call_a', 'run_shell_command', 'shell', { command: 'ls', cwd: '/w' }],
      ['call_b', 'write_file', 'write', { file_path: '/w/b', content: 'hi' }],
    ]);
    const ends = msgs.filter((m) => m.type === 'tool_result');
    expect(ends.map((m) => [m.tool_use_id, m.is_error, m.text])).toEqual([
      ['call_a', false, 'a.txt'],
      ['call_b', true, 'denied'],
    ]);
    expect(msgs.filter((m) => m.type === 'assistant').map((m) => m.text)).toEqual(['Running it.', 'Done.']);
    expect(msgs.at(-1)).toMatchObject({ type: 'result', session_id: 'q1', input_tokens: 9, output_tokens: 3 });
  });

  it('keeps the batch parser’s text-only view (tool blocks never become assistant text)', () => {
    expect(parseQwenEvents(TURN).texts).toEqual(['Running it.', 'Done.']);
  });

  it('full access: --yolo and a process-group (detached) spawn', async () => {
    vi.mocked(cp.spawn).mockReturnValue(mockChild(TURN));
    await collect({ access: 'full' });
    const [, argv, opts] = vi.mocked(cp.spawn).mock.calls[0] as [string, string[], cp.SpawnOptions];
    expect(argv).toContain('--yolo');
    expect(opts.detached).toBe(process.platform !== 'win32');
  });
});

// One qwen invocation whose only assistant message says `text`.
const qwenTurn = (text: string) => [
  j({ type: 'system', subtype: 'init', session_id: 'q1' }),
  j({ type: 'assistant', session_id: 'q1', message: { content: [{ type: 'text', text }] } }),
  j({ type: 'result', subtype: 'success', session_id: 'q1', usage: { input_tokens: 1, output_tokens: 1 } }),
];

describe('#389 qwen: full access + stdio caller tools', () => {
  beforeEach(() => vi.clearAllMocks());

  const promptAt = (i: number) => {
    const a = vi.mocked(cp.spawn).mock.calls[i][1] as string[];
    return a[a.indexOf('-p') + 1];
  };

  it('a full-access turn calls a stdio tool and gets the result back', async () => {
    vi.mocked(cp.spawn)
      .mockReturnValueOnce(mockChild(qwenTurn(`Checking.\n${callerFence('core')}`)))
      .mockReturnValueOnce(mockChild(qwenTurn('done')));
    const turn = await runFullAccessToolTurn('qwen', new QwenAgentRunner('/bin/qwen'));
    expectCallerRoundTrip(turn, ['core']);
    const calls = vi.mocked(cp.spawn).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][1]).toContain('--yolo');
    expect((calls[0][2] as cp.SpawnOptions).detached).toBe(process.platform !== 'win32');
    // Tool protocol in the first prompt, the caller's answer in the resumed one.
    expect(promptAt(0)).toContain('org_roster');
    expect(promptAt(1)).toContain(rosterResult('core'));
    expect(calls[1][1]).toEqual(expect.arrayContaining(['--resume', 'q1']));
  });

  it('two parallel caller calls: both tool_call frames before either tool_result', async () => {
    vi.mocked(cp.spawn)
      .mockReturnValueOnce(mockChild(qwenTurn(`${callerFence('core')}\n${callerFence('qa')}`)))
      .mockReturnValueOnce(mockChild(qwenTurn('done')));
    const turn = await runFullAccessToolTurn('qwen', new QwenAgentRunner('/bin/qwen'), {
      expectCalls: 2,
    });
    expectCallerRoundTrip(turn, ['core', 'qa']);
    expectAllCallsBeforeResults(turn, 2);
    expect(promptAt(1)).toContain(rosterResult('core'));
    expect(promptAt(1)).toContain(rosterResult('qa'));
  });
});
