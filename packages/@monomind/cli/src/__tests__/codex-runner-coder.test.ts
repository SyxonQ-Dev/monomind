/**
 * CodexAgentRunner — coder mode on every runtime (rev 13): full-access argv,
 * effort mapping, process-group spawn, and codex's own tool items mapped to
 * matched tool_use/tool_result pairs with contract §4 canonical inputs.
 *
 * FIXTURE is a live capture (codex-cli 0.156.1, `codex exec --json` in a
 * scratch dir: one shell command, two apply_patch edits). The mcp_tool_call
 * / web_search / failure lines follow codex's documented exec item schema.
 * No real codex is spawned — child_process.spawn is mocked.
 */

import * as cp from 'node:child_process';
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage } from '../orgrt/agent-runner.js';
import { CodexAgentRunner } from '../orgrt/codex-runner.js';
import { codexEffortArgs } from '../orgrt/codex-runner-tools.js';
import { EXEC_TREE_ENV } from '../orgrt/process-tree-marker.js';
import { ToolActivityTracker } from '../orgrt/tool-activity.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

const FIXTURE = [
  '{"type":"thread.started","thread_id":"01a0ec38-e6e3-72a2-b0b6-770cf0eceb93"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"I’ll run the requested probe command, then make both file edits using patches."}}',
  '{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"/usr/bin/bash -lc \'echo probe\'","aggregated_output":"","exit_code":null,"status":"in_progress"}}',
  '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"/usr/bin/bash -lc \'echo probe\'","aggregated_output":"probe\\n","exit_code":0,"status":"completed"}}',
  '{"type":"item.started","item":{"id":"item_2","type":"file_change","changes":[{"path":"/home/monoes/scratch/codex-probe/note.txt","kind":"add"}],"status":"in_progress"}}',
  '{"type":"item.completed","item":{"id":"item_2","type":"file_change","changes":[{"path":"/home/monoes/scratch/codex-probe/note.txt","kind":"add"}],"status":"completed"}}',
  '{"type":"item.started","item":{"id":"item_3","type":"file_change","changes":[{"path":"/home/monoes/scratch/codex-probe/note.txt","kind":"update"}],"status":"in_progress"}}',
  '{"type":"item.completed","item":{"id":"item_3","type":"file_change","changes":[{"path":"/home/monoes/scratch/codex-probe/note.txt","kind":"update"}],"status":"completed"}}',
  '{"type":"item.completed","item":{"id":"item_4","type":"agent_message","text":"done"}}',
  '{"type":"turn.completed","usage":{"input_tokens":55766,"cached_input_tokens":46080,"cache_write_input_tokens":0,"output_tokens":228,"reasoning_output_tokens":0}}',
];

function mockChild(lines: string[], exitCode = 0): cp.ChildProcess {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stdout[Symbol.asyncIterator] = async function* () {
    for (const line of lines) yield Buffer.from(`${line}\n`);
  };
  child.stderr = new EventEmitter();
  child.stdin = { on: vi.fn(), end: vi.fn(), write: vi.fn() };
  child.kill = vi.fn();
  child.exitCode = null;
  child.signalCode = null;
  setTimeout(() => {
    child.exitCode = exitCode;
    child.emit('close', exitCode);
  }, 5);
  return child as cp.ChildProcess;
}

function runArgs(overrides: Record<string, unknown> = {}, prompts = ['do work']) {
  return {
    tools: [],
    prompt: (async function* () {
      for (const p of prompts) yield p;
    })(),
    systemPrompt: 'test role',
    cwd: '/work/repo',
    env: {},
    maxTurns: 5,
    ...overrides,
  } as any;
}

async function collect(it: AsyncIterable<AgentMessage>): Promise<AgentMessage[]> {
  const out: AgentMessage[] = [];
  for await (const m of it) out.push(m);
  return out;
}

const argvOf = (call = 0) => vi.mocked(cp.spawn).mock.calls[call][1] as string[];
const optsOf = (call = 0) => vi.mocked(cp.spawn).mock.calls[call][2] as cp.SpawnOptions;

