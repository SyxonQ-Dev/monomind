// packages/@monomind/cli/src/orgrt/qwen-runner-parse.ts
// Split out of qwen-runner.ts (file-size sweep) — the stream-json wire types,
// the per-event normalizer (handleQwenEvent), and the batch parser built on
// it. See qwen-runner.ts's header for the live-verified wire shape.
import { TOOL_CALL_RE } from './tool-fence.js';

export interface QwenMessage {
  content?: Array<{ type: string; text?: string }>;
}

export interface QwenEvent {
  type?: 'system' | 'assistant' | 'result';
  subtype?: string;
  session_id?: string;
  message?: QwenMessage;
  /** Confirmed live (issue #182): on `result` events, usage is TOP-LEVEL
   *  and flat, NOT nested under `message.usage.tokens` as the public docs
   *  suggest. `assistant` events don't carry a top-level `usage` at all in
   *  observed output. */
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string } | string;
}

/**
 * One parsed qwen stream-json event, normalized for incremental streaming.
 *   - 'assistant': rawText is one whole assistant message (fences intact) for
 *     end-of-turn tool-call parsing; text is the fence-stripped prose,
 *     present only when non-empty.
 *   - 'tool':      liveness only — this runner has no live-verified wire
 *     event for qwen's own tool activity, so the only 'tool' event is the
 *     spawn-time yield (see qwen-runner.ts's header).
 *   - 'meta':      any other event that only carries a session id.
 */
export interface QwenStreamEvent {
  kind: 'assistant' | 'tool' | 'meta';
  text?: string;
  rawText?: string;
  toolName?: string;
  sessionId?: string;
}

export interface TurnOutcome {
  sessionId?: string;
  exitCode: number;
  stderrTail: string;
  timedOut: boolean;
  /** True when the process was killed by STARTUP_GRACE_MS with no output —
   *  likely stuck on a first-run interactive prompt headless mode can't answer. */
  hangSuspected: boolean;
  inputTokens: number;
  outputTokens: number;
  error?: string;
}

/**
 * Normalize one parsed qwen wire event into a QwenStreamEvent (or null for
 * events that carry nothing new). Usage/error facts are written into
 * `outcome` since they apply to the whole turn, not to a single event.
 */
export function handleQwenEvent(
  ev: QwenEvent,
  outcome: Pick<TurnOutcome, 'inputTokens' | 'outputTokens' | 'error'>,
): QwenStreamEvent | null {
  if (ev.type === 'assistant' && ev.message?.content) {
    const text = ev.message.content
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('\n');
    if (!text) return ev.session_id ? { kind: 'meta', sessionId: ev.session_id } : null;
    const stripped = text.replace(TOOL_CALL_RE, '').trim();
    return {
      kind: 'assistant',
      rawText: text,
      text: stripped || undefined,
      sessionId: ev.session_id,
    };
  }

  if (ev.type === 'result') {
    if (ev.usage) {
      outcome.inputTokens = ev.usage.input_tokens ?? 0;
      outcome.outputTokens = ev.usage.output_tokens ?? 0;
    }
    if (ev.subtype === 'error') {
      outcome.error =
        typeof ev.error === 'string' ? ev.error : (ev.error?.message ?? 'qwen result: error');
    }
    return { kind: 'meta', sessionId: ev.session_id };
  }

  // 'system' events and anything else — only the session id (if any) matters.
  return ev.session_id ? { kind: 'meta', sessionId: ev.session_id } : null;
}

/** Pure stream-json parser — exported for unit testing against fixture lines
 *  built from Qwen Code's documented event schema (qwen-runner.test.ts).
 *  Built on the same handleQwenEvent() the live streaming path uses. */
export function parseQwenEvents(lines: string[]): {
  texts: string[];
  rawTexts: string[];
  sessionId?: string;
  inputTokens: number;
  outputTokens: number;
  error?: string;
} {
  const rawTexts: string[] = [];
  const texts: string[] = [];
  let sessionId: string | undefined;
  const outcome: Pick<TurnOutcome, 'inputTokens' | 'outputTokens' | 'error'> = {
    inputTokens: 0,
    outputTokens: 0,
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed?.startsWith('{')) continue;
    let ev: QwenEvent;
    try {
      ev = JSON.parse(trimmed);
    } catch {
      continue;
    }

    const out = handleQwenEvent(ev, outcome);
    if (!out) continue;
    if (out.sessionId) sessionId = out.sessionId;
    if (out.kind === 'assistant') {
      if (out.rawText !== undefined) rawTexts.push(out.rawText);
      if (out.text) texts.push(out.text);
    }
  }

  return {
    texts,
    rawTexts,
    sessionId,
    inputTokens: outcome.inputTokens,
    outputTokens: outcome.outputTokens,
    error: outcome.error,
  };
}
