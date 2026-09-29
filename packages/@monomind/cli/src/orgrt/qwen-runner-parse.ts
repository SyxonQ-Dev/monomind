// packages/@monomind/cli/src/orgrt/qwen-runner-parse.ts
// Split out of qwen-runner.ts (file-size sweep) — the stream-json wire types,
// the per-event normalizer (handleQwenEvent), and the batch parser built on
// it. See qwen-runner.ts's header for the live-verified wire shape.
import { messageBlocks } from './kimicode-runner-tools.js';
import { TOOL_CALL_RE } from './tool-fence.js';

export interface QwenMessage {
  content?: Array<{ type: string; text?: string }>;
}

export interface QwenEvent {
  /** 'user' frames carry qwen's own tool results (tool_result blocks). */
  type?: 'system' | 'assistant' | 'user' | 'result';
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
 *     May also carry `toolUses` (the same message's tool_use blocks).
 *   - 'native':    qwen's own tool calls (assistant tool_use blocks) or
 *     results (user tool_result blocks) with no text alongside. Read from
 *     qwen-code's headless adapter (Claude-compatible stream-json), not a
 *     live run — no qwen install here.
 *   - 'tool':      liveness only — the spawn-time yield.
 *   - 'meta':      any other event that only carries a session id.
 */
export interface QwenStreamEvent {
  kind: 'assistant' | 'native' | 'tool' | 'meta';
  text?: string;
  rawText?: string;
  toolName?: string;
  toolUses?: Array<{ id: string; name: string; input: unknown }>;
  toolResults?: Array<{ id: string; output: unknown; isError: boolean }>;
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
  if ((ev.type === 'assistant' || ev.type === 'user') && ev.message?.content) {
    const { text, toolUses, toolResults } = messageBlocks(ev.message.content);
    const tools = {
      ...(toolUses.length > 0 ? { toolUses } : {}),
      ...(toolResults.length > 0 ? { toolResults } : {}),
    };
    if (ev.type === 'assistant' && text) {
      const stripped = text.replace(TOOL_CALL_RE, '').trim();
      return {
        kind: 'assistant',
        rawText: text,
        text: stripped || undefined,
        sessionId: ev.session_id,
        ...tools,
      };
    }
    if (toolUses.length > 0 || toolResults.length > 0) {
      return { kind: 'native', sessionId: ev.session_id, ...tools };
    }
    return ev.session_id ? { kind: 'meta', sessionId: ev.session_id } : null;
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