describe('CodexAgentRunner coder mode: argv', () => {
  const runner = new CodexAgentRunner('/usr/bin/codex');
  beforeEach(() => vi.clearAllMocks());

  it('full access: bypass flag replaces --sandbox, keeps --cd/--json, spawns a process group', async () => {
    vi.mocked(cp.spawn).mockReturnValue(mockChild(FIXTURE));
    await collect(runner.run(runArgs({ access: 'full' })));
    const argv = argvOf();
    expect(argv).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(argv).not.toContain('--sandbox');
    expect(argv).not.toContain('danger-full-access');
    expect(argv.slice(0, 2)).toEqual(['exec', '--json']);
    expect(argv[argv.indexOf('--cd') + 1]).toBe('/work/repo');
    expect(argv.slice(-2)).toEqual(['--', '-']);
    if (process.platform !== 'win32') expect(optsOf().detached).toBe(true);
    expect((optsOf().env as Record<string, string>)[EXEC_TREE_ENV]).toBeTruthy();
  });

  it('full access + resume: global flags precede the resume subcommand', async () => {
    vi.mocked(cp.spawn).mockReturnValue(mockChild(FIXTURE));
    await collect(runner.run(runArgs({ access: 'full', resume: 'thread-9' })));
    const argv = argvOf();
    const bypass = argv.indexOf('--dangerously-bypass-approvals-and-sandbox');
    expect(bypass).toBeGreaterThan(0);
    expect(argv.slice(bypass + 1)).toEqual(['resume', 'thread-9', '--', '-']);
  });

  it('scoped (default): keeps the policy sandbox and a plain spawn', async () => {
    vi.mocked(cp.spawn).mockReturnValue(mockChild(FIXTURE));
    await collect(runner.run(runArgs()));
    const argv = argvOf();
    expect(argv).toContain('--sandbox');
    expect(argv).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(optsOf().detached).toBeUndefined();
    expect((optsOf().env as Record<string, string>)[EXEC_TREE_ENV]).toBeUndefined();
  });

  it('settings: never isolates the user codex config (no CODEX_HOME override, no --ignore-user-config)', async () => {
    vi.mocked(cp.spawn).mockReturnValue(mockChild(FIXTURE));
    await collect(runner.run(runArgs({ access: 'full', settingSources: ['user', 'project'] })));
    expect(argvOf()).not.toContain('--ignore-user-config');
    const env = optsOf().env as Record<string, string | undefined>;
    expect(env.CODEX_HOME).toBe(process.env.CODEX_HOME);
  });

  it('effort: -c model_reasoning_effort=<level>; off maps to none; unset adds nothing', async () => {
    vi.mocked(cp.spawn).mockReturnValue(mockChild(FIXTURE));
    await collect(runner.run(runArgs({ effort: 'xhigh' })));
    const argv = argvOf();
    expect(argv[argv.indexOf('-c', 2) + 1]).toBe('model_reasoning_effort=xhigh');
    expect(codexEffortArgs('off')).toEqual(['-c', 'model_reasoning_effort=none']);
    expect(codexEffortArgs('max')).toEqual(['-c', 'model_reasoning_effort=max']);
    expect(codexEffortArgs(undefined)).toEqual([]);
  });
});

