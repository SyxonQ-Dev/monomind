/**
 * `agent exec --effort` (rev 16): flag validation at the command layer and
 * `AgentRunArgs.effort` plumbing in the engine.
 */

import { describe, expect, it } from 'vitest';
import { runExec } from '../commands/agent-exec.js';
import { type AgentExecOptions, runAgentExec } from '../orgrt/agent-exec.js';
import type { AgentRunArgs, AgentRunner } from '../orgrt/agent-runner.js';
import { codexEffortArgs } from '../orgrt/codex-runner-tools.js';
import type { CommandContext } from '../types.js';

function capture(): { runner: AgentRunner; seen: AgentRunArgs[] } {
  const seen: AgentRunArgs[] = [];
  return {
    seen,
    runner: {
      async *run(args) {
        seen.push(args);
        yield { type: 'result', subtype: 'success' };
      },
    },
  };
}

async function exec(over: Omit<Partial<AgentExecOptions>, 'toolTimeoutMs'>) {
  const events: Record<string, unknown>[] = [];
  const { runner, seen } = capture();
  const code = await runAgentExec({
    runtime: 'claude',
    prompt: 'hi',
    maxTurns: 3,
    toolTimeoutMs: 60_000,
    ...over,
    runnerOverride: runner,
    emit: (ev) => events.push(ev),
  });
  return { code, events, seen };
}

describe('agent exec --effort', () => {
  it('passes effort through to AgentRunArgs.effort', async () => {
    const { code, seen } = await exec({ effort: 'high' });
    expect(code).toBe(0);
    expect(seen[0].effort).toBe('high');
  });

  it('no --effort leaves AgentRunArgs.effort unset', async () => {
    const { seen } = await exec({});
    expect(seen[0].effort).toBeUndefined();
  });

  it('command layer rejects an unknown level with exit 2', async () => {
    const ctx: CommandContext = {
      args: [],
      flags: { _: [], runtime: 'claude', prompt: 'hi', effort: 'turbo' },
      cwd: process.cwd(),
      interactive: false,
    };
    expect(await runExec(ctx, {})).toBe(2);
  });

  it('command layer forwards a valid level to the engine', async () => {
    const { runner, seen } = capture();
    const ctx: CommandContext = {
      args: [],
      flags: { _: [], runtime: 'claude', prompt: 'hi', effort: 'xhigh' },
      cwd: process.cwd(),
      interactive: false,
    };
    const code = await runExec(ctx, { runnerOverride: runner, emit: () => {} });
    expect(code).toBe(0);
    expect(seen[0].effort).toBe('xhigh');
  });
});

describe('codexEffortArgs', () => {
  it('maps a level onto -c model_reasoning_effort', () => {
    expect(codexEffortArgs('medium')).toEqual(['-c', 'model_reasoning_effort=medium']);
    expect(codexEffortArgs('max')).toEqual(['-c', 'model_reasoning_effort=max']);
  });

  it("maps monomind's off onto codex's none", () => {
    expect(codexEffortArgs('off')).toEqual(['-c', 'model_reasoning_effort=none']);
  });

  it('unset → no args', () => {
    expect(codexEffortArgs(undefined)).toEqual([]);
  });
});
