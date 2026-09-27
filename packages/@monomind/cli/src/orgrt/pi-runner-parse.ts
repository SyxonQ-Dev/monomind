// packages/@monomind/cli/src/orgrt/pi-runner-parse.ts
import { TOOL_CALL_RE } from './tool-fence.js';

interface PiContentBlock {
  type?: string;
  text?: string;
}
interface PiUsage {
  input?: number;
  output?: number;
}
interface PiEvent {
  type?: string;
  message?: { content?: PiContentBlock[]; usage?: PiUsage };
  usage?: PiUsage;
  toolName?: string;
}

/**
 * One parsed pi stdout line, normalized for incremental consumption.
 *   - assistantText: the raw (fences intact) text joined from a
 *     message_end event's text content blocks, present only when non-empty.
 *   - toolName: pi's own tool activity (a tool_execution_start event).
 *   - inputTokens/outputTokens: the latest usage figures carried by this
 *     line, if any (a message_end event can carry BOTH assistant text and
 *     usage at once, so this is a plain object rather than a tagged union).
 */
export interface PiParsedLine {
  assistantText?: string;
  toolName?: string;
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

  if (ev.type === 'message_end' && ev.message?.content) {
    const text = ev.message.content
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('\n');
    if (text) result.assistantText = text;
  } else if (ev.type === 'tool_execution_start') {
    // Liveness for pi's own tool activity — only the start event fires
    // this (not tool_execution_end too) to avoid a duplicate liveness ping
    // per command, mirroring codex's item.started-only forwarding.
    result.toolName = typeof ev.toolName === 'string' ? ev.toolName : 'tool';
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
