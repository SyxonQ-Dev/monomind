/**
 * #564: `monomind agent test pi-rpc` failed with "turn failed
 * (error_max_turns)" on the plain "reply ok" prompt. pi counts one turn per
 * model call, and a model that runs one of pi's own tools (ls, read) before it
 * answers makes a second call; with the test's cap of one turn the runner
 * aborted the answer. Driven here by the real PiRpcAgentRunner against a
 * scripted pi 0.87.1 rpc stream (fixtures/pi-0.87/rpc-abort.jsonl shapes).
 */

import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { agentTestExitCode, runAgentTest } from '../orgrt/agent-test.js';
import { PiRpcAgentRunner, type PiRpcProcess } from '../orgrt/pi-rpc-runner.js';

const FIXTURE = join(__dirname, '../../__tests__/orgrt/fixtures/pi-0.87/rpc-abort.jsonl');

/** The prompt's first pi turn: a native `bash` call and its result (real pi
 *  0.87.1 lines), then a second turn that answers `ok`. */
function toolThenOk(): string[] {
  const lines = readFileSync(FIXTURE, 'utf8').trim().split('\n');
  const firstTurnEnd = lines.findIndex((l) => l.includes('"type":"turn_end"'));
  const ok = {
    role: 'assistant',
    content: [{ type: 'text', text: 'ok' }],
    usage: { input: 150, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
    stopReason: 'stop',
  };
  // pi's agent_end carries every message of the run, the tool turn's too.
  const firstTurn = lines.slice(0, firstTurnEnd + 1).map((l) => JSON.parse(l));
  const runMessages = firstTurn
    .filter((e) => e.type === 'message_end' && ['assistant', 'toolResult'].includes(e.message.role))
    .map((e) => e.message);
  return [
    ...lines.slice(0, firstTurnEnd + 1),
    JSON.stringify({ type: 'turn_start' }),
    JSON.stringify({ type: 'message_start', message: { ...ok, content: [] } }),
    JSON.stringify({ type: 'message_end', message: ok }),
    JSON.stringify({ type: 'turn_end', message: ok, toolResults: [] }),
    JSON.stringify({ type: 'agent_end', messages: [...runMessages, ok], willRetry: false }),
    JSON.stringify({ type: 'agent_settled' }),
  ];
}

/** A fake `pi --mode rpc` that replays `lines` for the prompt and ignores an
 *  `abort` (real pi would cut the second turn short). */
function scriptedPi(lines: string[]) {
  const emitter = new EventEmitter();
  const stdout = new EventEmitter();
  const written: string[] = [];
  const proc = {
    stdin: {
      write: (d: string) => {
        const cmd = JSON.parse(d);
        written.push(cmd.type);
        if (cmd.type !== 'prompt') return;
        setTimeout(() => {
          for (const l of lines) stdout.emit('data', Buffer.from(`${l}\n`));
          setTimeout(() => emitter.emit('close', 0), 5);
        }, 1);
      },
    },
    stdout: { on: (e: string, cb: (c: Buffer) => void) => void stdout.on(e, cb) },
    stderr: { on: () => {} },
    on: (e: string, cb: (...a: unknown[]) => void) => void emitter.on(e, cb),
    kill: vi.fn(),
  } as unknown as PiRpcProcess;
  return { spawn: () => proc, written };
}

describe('agent test pi-rpc (#564)', () => {
  it('a model that runs one native pi tool before replying still passes the test', async () => {
    const pi = scriptedPi(toolThenOk());
    const r = await runAgentTest({
      runtime: 'pi-rpc',
      timeoutMs: 5_000,
      runnerOverride: new PiRpcAgentRunner('pi', pi.spawn),
      findBinary: () => undefined,
    });
    expect(pi.written).not.toContain('abort');
    expect(r.error).toBeNull();
    // The tool turn's own text ("Running it.") comes first, so the reply is
    // ok_unexpected rather than ok — either way the runtime passed.
    expect(agentTestExitCode(r.status)).toBe(0);
    expect(r.reply).toMatch(/\nok$/);
    expect(r.input_tokens).toBe(250);
  });
});
