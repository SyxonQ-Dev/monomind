// packages/@monomind/cli/src/orgrt/pi-runner-parse.ts
import { TOOL_CALL_RE } from './tool-fence.js';

interface PiContentBlock {
  type?: string;
  text?: string;
}
interface PiUsage {
  input?: number;
  output?: number;
  /** Per assistant message, priced from pi's model catalog (docs/json.md). */
  cost?: { total?: number };
}
interface PiEvent {
  type?: string;
  /** `session` header (first --mode json record): the session id. */
  id?: string;
  message?: { role?: string; content?: PiContentBlock[]; usage?: PiUsage };
  usage?: PiUsage;
  toolName?: string;
  toolCallId?: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
}

/**
 * One parsed pi stdout line, normalized for incremental consumption.
 *   - assistantText: the raw (fences intact) text joined from a
 *     message_end event's text content blocks, present only when non-empty.
 *   - toolStart/toolEnd: pi's own tool calls (tool_execution_start /
 *     tool_execution_end, correlated by toolCallId — pi docs/json.md).
 *   - sessionId: the `session` header's id (what `--session <id>` resumes).
 *   - costUsd: an assistant message_end's `usage.cost.total`.
 *   - inputTokens/outputTokens: the latest usage figures carried by this
 *     line, if any (a message_end event can carry BOTH assistant text and
 *     usage at once, so this is a plain object rather than a tagged union).
 */
export interface PiParsedLine {
  assistantText?: string;
  toolStart?: { id: string; name: string; input: unknown };
  toolEnd?: { id: string; output: unknown; isError: boolean };
  sessionId?: string;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
}

/** Pure per-line parser — shared by parsePiEvents (batch, used by tests
 *  against fixture lines) and streamTurn (incremental, used at runtime). */
export function parsePiLine(line: string): PiParsedLine | null {
  const trimmed = line.trim();
  if (!trimmed?.startsWith('{')) return null;
  let ev: PiEvent;
  try {
    ev = JSON.parse(trimmed);
  } catch {
    return null;
  }

  const result: PiParsedLine = {};

  // pi 0.87 also closes the USER message with a message_end whose content
  // is a plain string (docs/json.md) — never assistant text, and `.filter`
  // on it would throw. Only an assistant message's block array counts.
  if (
    ev.type === 'message_end' &&
    ev.message?.role !== 'user' &&
    Array.isArray(ev.message?.content)
  ) {
    const text = ev.message.content
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('\n');
    if (text) result.assistantText = text;
    const cost = ev.message.usage?.cost?.total;
    if (typeof cost === 'number') result.costUsd = cost;
  } else if (ev.type === 'tool_execution_start' && typeof ev.toolCallId === 'string') {
    result.toolStart = {
      id: ev.toolCallId,
      name: typeof ev.toolName === 'string' ? ev.toolName : 'tool',
      input: ev.args,
    };
  } else if (ev.type === 'tool_execution_end' && typeof ev.toolCallId === 'string') {
    result.toolEnd = { id: ev.toolCallId, output: ev.result, isError: ev.isError === true };
  } else if (ev.type === 'session' && typeof ev.id === 'string' && ev.id) {
    result.sessionId = ev.id;
  }

  const usage = ev.message?.usage ?? ev.usage;
  if (usage && (typeof usage.input === 'number' || typeof usage.output === 'number')) {
    if (typeof usage.input === 'number') result.inputTokens = usage.input;
    if (typeof usage.output === 'number') result.outputTokens = usage.output;
  }

  return Object.keys(result).length > 0 ? result : null;
}

/** Pure JSON-event parser — exported for unit testing against fixture lines
 *  (pi-runner.test.ts). */
export function parsePiEvents(lines: string[]): {
  texts: string[];
  rawTexts: string[];
  inputTokens: number;
  outputTokens: number;
} {
  const rawTexts: string[] = [];
  let inputTokens = 0;
  let outputTokens = 0;

  for (const line of lines) {
    const parsed = parsePiLine(line);
    if (!parsed) continue;
    if (parsed.assistantText) rawTexts.push(parsed.assistantText);
    if (typeof parsed.inputTokens === 'number') inputTokens = parsed.inputTokens;
    if (typeof parsed.outputTokens === 'number') outputTokens = parsed.outputTokens;
  }

  const texts = rawTexts.map((t) => t.replace(TOOL_CALL_RE, '').trim());
  return { texts, rawTexts, inputTokens, outputTokens };
}
