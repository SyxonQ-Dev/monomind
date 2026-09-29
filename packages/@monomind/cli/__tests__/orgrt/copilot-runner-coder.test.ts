/**
 * Coder mode on copilot: tool.execution_start/complete (live copilot 1.0.88
 * capture, trimmed) become matched tool_use/tool_result pairs; the closing
 * `result` line's sessionId resumes later invocations; full access runs
 * --allow-all; effort maps onto --reasoning-effort.
 */
import * as cp from 'node:child_process';
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AgentMessage, AgentRunArgs } from '../../src/orgrt/agent-runner.js';
import { CopilotAgentRunner } from '../../src/orgrt/copilot-runner.js';
import {
  callerFence,
  expectAllCallsBeforeResults,
  expectCallerRoundTrip,
  rosterResult,
  runFullAccessToolTurn,
} from '../../src/__tests__/caller-tool-turn.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

function mockChild(lines: string[], exitCode = 0, stderr = ''): cp.ChildProcess {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stdout[Symbol.asyncIterator] = async function* () {
    if (stderr) child.stderr.emit('data', Buffer.from(stderr));
    for (const line of lines) yield Buffer.from(`${line}\n`);
  };
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  child.exitCode = exitCode;
  setTimeout(() => child.emit('close', exitCode), 5);
  return child as cp.ChildProcess;
}

const j = JSON.stringify;
const ID = 'call_id5WboCBENYUnFPts1upEwEP';
const LIVE = [
  j({ type: 'assistant.turn_start', data: { turnId: '0' } }),
  j({
    type: 'assistant.tool_call_delta',
    data: { toolCallId: ID, toolName: 'bash', inputDelta: '{"' },
    ephemeral: true,
  }),
  j({
    type: 'assistant.message',
    data: { content: '', toolRequests: [{ toolCallId: ID, name: 'bash', arguments: { command: 'ls' } }] },
  }),
  j({
    type: 'tool.execution_start',
    data: { toolCallId: ID, toolName: 'bash', arguments: { command: 'ls', description: 'List files', mode: 'sync' } },
  }),
  j({ type: 'tool.execution_partial_result', data: { toolCallId: ID, partialOutput: 'a.txt\n' }, ephemeral: true }),
  j({
    type: 'tool.execution_complete',
    data: {
      toolCallId: ID,
      success: true,
      shellExecution: { exitCode: 0 },
      result: { content: 'a.txt\n<shellId: 0 completed with exit code 0>' },
    },
  }),
  j({ type: 'assistant.message', data: { content: 'done', toolRequests: [] } }),
  j({ type: 'result', sessionId: 'e579b79b-b24d-4397-ae21-ec2d437cc029', exitCode: 0, usage: { premiumRequests: 1 } }),
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
  for await (const m of new CopilotAgentRunner('/bin/copilot').run(args(extra))) out.push(m);
  return out;
}

const argvAt = (i: number) => vi.mocked(cp.spawn).mock.calls[i]?.[1] as string[];

