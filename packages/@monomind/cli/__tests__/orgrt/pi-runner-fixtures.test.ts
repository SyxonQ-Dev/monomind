/**
 * PiAgentRunner against real pi 0.87.1 `--mode json` streams
 * (fixtures/pi-0.87/, captured from pi 0.87.1 driven by a local
 * OpenAI-compatible endpoint; system-prompt sections trimmed): session
 * header, text_delta streaming, tool_execution_start/end, usage summed over
 * assistant messages, agent_end{willRetry:true} → auto_retry → agent_settled,
 * a failed final retry (pi exits 0), and the emulated max-turns abort.
 * The json-openrouter-* fixtures are live pi 0.87.1 runs against a free
 * OpenRouter model (qwen/qwen3.8-27b:free): a write + bash tool run, and a
 * resumed turn that hit upstream 429s through all three auto-retries.
 */
import * as cp from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage, AgentRunArgs } from '../../src/orgrt/agent-runner.js';
import { PiAgentRunner } from '../../src/orgrt/pi-runner.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

const fixture = (name: string): string[] =>
  readFileSync(join(__dirname, 'fixtures', 'pi-0.87', name), 'utf8').trim().split('\n');

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

function args(extra: Partial<AgentRunArgs> = {}, prompts = ['go']): AgentRunArgs {
  return {
    tools: [],
    prompt: (async function* () {
      yield* prompts;
    })(),
    systemPrompt: 'SYS',
    cwd: '/w',
    env: {},
    maxTurns: 25,
    ...extra,
  };
}

async function collect(extra: Partial<AgentRunArgs> = {}, prompts?: string[]): Promise<AgentMessage[]> {
  const out: AgentMessage[] = [];
  for await (const m of new PiAgentRunner('/bin/pi').run(args(extra, prompts))) out.push(m);
  return out;
}

const argvAt = (i: number) => vi.mocked(cp.spawn).mock.calls[i]?.[1] as string[];
const texts = (msgs: AgentMessage[]) => msgs.filter((m) => m.type === 'assistant').map((m) => m.text);

