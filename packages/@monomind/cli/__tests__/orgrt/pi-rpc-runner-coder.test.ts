/**
 * PiRpcAgentRunner on pi 0.87.1: `--session-id` (no session dir in the
 * project), resume, --thinking and trust flags, matched tool events,
 * completion on agent_settled across agent_end{willRetry:true}, a failed
 * final retry, and the emulated max-turns `abort` — driven by real pi
 * 0.87.1 streams (fixtures/pi-0.87/).
 */
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AgentMessage, AgentRunArgs } from '../../src/orgrt/agent-runner.js';
import { type PiRpcProcess, PiRpcAgentRunner } from '../../src/orgrt/pi-rpc-runner.js';

const fixture = (name: string): string[] =>
  readFileSync(join(__dirname, 'fixtures', 'pi-0.87', name), 'utf8').trim().split('\n');

/** A fake pi --mode rpc: each `prompt` command written to stdin replays the
 *  next scripted batch of stdout lines; `abort` commands are recorded. */
function scriptedPi(batches: string[][]) {
  const emitter = new EventEmitter();
  const stdout = new EventEmitter();
  const written: Array<{ type: string; message?: string }> = [];
  const argv: string[][] = [];
  const proc: PiRpcProcess = {
    stdin: {
      write: (d: string) => {
        const cmd = JSON.parse(d);
        written.push(cmd);
        if (cmd.type !== 'prompt') return;
        const lines = batches.shift() ?? [];
        setTimeout(() => {
          for (const l of lines) stdout.emit('data', Buffer.from(`${l}\n`));
          if (batches.length === 0) setTimeout(() => emitter.emit('close', 0), 5);
        }, 1);
      },
    },
    stdout: { on: (e, cb) => void stdout.on(e, cb) },
    stderr: { on: () => {} },
    on: (e: string, cb: (...a: unknown[]) => void) => void emitter.on(e, cb),
    kill: vi.fn(),
  } as PiRpcProcess;
  const spawn = (_bin: string, a: string[]) => {
    argv.push(a);
    return proc;
  };
  return { proc, spawn, written, argv };
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

async function run(
  pi: ReturnType<typeof scriptedPi>,
  extra: Partial<AgentRunArgs> = {},
  prompts?: string[],
): Promise<AgentMessage[]> {
  const out: AgentMessage[] = [];
  for await (const m of new PiRpcAgentRunner('pi', pi.spawn).run(args(extra, prompts))) out.push(m);
  return out;
}

const texts = (msgs: AgentMessage[]) => msgs.filter((m) => m.type === 'assistant').map((m) => m.text);

// rpc-abort.jsonl: prompt 1 (a bash tool turn, then a turn aborted by
// {"type":"abort"}, agent_settled), the two abort acks, then prompt 2.
const ABORT = fixture('rpc-abort.jsonl');
const firstSettled = ABORT.findIndex((l) => l.includes('"agent_settled"'));
const ABORT_P1 = ABORT.slice(0, firstSettled + 1);
const ABORT_P2 = ABORT.slice(firstSettled + 1);

describe('PiRpcAgentRunner — pi 0.87.1', () => {
  it('invocation: --session-id in pi’s own store, --thinking, isolation vs --approve', async () => {
    const a = scriptedPi([ABORT_P2]);
    await run(a, { effort: 'high' });
    const argv = a.argv[0];
    expect(argv.slice(0, 2)).toEqual(['--mode', 'rpc']);
    expect(argv[argv.indexOf('--session-id') + 1]).toMatch(/^[0-9a-f-]{36}$/);
    expect(argv[argv.indexOf('--thinking') + 1]).toBe('high');
    expect(argv.join(' ')).not.toMatch(/--session-dir|\.monomind-pi-session/);
    for (const f of ['--no-approve', '-ne', '-ns', '-np', '-nc']) expect(argv).toContain(f);

    const b = scriptedPi([ABORT_P2]);
    await run(b, { settingSources: ['project'] });
    expect(b.argv[0]).toContain('--approve');
    expect(b.argv[0]).not.toContain('-nc');
  });

  it('resume: reopens the given id, skips the system prompt, and reports the id', async () => {
    const pi = scriptedPi([ABORT_P2]);
    const msgs = await run(pi, { resume: 'sess-1' }, ['again']);
    expect(pi.argv[0][pi.argv[0].indexOf('--session-id') + 1]).toBe('sess-1');
    expect(pi.written[0]).toEqual({ type: 'prompt', message: 'again' });
    expect(msgs.at(-1)).toMatchObject({ type: 'result', session_id: 'sess-1', subtype: 'success' });
  });

  it('emulated max turns: aborts the turn past the cap, settles, and the next prompt runs normally', async () => {
    const pi = scriptedPi([ABORT_P1, ABORT_P2]);
    const msgs = await run(pi, { maxTurns: 1 }, ['first', 'second']);
    expect(pi.written.map((c) => c.type)).toEqual(['prompt', 'abort', 'prompt']);

    const start = msgs.find((m) => m.type === 'tool_use' && m.tool_use_id);
    expect(start).toMatchObject({ tool_use_id: 'call_7', kind: 'shell', input: { command: 'echo hi > out.txt && cat out.txt' } });
    expect(msgs.find((m) => m.type === 'tool_result')).toMatchObject({ tool_use_id: 'call_7', text: 'hi\n', is_error: false });

    const results = msgs.filter((m) => m.type === 'result');
    expect(results.map((r) => r.subtype)).toEqual(['error_max_turns', 'success']);
    expect(results[1]).toMatchObject({ input_tokens: 150, output_tokens: 5 });
    expect(texts(msgs)).toEqual(['Running it.', 'Hello world']);
  });

  it('completes on agent_settled, not on agent_end{willRetry:true}; usage summed across the retried runs', async () => {
    const pi = scriptedPi([fixture('json-auto-retry.jsonl')]);
    const msgs = await run(pi, { extras: { includePartialMessages: true } });
    expect(texts(msgs).join('')).toBe('Running it.\nHello world');
    expect(msgs.at(-1)).toMatchObject({
      type: 'result',
      subtype: 'success',
      input_tokens: 250,
      output_tokens: 25,
    });
  });

  it('a failed final retry fails the turn', async () => {
    const pi = scriptedPi([fixture('json-retry-failed.jsonl')]);
    await expect(run(pi)).rejects.toThrow(/pi reported an error: 529/);
  });
});
