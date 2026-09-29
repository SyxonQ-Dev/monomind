/**
 * `agent exec --effort` and the non-claude startup notices (rev 15): flag
 * validation at the command layer, `AgentRunArgs.effort` plumbing in the
 * engine, and `status {phase:"notice"}` for `--settings` / an ignored
 * `--effort` on runtimes other than claude.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runExec } from '../commands/agent-exec.js';
import { type AgentExecOptions, runAgentExec } from '../orgrt/agent-exec.js';
import { runtimeStartupNotices } from '../orgrt/agent-exec-settings.js';
import type { AgentRunArgs, AgentRunner } from '../orgrt/agent-runner.js';
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
    const { code, seen, events } = await exec({ effort: 'high' });
    expect(code).toBe(0);
    expect(seen[0].effort).toBe('high');
    expect(events.filter((e) => e.type === 'status')).toEqual([]);
  });

  it('codex honors effort: no notice', async () => {
    const { events } = await exec({ runtime: 'codex', effort: 'low' });
    expect(events.filter((e) => e.type === 'status')).toEqual([]);
  });

  it('a runtime without effort control gets a status notice after start', async () => {
    const { events, seen } = await exec({ runtime: 'crush', effort: 'max' });
    expect(seen[0].effort).toBe('max');
    expect(events[0].type).toBe('start');
    expect(events[1]).toMatchObject({ type: 'status', phase: 'notice' });
    expect(String(events[1].message)).toMatch(/crush: --effort max ignored/);
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

describe('--settings on non-claude runtimes', () => {
  it('passes settingSources through and names what the CLI loads', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'mm-effort-'));
    const { events, seen } = await exec({ runtime: 'codex', settings: ['user', 'project'], cwd });
    expect(seen[0].settingSources).toEqual(['user', 'project']);
    const notes = events.filter((e) => e.type === 'status');
    expect(notes).toHaveLength(1);
    expect(String(notes[0].message)).toMatch(/^codex: user config .*AGENTS\.md/);
  });

  it('claude gets no notice (its own initializing/ready pair covers it)', () => {
    expect(
      runtimeStartupNotices({ runtime: 'claude', settings: ['user'], effortSupported: true }),
    ).toEqual([]);
  });

  it('an unlisted runtime gets a generic description', () => {
    const [n] = runtimeStartupNotices({
      runtime: 'vercel',
      settings: ['user'],
      effortSupported: false,
    });
    expect(n).toEqual({
      v: 1,
      type: 'status',
      phase: 'notice',
      message: 'vercel: its own user config and project files',
    });
  });

  it('--settings none on a non-claude runtime emits nothing', () => {
    expect(
      runtimeStartupNotices({ runtime: 'codex', settings: [], effortSupported: true }),
    ).toEqual([]);
  });
});
