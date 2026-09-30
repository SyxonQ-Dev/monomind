/**
 * #563: the vercel runner yielded every streamed text delta as its own
 * `assistant` message, and session-run.ts turns each one into an org bus
 * `chat` event. Like the claude/codex/aider runners, it now yields one
 * `assistant` message per model step, and streams deltas only when the
 * caller opts in with extras.includePartialMessages (agent exec).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const stream = vi.hoisted(() => ({
  parts: [] as unknown[],
  failAfter: -1,
  usageError: undefined as Error | undefined,
}));

vi.mock('ai', () => ({
  tool: (def: unknown) => def,
  isStepCount: (n: number) => n,
  streamText: () => ({
    fullStream: (async function* () {
      for (const [i, part] of stream.parts.entries()) {
        if (i === stream.failAfter) {
          throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        }
        yield part;
      }
    })(),
    get usage() {
      return stream.usageError
        ? Promise.reject(stream.usageError)
        : Promise.resolve({ inputTokens: 1, outputTokens: 2 });
    },
  }),
}));
vi.mock('@ai-sdk/openai', () => ({ createOpenAI: () => () => ({}) }));

import type { AgentMessage } from '../orgrt/agent-runner.js';
import { VercelAgentRunner } from '../orgrt/vercel-runner.js';

const delta = (text: string) => ({ type: 'text-delta', id: 't1', text });

let dir: string;
beforeEach(() => {
  stream.failAfter = -1;
  stream.usageError = undefined;
  dir = mkdtempSync(join(tmpdir(), 'vercel-chat-563-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function collect(
  extras?: Record<string, unknown>,
): Promise<{ msgs: AgentMessage[]; err?: unknown }> {
  const msgs: AgentMessage[] = [];
  try {
    for await (const m of new VercelAgentRunner().run({
      tools: [],
      prompt: (async function* () {
        yield 'hi';
      })(),
      systemPrompt: '',
      cwd: dir,
      env: { MONOMIND_ORG_DIR: dir, OPENAI_API_KEY: 'x' },
      maxTurns: 1,
      vendor: 'openai',
      model: 'm',
      extras,
    } as any)) {
      msgs.push(m);
    }
  } catch (err) {
    return { msgs, err };
  }
  return { msgs };
}

const assistantTexts = (msgs: AgentMessage[]) =>
  msgs.filter((m) => m.type === 'assistant').map((m) => m.text);

describe('VercelAgentRunner chat events (#563)', () => {
  it('joins several deltas into one assistant message per step', async () => {
    stream.failAfter = -1;
    stream.parts = [
      { type: 'text-start', id: 't1' },
      delta('I'),
      delta("'ve asked"),
      delta(' the question'),
      { type: 'text-end', id: 't1' },
      { type: 'finish-step' },
      { type: 'text-start', id: 't2' },
      delta('Done.'),
      { type: 'text-end', id: 't2' },
      { type: 'finish-step' },
      { type: 'finish' },
    ];
    const { msgs, err } = await collect();
    expect(err).toBeUndefined();
    expect(assistantTexts(msgs)).toEqual(["I've asked the question", 'Done.']);
    expect(msgs.at(-1)?.type).toBe('result');
  });

  it('flushes the text of a turn aborted mid-stream exactly once', async () => {
    stream.parts = [delta('half '), delta('a reply'), delta('never sent')];
    stream.failAfter = 2;
    const { msgs, err } = await collect();
    expect((err as Error)?.name).toBe('AbortError');
    expect(assistantTexts(msgs)).toEqual(['half a reply']);
  });

  it('flushes text left over when the stream ends without finish-step', async () => {
    stream.failAfter = -1;
    stream.parts = [delta('no '), delta('step end'), { type: 'abort' }];
    const { msgs } = await collect();
    expect(assistantTexts(msgs)).toEqual(['no step end']);
  });

  it('still streams deltas when the caller opts into partial messages', async () => {
    stream.failAfter = -1;
    stream.parts = [delta('a'), delta('b'), { type: 'finish-step' }];
    const { msgs } = await collect({ includePartialMessages: true });
    expect(assistantTexts(msgs)).toEqual(['a', 'b']);
  });

  it('emits no assistant message for a tool-only step', async () => {
    stream.parts = [
      { type: 'tool-call', toolCallId: 'c1', toolName: 'org_send', input: {} },
      { type: 'tool-result', toolCallId: 'c1', toolName: 'org_send', output: 'ok' },
      { type: 'finish-step' },
      delta('sent'),
      { type: 'finish-step' },
      { type: 'finish' },
    ];
    const { msgs } = await collect();
    expect(assistantTexts(msgs)).toEqual(['sent']);
  });
});
