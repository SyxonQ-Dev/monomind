/**
 * Coder mode on pi: tool_execution_start/end (pi 0.87 docs/json.md shapes)
 * become matched tool_use/tool_result pairs; the `session` header id resumes
 * later invocations with --session; assistant message cost is summed into
 * the result; coder mode keeps pi's own session store; effort → --thinking.
 */
import * as cp from 'node:child_process';
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AgentMessage, AgentRunArgs } from '../../src/orgrt/agent-runner.js';
import { PiAgentRunner } from '../../src/orgrt/pi-runner.js';
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
const usage = (cost: number) => ({ input: 10, output: 4, cost: { total: cost } });
const TURN = (sid: string, text = 'done') => [
  j({ type: 'session', version: 3, id: sid, cwd: '/w' }),
  j({ type: 'agent_start' }),
  j({ type: 'message_end', message: { role: 'user', content: 'go' } }),
  j({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'bash' }], usage: usage(0.01) } }),
  j({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: { command: 'ls -la' } }),
  j({ type: 'tool_execution_update', toolCallId: 'c1', toolName: 'bash', partialResult: { content: [] } }),
  j({
    type: 'tool_execution_end',
    toolCallId: 'c1',
    toolName: 'bash',
    result: { content: [{ type: 'text', text: 'complete output' }], details: {} },
    isError: false,
  }),
  j({ type: 'tool_execution_start', toolCallId: 'c2', toolName: 'edit', args: { path: 'a.ts', edits: [{ oldText: 'x', newText: 'y' }] } }),
  j({ type: 'tool_execution_end', toolCallId: 'c2', toolName: 'edit', result: { content: [{ type: 'text', text: 'no match' }] }, isError: true }),
  j({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }], usage: usage(0.02) } }),
  j({ type: 'agent_end', messages: [] }),
];

function args(extra: Partial<AgentRunArgs> = {}): AgentRunArgs {
  return {
    tools: [],
    prompt: (async function* () {
      yield 'go';
    })(),
    systemPrompt: 'SYS',
    cwd: '/w',
    env: {},
    maxTurns: 5,
    ...extra,
  };
}

async function collect(extra: Partial<AgentRunArgs> = {}): Promise<AgentMessage[]> {
  const out: AgentMessage[] = [];
  for await (const m of new PiAgentRunner('/bin/pi').run(args(extra))) out.push(m);
  return out;
}

const argvAt = (i: number) => vi.mocked(cp.spawn).mock.calls[i]?.[1] as string[];

