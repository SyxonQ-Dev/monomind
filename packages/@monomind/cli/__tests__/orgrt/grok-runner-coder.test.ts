/**
 * Coder mode on grok: `streaming-messages-json` frames (Anthropic Messages
 * shape, per the docs bundled in grok 1.0.41) become assistant text, matched
 * tool_use/tool_result pairs and a result with usage and cost; full access
 * drops the policy.git sandbox; effort and max turns map onto grok's flags.
 */
import * as cp from 'node:child_process';
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage, AgentRunArgs } from '../../src/orgrt/agent-runner.js';
import { GrokAgentRunner } from '../../src/orgrt/grok-runner.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

function mockChild(lines: string[], exitCode = 0): cp.ChildProcess {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stdout[Symbol.asyncIterator] = async function* () {
    for (const line of lines) yield Buffer.from(`${line}\n`);
  };
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  child.exitCode = exitCode;
  setTimeout(() => child.emit('close', exitCode), 5);
  return child as cp.ChildProcess;
}

const j = JSON.stringify;
const TURN = [
  j({ type: 'system', subtype: 'init', session_id: 'abc123', tools: ['read_file', 'bash'] }),
  j({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Let me read the file.' },
        { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'src/main.rs' } },
      ],
    },
    parent_tool_use_id: null,
    session_id: 'abc123',
  }),
  j({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'fn main() {}', is_error: false }],
    },
    session_id: 'abc123',
  }),
  j({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'call_2', name: 'bash', input: { command: 'false' } }] },
    session_id: 'abc123',
  }),
  j({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_2', content: [{ type: 'text', text: 'exit 1' }], is_error: true }] },
    session_id: 'abc123',
  }),
  j({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] }, session_id: 'abc123' }),
  j({
    type: 'result',
    subtype: 'success',
    is_error: false,
    total_cost_usd: 0.0127,
    usage: { input_tokens: 812, output_tokens: 210 },
    session_id: 'abc123',
  }),
];

function args(extra: Partial<AgentRunArgs> = {}): AgentRunArgs {
  return {
    tools: [],
    prompt: (async function* () {
      yield 'go';
    })(),
    systemPrompt: 'sys',
    cwd: '/w',
    env: {},
    maxTurns: 7,
    ...extra,
  };
}

async function collect(extra: Partial<AgentRunArgs> = {}): Promise<AgentMessage[]> {
  const out: AgentMessage[] = [];
  for await (const m of new GrokAgentRunner('/bin/grok').run(args(extra))) out.push(m);
  return out;
}

const argv = () => vi.mocked(cp.spawn).mock.calls.at(-1)?.[1] as string[];

describe('GrokAgentRunner coder mode', () => {
  beforeEach(() => vi.clearAllMocks());

  it('parses streaming-messages-json: text, paired tool calls, usage, cost and session id', async () => {
    vi.mocked(cp.spawn).mockReturnValue(mockChild(TURN));
    const msgs = await collect();
    expect(argv()).toEqual(expect.arrayContaining(['--output-format', 'streaming-messages-json']));
    expect(msgs.filter((m) => m.type === 'assistant').map((m) => m.text)).toEqual([
      'Let me read the file.',
      'Done.',
    ]);
    const starts = msgs.filter((m) => m.type === 'tool_use' && m.tool_use_id);
    expect(starts.map((m) => [m.tool_use_id, m.tool, (m as { kind?: string }).kind])).toEqual([
      ['call_1', 'read_file', 'read'],
      ['call_2', 'bash', 'shell'],
    ]);
    expect(starts[0].input).toEqual({ file_path: 'src/main.rs' });
    const ends = msgs.filter((m) => m.type === 'tool_result');
    expect(ends.map((m) => [m.tool_use_id, m.is_error, m.text])).toEqual([
      ['call_1', false, 'fn main() {}'],
      ['call_2', true, 'exit 1'],
    ]);
    expect(msgs.at(-1)).toMatchObject({
      type: 'result',
      subtype: 'success',
      session_id: 'abc123',
      input_tokens: 812,
      output_tokens: 210,
      cost_usd: 0.0127,
    });
  });

  it('full access drops the policy.git sandbox; scoped keeps it', async () => {
    const env = { MONOMIND_GIT_LEVEL: 'read' };
    vi.mocked(cp.spawn).mockReturnValue(mockChild(TURN));
    await collect({ env });
    expect(argv()).toEqual(expect.arrayContaining(['--always-approve', '--sandbox', 'workspace']));
    vi.mocked(cp.spawn).mockReturnValue(mockChild(TURN));
    await collect({ env, access: 'full' });
    expect(argv()).toContain('--always-approve');
    expect(argv()).not.toContain('--sandbox');
  });

  it('maps effort and max turns onto grok flags', async () => {
    vi.mocked(cp.spawn).mockReturnValue(mockChild(TURN));
    await collect({ effort: 'max' });
    const a = argv();
    expect(a[a.indexOf('--reasoning-effort') + 1]).toBe('xhigh');
    expect(a[a.indexOf('--max-turns') + 1]).toBe('7');
  });

  it('reports hitting --max-turns as the result subtype, not a failure', async () => {
    vi.mocked(cp.spawn).mockReturnValue(
      mockChild(
        [
          j({ type: 'assistant', message: { content: [{ type: 'text', text: 'partial' }] }, session_id: 's' }),
          j({ type: 'result', subtype: 'error_max_turns', is_error: true, usage: { input_tokens: 1, output_tokens: 1 }, session_id: 's' }),
        ],
        1,
      ),
    );
    const msgs = await collect();
    expect(msgs.at(-1)).toMatchObject({ type: 'result', subtype: 'error_max_turns' });
  });

  it('surfaces an is_error result (e.g. not signed in) as a turn failure', async () => {
    vi.mocked(cp.spawn).mockReturnValue(
      mockChild(
        [
          j({ type: 'system', subtype: 'init', session_id: '' }),
          j({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['Not signed in.'] }),
        ],
        1,
      ),
    );
    await expect(collect()).rejects.toThrow(/Not signed in/);
  });
});
