/**
 * Coder mode on crush: `crush run` already auto-approves every tool, so full
 * access changes no flag — it spawns crush as a process-group leader so a
 * cancel kills the whole tree. crush's plain-text output carries no native
 * tool events: its only tool_use messages are liveness pings with no call id.
 */
import * as cp from 'node:child_process';
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage, AgentRunArgs } from '../../src/orgrt/agent-runner.js';
import { CrushAgentRunner } from '../../src/orgrt/crush-runner.js';
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
  for await (const m of new CrushAgentRunner({ crushBin: '/bin/crush' }).run(args)) out.push(m);
  return out;
}

describe('CrushAgentRunner coder mode', () => {
  beforeEach(() => vi.clearAllMocks());

  it('full access: plain `crush run` argv, spawned detached as a process-group leader', async () => {
    vi.mocked(cp.spawn).mockReturnValue(mockChild(['all done']));
    await collect({ access: 'full' });
    const [, argv, opts] = vi.mocked(cp.spawn).mock.calls[0] as [string, string[], cp.SpawnOptions];
    expect(argv[0]).toBe('run');
    expect(argv).not.toContain('--yolo');
    expect(opts.detached).toBe(process.platform !== 'win32');
  });

  it('scoped access keeps a plain (non-detached) spawn', async () => {
    vi.mocked(cp.spawn).mockReturnValue(mockChild(['all done']));
    await collect();
    const opts = vi.mocked(cp.spawn).mock.calls[0]?.[2] as cp.SpawnOptions;
    expect(opts.detached).toBeUndefined();
  });

  it('emits no native tool call ids — only liveness pings', async () => {
    vi.mocked(cp.spawn).mockReturnValue(mockChild(['working', 'done']));
    const msgs = await collect({ access: 'full' });
    expect(msgs.some((m) => m.type === 'tool_use' && m.tool_use_id)).toBe(false);
    expect(msgs.some((m) => m.type === 'tool_result')).toBe(false);
  });
});

describe('#389 crush: full access + stdio caller tools', () => {
  beforeEach(() => vi.clearAllMocks());

  const argvAt = (i: number) => vi.mocked(cp.spawn).mock.calls[i]?.[1] as string[];

  it('a full-access turn calls a stdio tool and gets the result back', async () => {
    const children = [mockChild(['Checking.', ...callerFence('core').split('\n')]), mockChild(['done'])];
    vi.mocked(cp.spawn).mockImplementation(() => children.shift()!);
    const turn = await runFullAccessToolTurn('crush', new CrushAgentRunner({ crushBin: '/bin/crush' }));
    expectCallerRoundTrip(turn, ['core']);
    expect(vi.mocked(cp.spawn).mock.calls).toHaveLength(2);
    // Tool protocol in the first prompt, the caller's answer in the --continue one.
    expect(argvAt(0)[1]).toContain('org_roster');
    expect(argvAt(1)[1]).toContain(rosterResult('core'));
    expect(argvAt(1)).toContain('--continue');
    const opts = vi.mocked(cp.spawn).mock.calls[0]?.[2] as cp.SpawnOptions;
    expect(opts.detached).toBe(process.platform !== 'win32');
  });

  it('two parallel caller calls: both tool_call frames before either tool_result', async () => {
    const out = ['Checking.', ...callerFence('core').split('\n'), ...callerFence('qa').split('\n')];
    const children = [mockChild(out), mockChild(['done'])];
    vi.mocked(cp.spawn).mockImplementation(() => children.shift()!);
    const turn = await runFullAccessToolTurn('crush', new CrushAgentRunner({ crushBin: '/bin/crush' }), {
      expectCalls: 2,
    });
    expectCallerRoundTrip(turn, ['core', 'qa']);
    expectAllCallsBeforeResults(turn, 2);
    expect(argvAt(1)[1]).toContain(rosterResult('core'));
    expect(argvAt(1)[1]).toContain(rosterResult('qa'));
  });
});