describe('PiAgentRunner — real pi 0.87.1 streams', () => {
  beforeEach(() => vi.clearAllMocks());

  it('a tool run: header id, matched tool events, per-message text, summed usage and cost', async () => {
    vi.mocked(cp.spawn).mockReturnValue(mockChild(fixture('json-tool-run.jsonl')));
    const msgs = await collect();

    const start = msgs.find((m) => m.type === 'tool_use' && m.tool_use_id);
    expect(start).toMatchObject({
      tool_use_id: 'call_1',
      tool: 'bash',
      kind: 'shell',
      input: { command: 'echo hi > out.txt && cat out.txt' },
      session_id: 'mm-probe-2',
    });
    const end = msgs.find((m) => m.type === 'tool_result');
    expect(end).toMatchObject({ tool_use_id: 'call_1', tool: 'bash', is_error: false, text: 'hi\n' });

    // The toolResult message_end ("hi\n") is not assistant text.
    expect(texts(msgs)).toEqual(['Running it.', 'Hello world']);

    const result = msgs.at(-1);
    expect(result).toMatchObject({
      type: 'result',
      subtype: 'success',
      session_id: 'mm-probe-2',
      input_tokens: 250,
      output_tokens: 25,
    });
    expect(result?.cost_usd).toBeCloseTo(0.0003, 10);
  });

  it('streams text_delta increments when includePartialMessages is set', async () => {
    vi.mocked(cp.spawn).mockReturnValue(mockChild(fixture('json-tool-run.jsonl')));
    const msgs = await collect({ extras: { includePartialMessages: true } });
    const parts = texts(msgs);
    expect(parts.length).toBeGreaterThan(2);
    expect(parts.join('')).toBe('Running it.\nHello world');
  });

  it('agent_end{willRetry:true} then auto_retry succeeds: one success, the retried turn not double-counted', async () => {
    vi.mocked(cp.spawn).mockReturnValue(mockChild(fixture('json-auto-retry.jsonl')));
    // 3 turn_start events, one of them replayed by auto_retry_start: 2 turns.
    const msgs = await collect({ maxTurns: 2 });
    expect(vi.mocked(cp.spawn).mock.results[0]?.value.kill).not.toHaveBeenCalled();
    expect(texts(msgs)).toEqual(['Running it.', 'Hello world']);
    expect(msgs.at(-1)).toMatchObject({
      type: 'result',
      subtype: 'success',
      input_tokens: 250,
      output_tokens: 25,
    });
  });

  it('a failed final retry fails the turn even though pi exits 0', async () => {
    vi.mocked(cp.spawn).mockReturnValue(mockChild(fixture('json-retry-failed.jsonl')));
    await expect(collect()).rejects.toThrow(/pi reported an error.*529/s);
  });

  it('emulated max turns: the turn past the cap is aborted and the result says error_max_turns', async () => {
    // pi dies of the SIGTERM (143); that exit is the abort, not a failure.
    const child = mockChild(fixture('json-tool-run.jsonl'), 143);
    vi.mocked(cp.spawn).mockReturnValue(child);
    const msgs = await collect({ maxTurns: 1 });
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(msgs.at(-1)).toMatchObject({ type: 'result', subtype: 'error_max_turns' });
  });

  it('resume by id across two mailbox turns: the same --session-id, the system prompt sent once', async () => {
    vi.mocked(cp.spawn)
      .mockReturnValueOnce(mockChild(fixture('json-tool-run.jsonl')))
      .mockReturnValueOnce(mockChild(fixture('json-tool-run.jsonl')));
    const msgs = await collect({}, ['first', 'second']);
    const [a, b] = [argvAt(0), argvAt(1)];
    // The runner's own id first; the header's (live: the same id) after.
    expect(a[a.indexOf('--session-id') + 1]).toMatch(/^[0-9a-f-]{36}$/);
    expect(b[b.indexOf('--session-id') + 1]).toBe('mm-probe-2');
    expect(a.at(-1)).toContain('SYS');
    expect(b.at(-1)).toBe('second');
    const results = msgs.filter((m) => m.type === 'result');
    expect(results).toHaveLength(2);
    // cost_usd is cumulative per session.
    expect(results[1]?.cost_usd).toBeCloseTo(0.0006, 10);
  });

  it('live OpenRouter tool run: write + bash pairs, thinking never shown, usage and cache summed', async () => {
    vi.mocked(cp.spawn).mockReturnValue(mockChild(fixture('json-openrouter-free.jsonl')));
    const msgs = await collect();
    const starts = msgs.filter((m) => m.type === 'tool_use' && m.tool_use_id);
    expect(starts.map((m) => [m.tool, (m as { kind?: string }).kind])).toEqual([
      ['write', 'write'],
      ['bash', 'shell'],
    ]);
    const ends = msgs.filter((m) => m.type === 'tool_result');
    expect(ends.map((m) => [m.tool_use_id, m.is_error, m.text])).toEqual([
      [starts[0]?.tool_use_id, false, 'Successfully wrote to hello.txt'],
      [starts[1]?.tool_use_id, false, 'hi'],
    ]);
    expect(texts(msgs)).toEqual(['done']);
    expect(msgs.at(-1)).toMatchObject({
      type: 'result',
      subtype: 'success',
      session_id: '11111111-2222-3333-4444-555555555555',
      input_tokens: 2015,
      output_tokens: 170,
      cache_read_input_tokens: 3328,
      cost_usd: 0,
    });
  });

  it('live OpenRouter 429 through every auto-retry: no max-turns abort, the turn fails with the final error', async () => {
    const child = mockChild(fixture('json-openrouter-429-retries.jsonl'));
    vi.mocked(cp.spawn).mockReturnValue(child);
    // 4 turn_start events, 3 of them replays after auto_retry_start: 1 turn.
    await expect(collect({ maxTurns: 1 })).rejects.toThrow(/temporarily rate-limited upstream/);
    expect(child.kill).not.toHaveBeenCalled();
  });
});
