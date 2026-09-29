// packages/@monomind/cli/src/orgrt/grok-runner-parse.ts
// Split out of grok-runner.ts (file-size sweep) — the shape-tolerant NDJSON
// event extractors and the batch parser built on them. See grok-runner.ts's
// header for why the wire shape is guessed rather than committed to one.
import { messageBlocks } from './kimicode-runner-tools.js';
import { TOOL_CALL_RE } from './tool-fence.js';

/** Pull a session/thread id out of a parsed event, tolerating the field-name
 *  variants different CLI versions/backends tend to use. */
export function extractSessionId(ev: Record<string, unknown>): string | undefined {
  for (const key of ['session_id', 'sessionId', 'thread_id', 'threadId']) {
    const v = ev[key];
    if (typeof v === 'string' && v) return v;
  }
  return undefined;
}

/** Pull assistant-visible text out of a parsed event, tolerating the shape
 *  variants documented (or plausible) for grok's output formats:
 *    - `streaming-messages-json` (what the runner passes): { type:
 *      'assistant', message: { content: [{type:'text',text}, ...] } }
 *    - codex-style: { type: 'item.completed', item: { type: 'agent_message', text } }
 *    - flat role shape: { role: 'assistant', content: '...' | [{type:'text',text}] }
 *    - flat type shape: { type: 'assistant' | 'message', text: '...' } */
export function extractText(ev: Record<string, unknown>): string | undefined {
  const message = ev.message as Record<string, unknown> | undefined;
  if (ev.type === 'assistant' && message && 'content' in message) {
    return messageBlocks(message.content).text || undefined;
  }
  const item = ev.item as Record<string, unknown> | undefined;
  if (
    item &&
    (item.type === 'agent_message' || item.type === 'message') &&
    typeof item.text === 'string'
  ) {
    return item.text;
  }
  if (ev.role === 'assistant') {
    const content = ev.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .filter(
          (b): b is { type: string; text: string } =>
            !!b && typeof b === 'object' && (b as Record<string, unknown>).type === 'text',
        )
        .map((b) => b.text)
        .join('\n');
    }
  }
  if ((ev.type === 'assistant' || ev.type === 'message') && typeof ev.text === 'string') {
    return ev.text;
  }
  return undefined;
}

/** Pull usage totals out of a parsed event, tolerating openai-ish
 *  (prompt_tokens/completion_tokens) and codex-ish (input_tokens/output_tokens)
 *  field names. */
export function extractUsage(
  ev: Record<string, unknown>,
): { input: number; output: number } | undefined {
  const usage = ev.usage as Record<string, unknown> | undefined;
  if (!usage) return undefined;
  const input = usage.input_tokens ?? usage.prompt_tokens;
  const output = usage.output_tokens ?? usage.completion_tokens;
  if (typeof input === 'number' || typeof output === 'number') {
    return {
      input: typeof input === 'number' ? input : 0,
      output: typeof output === 'number' ? output : 0,
    };
  }
  return undefined;
}

/** Pull a fatal error message out of a parsed event, tolerating an
 *  `error`/`turn.failed` event with either a nested `error.message` or a
 *  flat `message` field, and a `streaming-messages-json` result with
 *  `is_error: true` and `errors[]` (e.g. "Not signed in", verified live). */
export function extractError(ev: Record<string, unknown>): string | undefined {
  // Hitting --max-turns is a stop reason, not a failure (claude parity):
  // the runner reports it as the result's subtype instead.
  if (ev.type === 'result' && ev.is_error === true && ev.subtype !== 'error_max_turns') {
    const errors = Array.isArray(ev.errors) ? ev.errors.filter((e) => typeof e === 'string') : [];
    return errors.length > 0 ? errors.join('; ') : `grok result: ${String(ev.subtype ?? 'error')}`;
  }
  if (ev.type !== 'error' && ev.type !== 'turn.failed') return undefined;
  const errMsg = (ev.error as Record<string, unknown> | undefined)?.message ?? ev.message;
  return typeof errMsg === 'string' ? errMsg : undefined;
}

/** Pure NDJSON parser — exported so it can be unit tested against fixture
 *  lines without spawning the real CLI (see grok-runner.test.ts). The
 *  streaming path (grok-runner-stream.ts's streamTurn) parses one line at a
 *  time via the same extract* helpers, so both share the shape-tolerance
 *  logic. */
export function parseGrokEvents(lines: string[]): {
  texts: string[];
  rawTexts: string[];
  sessionId?: string;
  inputTokens: number;
  outputTokens: number;
  error?: string;
} {
  const rawTexts: string[] = [];
  let sessionId: string | undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  let error: string | undefined;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed?.startsWith('{')) continue;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(trimmed);
    } catch {
      continue;
    }

    const sid = extractSessionId(ev);
    if (sid) sessionId = sid;

    const text = extractText(ev);
    if (text) rawTexts.push(text);

    const usage = extractUsage(ev);
    if (usage) {
      inputTokens = usage.input;
      outputTokens = usage.output;
    }

    const errMsg = extractError(ev);
    if (errMsg) error = errMsg;
  }

  const texts = rawTexts.map((t) => t.replace(TOOL_CALL_RE, '').trim());
  return { texts, rawTexts, sessionId, inputTokens, outputTokens, error };
}

/** grok's native tool calls (assistant `tool_use` blocks) and their results
 *  (user `tool_result` blocks) in one `streaming-messages-json` event. */
export function extractToolBlocks(ev: Record<string, unknown>): {
  toolUses: Array<{ id: string; name: string; input: unknown }>;
  toolResults: Array<{ id: string; output: unknown; isError: boolean }>;
} {
  const message = ev.message as Record<string, unknown> | undefined;
  if ((ev.type !== 'assistant' && ev.type !== 'user') || !message) {
    return { toolUses: [], toolResults: [] };
  }
  const { toolUses, toolResults } = messageBlocks(message.content);
  return { toolUses, toolResults };
}

/**
 * One parsed grok event, normalized for incremental streaming.
 *   - 'assistant': rawText is one whole assistant text (fences intact) for
 *     end-of-turn tool-call parsing; text is the fence-stripped prose,
 *     present only when non-empty. May also carry `toolUses`.
 *   - 'native':    grok's own tool calls/results with no text alongside.
 *   - 'tool':      liveness only — the spawn-time yield.
 */
export interface GrokStreamEvent {
  kind: 'assistant' | 'native' | 'tool';
  text?: string;
  rawText?: string;
  toolName?: string;
  toolUses?: Array<{ id: string; name: string; input: unknown }>;
  toolResults?: Array<{ id: string; output: unknown; isError: boolean }>;
  sessionId?: string;
}
