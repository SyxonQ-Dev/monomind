/**
 * #387 (rev 24): runtimes other than claude get `subagent started/finished`
 * synthesized from a task-kind tool call's `tool_activity` start and end
 * (tool-activity.ts), at lower fidelity than claude's SDK-based events: no
 * `progress` phase and no `usage`.
 *
 * Drives runAgentExec with a fake runner yielding the AgentMessage shapes the
 * vendor runners produce (a rich `tool_use` with a real id, then its
 * `tool_result`), and ToolActivityTracker directly for the cancel path.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { runAgentExec } from '../orgrt/agent-exec.js';
import type { AgentMessage } from '../orgrt/agent-runner.js';
import { ToolActivityTracker } from '../orgrt/tool-activity.js';

type Ev = Record<string, unknown>;

const use = (id: string, tool: string, input: Record<string, unknown>, kind?: string) =>
  ({ type: 'tool_use', session_id: 's', tool_use_id: id, tool, input, kind }) as AgentMessage;
const res = (id: string, tool: string, text: string, extra: Partial<AgentMessage> = {}) =>
  ({ type: 'tool_result', session_id: 's', tool_use_id: id, tool, text, ...extra }) as AgentMessage;

async function run(runtime: string, messages: AgentMessage[]): Promise<Ev[]> {
  const events: Ev[] = [];
  await runAgentExec({
    runtime,
    prompt: 'go',
    maxTurns: 5,
    toolTimeoutMs: 60_000,
    runnerOverride: {
      async *run() {
        for (const m of messages) yield m;
        yield { type: 'result', session_id: 's', subtype: 'success' } as AgentMessage;
      },
    },
    emit: (ev: Ev) => events.push(ev),
    stdin: new PassThrough(),
  } as any);
  return events;
}

const TASK_INPUT = {
  description: 'Find config',
  prompt: 'Find the config loader',
  subagent_type: 'explore',
};

describe('#387: subagent events synthesized from task-kind tool_activity', () => {
  it('opencode task call: start → subagent started (same id), end → subagent finished', async () => {
    const events = await run('opencode', [
      use('call_1', 'task', TASK_INPUT, 'task'),
      res('call_1', 'task', 'Config is loaded in src/config.ts'),
    ]);
    const types = events
      .filter((e) => e.type === 'tool_activity' || e.type === 'subagent')
      .map((e) => `${e.type}:${e.phase}`);
    expect(types).toEqual([
      'tool_activity:start',
      'subagent:started',
      'tool_activity:end',
      'subagent:finished',
    ]);
    const sub = events.filter((e) => e.type === 'subagent');
    expect(sub[0]).toEqual({
      v: 1,
      type: 'subagent',
      phase: 'started',
      id: 'call_1',
      tool_use_id: 'call_1',
      subagent_type: 'explore',
      description: 'Find config',
      prompt: 'Find the config loader',
    });
    expect(sub[1]).toEqual({
      v: 1,
      type: 'subagent',
      phase: 'finished',
      id: 'call_1',
      tool_use_id: 'call_1',
      status: 'completed',
      summary: 'Config is loaded in src/config.ts',
    });
  });

  it('kind from the shared name table (no runner kind) and a `task` field as the prompt (cline spawn_agent)', async () => {
    const events = await run('cline', [
      use('c1', 'spawn_agent', { systemPrompt: 'You are a reviewer', task: 'Review a.ts' }, 'task'),
      use('c2', 'spawn_subagent', {}),
      res('c1', 'spawn_agent', ''),
      res('c2', 'spawn_subagent', 'ok'),
    ]);
    const sub = events.filter((e) => e.type === 'subagent');
    expect(sub).toEqual([
      {
        v: 1,
        type: 'subagent',
        phase: 'started',
        id: 'c1',
        tool_use_id: 'c1',
        prompt: 'Review a.ts',
      },
      { v: 1, type: 'subagent', phase: 'started', id: 'c2', tool_use_id: 'c2' },
      {
        v: 1,
        type: 'subagent',
        phase: 'finished',
        id: 'c1',
        tool_use_id: 'c1',
        status: 'completed',
      },
      {
        v: 1,
        type: 'subagent',
        phase: 'finished',
        id: 'c2',
        tool_use_id: 'c2',
        status: 'completed',
        summary: 'ok',
      },
    ]);
  });

  it('an error end maps to failed, a denied end to denied', async () => {
    const events = await run('dsh', [
      use('d1', 'subagent', { description: 'a', prompt: 'p' }, 'task'),
      res('d1', 'subagent', 'boom', { is_error: true }),
      use('d2', 'subagent', { description: 'b', prompt: 'q' }, 'task'),
      res('d2', 'subagent', 'refused', { is_error: true, denied: true }),
    ]);
    const finished = events.filter((e) => e.type === 'subagent' && e.phase === 'finished');
    expect(finished.map((e) => [e.id, e.status])).toEqual([
      ['d1', 'failed'],
      ['d2', 'denied'],
    ]);
  });

  it('caps the summary and never emits progress or usage', async () => {
    const events = await run('opencode', [
      use('call_1', 'task', TASK_INPUT, 'task'),
      res('call_1', 'task', 'x'.repeat(5000)),
    ]);
    const sub = events.filter((e) => e.type === 'subagent');
    expect(sub.map((e) => e.phase)).toEqual(['started', 'finished']);
    for (const e of sub) expect(e).not.toHaveProperty('usage');
    expect(String(sub[1].summary).length).toBeLessThanOrEqual(500);
  });

  it('non-task tools emit no subagent event', async () => {
    const events = await run('opencode', [
      use('b1', 'bash', { command: 'ls' }, 'shell'),
      res('b1', 'bash', 'a.ts'),
      use('r1', 'read', { file_path: 'a.ts' }, 'read'),
      res('r1', 'read', '...'),
    ]);
    expect(events.filter((e) => e.type === 'tool_activity')).toHaveLength(4);
    expect(events.some((e) => e.type === 'subagent')).toBe(false);
  });

  it('claude gets no synthesized events (its runner reports real ones)', async () => {
    const events = await run('claude', [
      use('toolu_task', 'Task', { subagent_type: 'Explore', prompt: 'p' }),
      res('toolu_task', 'Task', 'done'),
    ]);
    expect(events.filter((e) => e.type === 'tool_activity')).toHaveLength(2);
    expect(events.some((e) => e.type === 'subagent')).toBe(false);
  });

  it('a cancelled task call finishes with status stopped', () => {
    const events: Ev[] = [];
    const t = new ToolActivityTracker((ev) => events.push(ev), 'full', true);
    t.onMessage(use('call_1', 'task', TASK_INPUT, 'task'));
    t.closeInFlight();
    expect(events.map((e) => `${e.type}:${e.phase}`)).toEqual([
      'tool_activity:start',
      'subagent:started',
      'tool_activity:end',
      'subagent:finished',
    ]);
    expect(events[3]).toEqual({
      v: 1,
      type: 'subagent',
      phase: 'finished',
      id: 'call_1',
      tool_use_id: 'call_1',
      status: 'stopped',
    });
  });

  it('produces the event sequence of the published subagent-synth.ndjson golden fixture', async () => {
    const fixture = readFileSync(
      join(
        __dirname,
        '..',
        '..',
        '..',
        '..',
        '..',
        'doc',
        'agent-exec-protocol',
        'fixtures',
        'subagent-synth.ndjson',
      ),
      'utf8',
    )
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Ev);
    // Replay the fixture's own task call through a fake opencode runner.
    const start = fixture.find((e) => e.type === 'tool_activity' && e.phase === 'start')!;
    const end = fixture.find((e) => e.type === 'tool_activity' && e.phase === 'end')!;
    const id = String(start.id);
    const events = await run('opencode', [
      use(id, String(start.name), start.input as Record<string, unknown>, 'task'),
      res(id, String(end.name), String(end.output)),
    ]);
    const pick = (evs: Ev[]) =>
      evs
        .filter((e) => e.type === 'tool_activity' || e.type === 'subagent')
        .map((e) => `${e.type}:${e.phase}`);
    expect(pick(events)).toEqual(pick(fixture));
    const sub = (evs: Ev[]) => evs.filter((e) => e.type === 'subagent');
    expect(sub(events)).toEqual(sub(fixture));
  });
});