describe('CodexAgentRunner coder mode: tool events', () => {
  const runner = new CodexAgentRunner('/usr/bin/codex');
  beforeEach(() => vi.clearAllMocks());

  it('live fixture: matched shell + patch pairs with canonical inputs', async () => {
    vi.mocked(cp.spawn).mockReturnValue(mockChild(FIXTURE));
    const msgs = await collect(runner.run(runArgs({ access: 'full' })));
    const starts = msgs.filter((m) => m.type === 'tool_use' && m.tool_use_id);
    const ends = msgs.filter((m) => m.type === 'tool_result');
    expect(starts.map((m) => m.tool_use_id)).toEqual(ends.map((m) => m.tool_use_id));
    expect(starts.map((m) => m.tool_use_id)).toEqual([
      'codex_1_item_1',
      'codex_1_item_2',
      'codex_1_item_3',
    ]);

    expect(starts[0]).toMatchObject({
      tool: 'command_execution',
      kind: 'shell',
      input: { command: "/usr/bin/bash -lc 'echo probe'" },
      text: "/usr/bin/bash -lc 'echo probe'",
    });
    expect(ends[0]).toMatchObject({ is_error: false, text: 'probe\n', exit_code: 0 });
    expect(typeof ends[0].duration_ms).toBe('number');

    expect(starts[1]).toMatchObject({
      tool: 'file_change',
      kind: 'patch',
      input: { files: [{ file_path: '/home/monoes/scratch/codex-probe/note.txt', action: 'add' }] },
    });
    expect(starts[2].input).toEqual({
      files: [{ file_path: '/home/monoes/scratch/codex-probe/note.txt', action: 'update' }],
    });
    expect(ends[2]).toMatchObject({ is_error: false });
    expect(ends[2].exit_code).toBeUndefined();

    // Assistant text and the synthesized result are unchanged.
    expect(msgs.filter((m) => m.type === 'assistant').map((m) => m.text)).toEqual([
      'I’ll run the requested probe command, then make both file edits using patches.',
      'done',
    ]);
    expect(msgs.at(-1)).toMatchObject({ type: 'result', input_tokens: 55766, output_tokens: 228 });
  });

  it('feeds ToolActivityTracker full start/end pairs with kind and exit_code, no stray starts', async () => {
    vi.mocked(cp.spawn).mockReturnValue(mockChild(FIXTURE));
    const events: Record<string, any>[] = [];
    const tracker = new ToolActivityTracker((ev) => events.push(ev), 'full');
    for await (const m of runner.run(runArgs({ access: 'full' }))) tracker.onMessage(m);
    expect(events.map((e) => `${e.phase}:${e.id}`)).toEqual([
      'start:codex_1_item_1',
      'end:codex_1_item_1',
      'start:codex_1_item_2',
      'end:codex_1_item_2',
      'start:codex_1_item_3',
      'end:codex_1_item_3',
    ]);
    expect(events[0]).toMatchObject({ name: 'command_execution', kind: 'shell' });
    expect(events[1]).toMatchObject({ ok: true, output: 'probe\n', exit_code: 0 });
    expect(events[2]).toMatchObject({ kind: 'patch' });
  });

  it('mcp, web search (completion only), failed command, and an unfinished call', async () => {
    vi.mocked(cp.spawn).mockReturnValue(
      mockChild([
        '{"type":"thread.started","thread_id":"t-2"}',
        '{"type":"item.started","item":{"id":"item_0","type":"mcp_tool_call","server":"docs","tool":"search","arguments":{"q":"x"},"status":"in_progress"}}',
        '{"type":"item.completed","item":{"id":"item_0","type":"mcp_tool_call","server":"docs","tool":"search","arguments":{"q":"x"},"result":{"content":[{"type":"text","text":"hit"}]},"status":"completed"}}',
        '{"type":"item.completed","item":{"id":"item_1","type":"web_search","query":"codex flags"}}',
        '{"type":"item.started","item":{"id":"item_2","type":"command_execution","command":"false","aggregated_output":"","exit_code":null,"status":"in_progress"}}',
        '{"type":"item.completed","item":{"id":"item_2","type":"command_execution","command":"false","aggregated_output":"","exit_code":1,"status":"failed"}}',
        '{"type":"item.started","item":{"id":"item_3","type":"reasoning","text":"thinking"}}',
        '{"type":"item.started","item":{"id":"item_4","type":"command_execution","command":"sleep 99","aggregated_output":"","exit_code":null,"status":"in_progress"}}',
        '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}',
      ]),
    );
    const msgs = await collect(runner.run(runArgs({ access: 'full' })));
    const starts = msgs.filter((m) => m.type === 'tool_use' && m.tool_use_id);
    const ends = msgs.filter((m) => m.type === 'tool_result');

    expect(starts.map((m) => m.kind)).toEqual(['mcp', 'web', 'shell', 'shell']);
    expect(starts[0].input).toEqual({ server: 'docs', tool: 'search', arguments: { q: 'x' } });
    expect(ends[0]).toMatchObject({ tool_use_id: 'codex_1_item_0', is_error: false, text: 'hit' });
    expect(starts[1].input).toEqual({ query: 'codex flags' });
    expect(ends[1]).toMatchObject({ tool_use_id: 'codex_1_item_1', is_error: false });
    expect(ends[2]).toMatchObject({ tool_use_id: 'codex_1_item_2', is_error: true, exit_code: 1 });
    // reasoning is not a tool call; the never-completed call gets a failed end.
    expect(starts.some((m) => m.tool === 'reasoning')).toBe(false);
    expect(ends[3]).toMatchObject({ tool_use_id: 'codex_1_item_4', is_error: true });
    expect(ends).toHaveLength(4);
  });

  it('ids stay unique across spawns (codex restarts item numbering per process)', async () => {
    vi.mocked(cp.spawn)
      .mockReturnValueOnce(mockChild(FIXTURE))
      .mockReturnValueOnce(mockChild(FIXTURE));
    const msgs = await collect(runner.run(runArgs({ access: 'full' }, ['one', 'two'])));
    const ids = msgs
      .filter((m) => m.type === 'tool_use' && m.tool_use_id)
      .map((m) => m.tool_use_id);
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(6);
    expect(ids[3]).toBe('codex_2_item_1');
  });

  it('turn.failed surfaces as a turn error', async () => {
    vi.mocked(cp.spawn).mockReturnValue(
      mockChild([
        '{"type":"thread.started","thread_id":"t-3"}',
        '{"type":"turn.failed","error":{"message":"Invalid value: \'bogus\'"}}',
      ]),
    );
    await expect(collect(runner.run(runArgs()))).rejects.toThrow(/Invalid value/);
  });
});
