/**
 * Coder mode on antigravity: agy's own tool steps become matched
 * tool_use/tool_result pairs, `--effort` maps onto `agy --effort`, and
 * `--access full` spawns agy as a process-group leader. The fixture lines are
 * a live `agy -p ... --output-format stream-json` capture (2026-09-29).
 */
import * as cp from 'node:child_process';
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage, AgentRunArgs } from '../../src/orgrt/agent-runner.js';
import { AntigravityAgentRunner } from '../../src/orgrt/antigravity-runner.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

function mockChild(lines: string[]): cp.ChildProcess {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stdout[Symbol.asyncIterator] = async function* () {
    for (const line of lines) yield Buffer.from(`${line}\n`);
  };
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  child.pid = undefined;
  child.exitCode = 0;
  setTimeout(() => child.emit('close', 0), 5);
  return child as cp.ChildProcess;
}

const CID = 'c0ec97ea-ed0b-4b68-be12-f4a1e4d7f24d';
const step = (s: Record<string, unknown>) =>
  JSON.stringify({ event: 'step_update', step_update: { conversation_id: CID, ...s } });
const LIVE = [
  JSON.stringify({ event: 'init', conversation_id: CID, init: { cwd: '/w', tools: [] } }),
  step({
    step_index: 2,
    state: 'ACTIVE',
    step_type: 'tool',
    tool_name: 'run_command',
    tool_info: { name: 'run_command', parameters: { CommandLine: 'ls' } },
  }),
  step({
    step_index: 2,
    state: 'DONE',
    step_type: 'tool',
    tool_name: 'run_command',
    duration_seconds: 0.019,
    tool_info: { name: 'run_command', parameters: { CommandLine: 'ls' }, output: 'a.txt\r\n' },
  }),
  step({
    step_index: 6,
    state: 'DONE',
    step_type: 'tool',
    tool_name: 'write_to_file',
    tool_info: { name: 'write_to_file', parameters: { TargetFile: '/w/b.txt' } },
  }),
  step({ step_index: 7, state: 'DONE', step_type: 'agent_response', text_delta: 'done' }),
  JSON.stringify({
    event: 'result',
    result: { conversation_id: CID, status: 'SUCCESS', usage: { input_tokens: 5, output_tokens: 2 } },
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
    maxTurns: 5,
    ...extra,
  };
}

async function collect(extra: Partial<AgentRunArgs> = {}): Promise<AgentMessage[]> {
  const out: AgentMessage[] = [];
  for await (const m of new AntigravityAgentRunner('/bin/agy').run(args(extra))) out.push(m);
  return out;
}

describe('AntigravityAgentRunner coder mode', () => {
  beforeEach(() => vi.clearAllMocks());

  it('pairs an ACTIVE tool step with its DONE step by step_index, with canonical input and output', async () => {
    vi.mocked(cp.spawn).mockReturnValue(mockChild(LIVE));
    const msgs = await collect();
    const tools = msgs.filter((m) => m.type === 'tool_use' && m.tool_use_id);
    const results = msgs.filter((m) => m.type === 'tool_result');
    expect(tools).toHaveLength(2);
    expect(tools[0]).toMatchObject({ tool: 'run_command', input: { command: 'ls' }, kind: 'shell', session_id: CID });
    expect(results[0]).toMatchObject({ tool_use_id: tools[0].tool_use_id, tool: 'run_command', text: 'a.txt\r\n', is_error: false });
    // A DONE step with no ACTIVE step before it still yields start then end.
    expect(tools[1]).toMatchObject({ tool: 'write_to_file', input: { file_path: '/w/b.txt' }, kind: 'write' });
    expect(results[1]).toMatchObject({ tool_use_id: tools[1].tool_use_id });
    expect(msgs.at(-1)).toMatchObject({ type: 'result', session_id: CID });
  });

  it('maps --effort onto agy --effort (xhigh rounds down, off → low) and omits it when unset', async () => {
    const argvFor = async (effort?: AgentRunArgs['effort']) => {
      vi.mocked(cp.spawn).mockReturnValue(mockChild(LIVE));
      await collect(effort ? { effort } : {});
      return vi.mocked(cp.spawn).mock.calls.at(-1)?.[1] as string[];
    };
    const high = await argvFor('xhigh');
    expect(high[high.indexOf('--effort') + 1]).toBe('high');
    const off = await argvFor('off');
    expect(off[off.indexOf('--effort') + 1]).toBe('low');
    expect(await argvFor()).not.toContain('--effort');
  });

  it('full access: skip-permissions flag and a process-group (detached) spawn', async () => {
    vi.mocked(cp.spawn).mockReturnValue(mockChild(LIVE));
    await collect({ access: 'full' });
    const [, argv, opts] = vi.mocked(cp.spawn).mock.calls[0] as [string, string[], cp.SpawnOptions];
    expect(argv).toContain('--dangerously-skip-permissions');
    expect(opts.detached).toBe(process.platform !== 'win32');
  });
});
