// packages/@monomind/cli/src/orgrt/pi-runner-parse.ts
/**
 * pi 0.87 session-event parser, shared by the `--mode json` runner
 * (pi-runner*.ts) and the `--mode rpc` runner (pi-rpc-runner*.ts) — both
 * modes emit the same session-event shapes (pi docs/json.md; RPC has no
 * `session` header). Event shapes below were captured from a real pi 0.87.1
 * run against a local OpenAI-compatible endpoint (fixtures in
 * __tests__/orgrt/fixtures/pi-0.87/).
 *
 *   {"type":"session","version":3,"id":"<id>",...}          json mode only
 *   {"type":"agent_start"} / {"type":"turn_start"}
 *   {"type":"message_start","message":{"role":"assistant",...}}
 *   {"type":"message_update","usage":{...},"assistantMessageEvent":
 *       {"type":"text_delta","contentIndex":0,"delta":"Hello"}}
 *   {"type":"message_end","message":{"role":"assistant","content":[...],
 *       "usage":{"input","output","cacheRead","cacheWrite","cost":{"total"}},
 *       "stopReason":"stop|toolUse|error|aborted","errorMessage"?}}
 *   {"type":"tool_execution_start","toolCallId","toolName","args"}
 *   {"type":"tool_execution_end","toolCallId","toolName","result","isError"}
 *   {"type":"agent_end","messages":[...],"willRetry":bool}
 *   {"type":"auto_retry_start",...} / {"type":"auto_retry_end","success",
 *       "finalError"?}
 *   {"type":"agent_settled"}
 *
 * message_end also closes system, user and toolResult messages (a toolResult
 * carries the tool's output as text blocks) — only an assistant message is
 * assistant text or usage. `usage` is per assistant message, so a run's
 * total is the SUM over its assistant message_end events; message_update's
 * usage is the in-flight message's running figure and turn_end repeats the
 * message, so neither is counted.
 */
import { TOOL_CALL_RE } from './tool-fence.js';

interface PiContentBlock {
  type?: string;
  text?: string;
}
export interface PiUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** Per assistant message, priced from pi's model catalog (docs/json.md). */
  cost?: { total?: number };
}
interface PiMessage {
  role?: string;
  content?: PiContentBlock[] | string;
  usage?: PiUsage;
  stopReason?: string;
  errorMessage?: string;
}
export interface PiEvent {
  type?: string;
  /** `session` header (first --mode json record): the session id. */
  id?: string;
  message?: PiMessage;
  toolName?: string;
  toolCallId?: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  willRetry?: boolean;
  success?: boolean;
  finalError?: string;
  assistantMessageEvent?: { type?: string; contentIndex?: number; delta?: unknown };
}

/** Per-assistant-message token usage (all four counts are siblings). */
export interface PiMessageUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** usage.cost.total, when pi priced the message. */
  cost?: number;
}

/**
 * One parsed pi event, normalized for incremental consumption.
 *   - assistantText: the raw (fences intact) text blocks of an assistant
 *     message_end, joined with '\n', present only when non-empty.
 *   - assistantEnd: that assistant message_end's usage and stop reason.
 *   - assistantStart: an assistant message_start (resets delta indices).
 *   - textDelta: a text_delta (thinking/toolcall deltas are never text).
 *   - toolStart/toolEnd: tool_execution_start/end, paired by toolCallId.
 *   - agentEnd: `willRetry` undefined = a pre-0.8x pi that has no
 *     agent_settled, so the agent_end is final.
 */