describe('CopilotAgentRunner coder mode', () => {
  beforeEach(() => vi.clearAllMocks());

  it('pairs tool.execution_start with tool.execution_complete and reports the session id', async () => {
    vi.mocked(cp.spawn).mockReturnValue(mockChild(LIVE));
    const msgs = await collect();
    const starts = msgs.filter((m) => m.type === 'tool_use' && m.tool_use_id);
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({
      tool_use_id: ID,
      tool: 'bash',
      kind: 'shell',
      input: { command: 'ls', description: 'List files' },
    });
    const ends = msgs.filter((m) => m.type === 'tool_result');
    expect(ends).toEqual([
      expect.objectContaining({
        tool_use_id: ID,
        is_error: false,
        exit_code: 0,
        text: expect.stringContaining('a.txt'),
      }),
    ]);
    expect(msgs.filter((m) => m.type === 'assistant').map((m) => m.text)).toEqual(['done']);
    expect(msgs.at(-1)).toMatchObject({ type: 'result', session_id: 'e579b79b-b24d-4397-ae21-ec2d437cc029' });
  });

  it('a failed tool call ends with is_error', async () => {
    vi.mocked(cp.spawn).mockReturnValue(
      mockChild([
        j({ type: 'tool.execution_start', data: { toolCallId: 't1', toolName: 'view', arguments: { path: '/x' } } }),
        j({ type: 'tool.execution_complete', data: { toolCallId: 't1', success: false, result: { content: 'no such file' } } }),
        j({ type: 'result', sessionId: 's1', exitCode: 0 }),
      ]),
    );
    const msgs = await collect();
    expect(msgs.find((m) => m.type === 'tool_use' && m.tool_use_id)).toMatchObject({ kind: 'read', input: { file_path: '/x' } });
    const end = msgs.find((m) => m.type === 'tool_result');
    expect(end).toMatchObject({ is_error: true, text: 'no such file' });
    expect(end).not.toHaveProperty('exit_code');
  });

  it('resumes the captured session on the next tool round and stops re-sending the system prompt', async () => {
    const tool = {
      name: 'org_echo',
      description: 'echo',
      schema: { text: z.string() },
      handler: async (a: Record<string, unknown>) => ({ text: String(a.text) }),
    };
    const fence = '```tool_call\n{"name":"org_echo","arguments":{"text":"hi"}}\n```';
    vi.mocked(cp.spawn)
      .mockReturnValueOnce(
        mockChild([j({ type: 'assistant.message', data: { content: fence } }), j({ type: 'result', sessionId: 'sess-9' })]),
      )
      .mockReturnValueOnce(
        mockChild([j({ type: 'assistant.message', data: { content: 'final' } }), j({ type: 'result', sessionId: 'sess-9' })]),
      );
    await collect({ tools: [tool], canUseTool: async () => ({ behavior: 'allow' }) });
    const first = argvAt(0);
    const second = argvAt(1);
    expect(first.some((a) => a.startsWith('--resume'))).toBe(false);
    expect(first[first.indexOf('-p') + 1].startsWith('SYS')).toBe(true);
    expect(second).toContain('--resume=sess-9');
    expect(second[second.indexOf('-p') + 1].startsWith('SYS')).toBe(false);
  });

  it('AgentRunArgs.resume seeds --resume on the first invocation', async () => {
    vi.mocked(cp.spawn).mockReturnValue(mockChild(LIVE));
    await collect({ resume: 'old-session' });
    expect(argvAt(0)).toContain('--resume=old-session');
  });

  it('retries without --reasoning-effort when the model refuses it (verified live on copilot 1.0.88)', async () => {
    vi.mocked(cp.spawn)
      .mockReturnValueOnce(
        mockChild([], 1, 'Error: Model "auto" does not support reasoning effort configuration (requested: "low").\n'),
      )
      .mockReturnValueOnce(mockChild(LIVE));
    const msgs = await collect({ effort: 'low' });
    expect(argvAt(0)).toContain('--reasoning-effort');
    expect(argvAt(1)).not.toContain('--reasoning-effort');
    expect(msgs.at(-1)).toMatchObject({ type: 'result', subtype: 'success' });
  });

  it('full access runs --allow-all; scoped keeps --allow-all-tools; effort maps 1:1 (off → none)', async () => {
    vi.mocked(cp.spawn).mockReturnValue(mockChild(LIVE));
    await collect();
    expect(argvAt(0)).toContain('--allow-all-tools');
    vi.mocked(cp.spawn).mockReturnValue(mockChild(LIVE));
    await collect({ access: 'full', effort: 'off' });
    const a = argvAt(1);
    expect(a).toContain('--allow-all');
    expect(a).not.toContain('--allow-all-tools');
    expect(a).toContain('--no-ask-user');
    expect(a[a.indexOf('--reasoning-effort') + 1]).toBe('none');
  });
});

// One copilot invocation whose only assistant.message says `text`.
const copilotTurn = (text: string) => [
  j({ type: 'assistant.message', data: { content: text, toolRequests: [] } }),
  j({ type: 'result', sessionId: 'sess-389', exitCode: 0 }),
];

describe('#389 copilot: full access + stdio caller tools', () => {
  beforeEach(() => vi.clearAllMocks());

  const promptAt = (i: number) => {
    const a = vi.mocked(cp.spawn).mock.calls[i][1] as string[];
    return a[a.indexOf('-p') + 1];
  };

  it('a full-access turn calls a stdio tool and gets the result back', async () => {
    vi.mocked(cp.spawn)
      .mockReturnValueOnce(mockChild(copilotTurn(`Checking.\n${callerFence('core')}`)))
      .mockReturnValueOnce(mockChild(copilotTurn('done')));
    const turn = await runFullAccessToolTurn('copilot', new CopilotAgentRunner('/bin/copilot'));
    expectCallerRoundTrip(turn, ['core']);
    const calls = vi.mocked(cp.spawn).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][1]).toContain('--allow-all');
    expect(calls[0][1]).not.toContain('--allow-all-tools');
    // Tool protocol in the first prompt, the caller's answer in the resumed one.
    expect(promptAt(0)).toContain('org_roster');
    expect(promptAt(1)).toContain(rosterResult('core'));
    expect(calls[1][1]).toContain('--resume=sess-389');
  });

  it('two parallel caller calls: both tool_call frames before either tool_result', async () => {
    vi.mocked(cp.spawn)
      .mockReturnValueOnce(mockChild(copilotTurn(`${callerFence('core')}\n${callerFence('qa')}`)))
      .mockReturnValueOnce(mockChild(copilotTurn('done')));
    const turn = await runFullAccessToolTurn('copilot', new CopilotAgentRunner('/bin/copilot'), {
      expectCalls: 2,
    });
    expectCallerRoundTrip(turn, ['core', 'qa']);
    expectAllCallsBeforeResults(turn, 2);
    expect(promptAt(1)).toContain(rosterResult('core'));
    expect(promptAt(1)).toContain(rosterResult('qa'));
  });
});