describe('PiAgentRunner coder mode', () => {
  beforeEach(() => vi.clearAllMocks());

  it('pairs tool_execution_start/end by toolCallId with canonical inputs, errors and outputs', async () => {
    vi.mocked(cp.spawn).mockReturnValue(mockChild(TURN('s-1')));
    const msgs = await collect();
    const starts = msgs.filter((m) => m.type === 'tool_use' && m.tool_use_id);
    expect(starts.map((m) => [m.tool_use_id, m.tool, (m as { kind?: string }).kind, m.input])).toEqual([
      ['c1', 'bash', 'shell', { command: 'ls -la' }],
      ['c2', 'edit', 'edit', { file_path: 'a.ts', old_string: 'x', new_string: 'y' }],
    ]);
    const ends = msgs.filter((m) => m.type === 'tool_result');
    expect(ends.map((m) => [m.tool_use_id, m.is_error, m.text])).toEqual([
      ['c1', false, 'complete output'],
      ['c2', true, 'no match'],
    ]);
  });

  it('reports the session id and the summed assistant cost on the result', async () => {
    vi.mocked(cp.spawn).mockReturnValue(mockChild(TURN('s-1')));
    const msgs = await collect();
    const result = msgs.at(-1);
    expect(result).toMatchObject({ type: 'result', session_id: 's-1' });
    expect(result?.cost_usd).toBeCloseTo(0.03, 10);
  });

  it('continues the same session on a tool round with --session-id <id>', async () => {
    const tool = {
      name: 'org_echo',
      description: 'echo',
      schema: { text: z.string() },
      handler: async (a: Record<string, unknown>) => ({ text: String(a.text) }),
    };
    const fence = '```tool_call\n{"name":"org_echo","arguments":{"text":"hi"}}\n```';
    vi.mocked(cp.spawn)
      .mockReturnValueOnce(mockChild(TURN('s-7', fence)))
      .mockReturnValueOnce(mockChild(TURN('s-7')));
    await collect({ tools: [tool], canUseTool: async () => ({ behavior: 'allow' }) });
    const first = argvAt(0);
    const second = argvAt(1);
    const id = first[first.indexOf('--session-id') + 1];
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    // The header's id wins from then on (it equals the requested id live).
    expect(second[second.indexOf('--session-id') + 1]).toBe('s-7');
  });

  it('AgentRunArgs.resume seeds --session-id and skips re-sending the system prompt', async () => {
    vi.mocked(cp.spawn).mockReturnValue(mockChild(TURN('old')));
    await collect({ resume: 'old' });
    const a = argvAt(0);
    expect(a[a.indexOf('--session-id') + 1]).toBe('old');
    expect(a).not.toContain('--session');
    expect(a.slice(-2)).toEqual(['--', 'go']);
  });

  it('never points pi at a session directory in the project (sessions stay in pi’s own store)', async () => {
    vi.mocked(cp.spawn).mockReturnValue(mockChild(TURN('s')));
    await collect();
    vi.mocked(cp.spawn).mockReturnValue(mockChild(TURN('s')));
    await collect({ access: 'full' });
    for (const a of [argvAt(0), argvAt(1)]) {
      expect(a).not.toContain('--session-dir');
      expect(a.join(' ')).not.toContain('.monomind-pi-session');
    }
    const opts = vi.mocked(cp.spawn).mock.calls[1]?.[2] as cp.SpawnOptions;
    expect(opts.detached).toBe(process.platform !== 'win32');
  });

  it('--settings sources trust the project (--approve); otherwise the run is isolated', async () => {
    vi.mocked(cp.spawn).mockReturnValue(mockChild(TURN('s')));
    await collect({ access: 'full', settingSources: ['user', 'project'] });
    vi.mocked(cp.spawn).mockReturnValue(mockChild(TURN('s')));
    await collect({ access: 'full' });
    const coder = argvAt(0);
    expect(coder).toContain('--approve');
    expect(coder).not.toContain('--no-approve');
    expect(coder).not.toContain('-nc');
    const isolated = argvAt(1);
    expect(isolated).not.toContain('--approve');
    for (const f of ['--no-approve', '-ne', '-ns', '-np', '-nc']) expect(isolated).toContain(f);
  });

  it('maps effort onto --thinking 1:1', async () => {
    vi.mocked(cp.spawn).mockReturnValue(mockChild(TURN('s')));
    await collect({ effort: 'xhigh' });
    const a = argvAt(0);
    expect(a[a.indexOf('--thinking') + 1]).toBe('xhigh');
  });
});

/** A pi turn with no native tools: the assistant just writes `text`. */
const TEXT_TURN = (sid: string, text: string) => [
  j({ type: 'session', version: 3, id: sid, cwd: '/w' }),
  j({ type: 'agent_start' }),
  j({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }], usage: usage(0.01) } }),
  j({ type: 'agent_end', messages: [] }),
];

describe('#389 pi: full access + stdio caller tools', () => {
  beforeEach(() => vi.clearAllMocks());

  it('a full-access turn calls a stdio tool and gets the result back', async () => {
    vi.mocked(cp.spawn)
      .mockReturnValueOnce(mockChild(TEXT_TURN('s-389', `Checking.\n${callerFence('core')}`)))
      .mockReturnValueOnce(mockChild(TEXT_TURN('s-389', 'done')));
    const turn = await runFullAccessToolTurn('pi', new PiAgentRunner('/bin/pi'));
    expectCallerRoundTrip(turn, ['core']);
    expect(vi.mocked(cp.spawn).mock.calls).toHaveLength(2);
    // Tool protocol in the first prompt, the caller's answer in the resumed one.
    expect(argvAt(0).at(-1)).toContain('org_roster');
    expect(argvAt(1).at(-1)).toContain(rosterResult('core'));
    expect(argvAt(1)[argvAt(1).indexOf('--session-id') + 1]).toBe('s-389');
    const opts = vi.mocked(cp.spawn).mock.calls[0]?.[2] as cp.SpawnOptions;
    expect(opts.detached).toBe(process.platform !== 'win32');
  });

  it('two parallel caller calls: both tool_call frames before either tool_result', async () => {
    vi.mocked(cp.spawn)
      .mockReturnValueOnce(mockChild(TEXT_TURN('s-389', `${callerFence('core')}\n${callerFence('qa')}`)))
      .mockReturnValueOnce(mockChild(TEXT_TURN('s-389', 'done')));
    const turn = await runFullAccessToolTurn('pi', new PiAgentRunner('/bin/pi'), { expectCalls: 2 });
    expectCallerRoundTrip(turn, ['core', 'qa']);
    expectAllCallsBeforeResults(turn, 2);
    expect(argvAt(1).at(-1)).toContain(rosterResult('core'));
    expect(argvAt(1).at(-1)).toContain(rosterResult('qa'));
  });
});