export interface PiParsedLine {
  sessionId?: string;
  assistantText?: string;
  assistantStart?: boolean;
  assistantEnd?: { usage: PiMessageUsage; stopReason?: string; errorMessage?: string };
  textDelta?: { index: number; delta: string };
  toolStart?: { id: string; name: string; input: unknown };
  toolEnd?: { id: string; output: unknown; isError: boolean };
  turnStart?: boolean;
  agentEnd?: { willRetry?: boolean };
  retryStart?: boolean;
  retryEnd?: { success: boolean; finalError?: string };
  settled?: boolean;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Assistant text blocks of a message, joined with '\n'. */
export function piMessageText(message: { content?: unknown } | undefined): string {
  const content = message?.content;
  if (!Array.isArray(content)) return '';
  return (content as PiContentBlock[])
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n');
}

/** Usage of one assistant message in pi's own field names. */
export function piMessageUsage(usage: PiUsage | undefined): PiMessageUsage {
  const cost = usage?.cost?.total;
  return {
    input: num(usage?.input),
    output: num(usage?.output),
    cacheRead: num(usage?.cacheRead),
    cacheWrite: num(usage?.cacheWrite),
    ...(typeof cost === 'number' && Number.isFinite(cost) ? { cost } : {}),
  };
}

/** An assistant message. Real pi always sets `role`; a role-less message
 *  (older fixtures) is taken as assistant, since system, user and toolResult
 *  messages always carry theirs. */
function isAssistant(m: PiMessage | undefined): boolean {
  return m !== undefined && (m.role === 'assistant' || m.role === undefined);
}

/** Normalize one decoded pi event (either mode). */
export function parsePiEvent(ev: PiEvent): PiParsedLine | null {
  const r: PiParsedLine = {};
  switch (ev.type) {
    case 'session':
      if (typeof ev.id === 'string' && ev.id) r.sessionId = ev.id;
      break;
    case 'turn_start':
      r.turnStart = true;
      break;
    case 'message_start':
      if (isAssistant(ev.message)) r.assistantStart = true;
      break;
    case 'message_update': {
      const am = ev.assistantMessageEvent;
      if (am?.type === 'text_delta' && typeof am.delta === 'string') {
        r.textDelta = {
          index: typeof am.contentIndex === 'number' ? am.contentIndex : 0,
          delta: am.delta,
        };
      }
      break;
    }
    case 'message_end': {
      const m = ev.message;
      if (!m || !isAssistant(m)) break;
      const text = piMessageText(m);
      if (text) r.assistantText = text;
      r.assistantEnd = {
        usage: piMessageUsage(m.usage),
        ...(m.stopReason ? { stopReason: m.stopReason } : {}),
        ...(typeof m.errorMessage === 'string' ? { errorMessage: m.errorMessage } : {}),
      };
      break;
    }
    case 'tool_execution_start':
      if (typeof ev.toolCallId === 'string') {
        r.toolStart = {
          id: ev.toolCallId,
          name: typeof ev.toolName === 'string' ? ev.toolName : 'tool',
          input: ev.args,
        };
      }
      break;
    case 'tool_execution_end':
      if (typeof ev.toolCallId === 'string') {
        r.toolEnd = { id: ev.toolCallId, output: ev.result, isError: ev.isError === true };
      }
      break;
    case 'agent_end':
      r.agentEnd = typeof ev.willRetry === 'boolean' ? { willRetry: ev.willRetry } : {};
      break;
    case 'auto_retry_start':
      r.retryStart = true;
      break;
    case 'auto_retry_end':
      r.retryEnd = {
        success: ev.success === true,
        ...(typeof ev.finalError === 'string' ? { finalError: ev.finalError } : {}),
      };
      break;
    case 'agent_settled':
      r.settled = true;
      break;
  }
  return Object.keys(r).length > 0 ? r : null;
}

/** Pure per-line parser — shared by parsePiEvents (batch, used by tests
 *  against fixture lines) and streamTurn (incremental, used at runtime). */
export function parsePiLine(line: string): PiParsedLine | null {
  const trimmed = line.trim();
  if (!trimmed?.startsWith('{')) return null;
  try {
    return parsePiEvent(JSON.parse(trimmed) as PiEvent);
  } catch {
    return null;
  }
}

/** Pure JSON-event parser — exported for unit testing against fixture lines
 *  (pi-runner.test.ts). Usage is summed over assistant messages. */
export function parsePiEvents(lines: string[]): {
  texts: string[];
  rawTexts: string[];
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd?: number;
} {
  const rawTexts: string[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let costUsd: number | undefined;

  for (const line of lines) {
    const parsed = parsePiLine(line);
    if (!parsed) continue;
    if (parsed.assistantText) rawTexts.push(parsed.assistantText);
    const u = parsed.assistantEnd?.usage;
    if (u) {
      inputTokens += u.input;
      outputTokens += u.output;
      cacheReadTokens += u.cacheRead;
      cacheWriteTokens += u.cacheWrite;
      if (u.cost !== undefined) costUsd = (costUsd ?? 0) + u.cost;
    }
  }

  const texts = rawTexts.map((t) => t.replace(TOOL_CALL_RE, '').trim());
  return { texts, rawTexts, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd };
}
