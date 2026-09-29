// packages/@monomind/cli/src/orgrt/cline-runner-parse.ts
/**
 * Parsers for the two cline wire formats this runner reads.
 *
 * `cline --json` (NDJSON on stdout, one `{ts, type, ...}` per line; shapes
 * from cline 3.0.65's own source + live error-path captures, 2026-09-29):
 *   {type:"hook_event", hookEventName:"agent_start"|"agent_error", taskId, ...}
 *   {type:"agent_event", event: AgentEvent} where AgentEvent is
 *     content_start {contentType:"text", text: <chunk>} (one per delta)
 *     content_start {contentType:"reasoning"|"tool", toolName, toolCallId, input}
 *     content_update {contentType:"tool", toolCallId, update}
 *     content_end {contentType:"text", text: <final block>}
 *     content_end {contentType:"tool", toolName, toolCallId, output, error?, durationMs}
 *     iteration_start {iteration} / iteration_end
 *     usage {inputTokens, ..., totalInputTokens, totalOutputTokens,
 *            totalCacheReadTokens, totalCacheWriteTokens, totalCost}
 *     notice / done / error {error:{name,message,stack}, errorClass, recoverable}
 *     (a subagent's events carry a non-null parentAgentId)
 *   {type:"run_result", finishReason: completed|max_iterations|aborted|
 *     mistake_limit|error, iterations, usage, aggregateUsage?, text, model}
 *   {type:"run_aborted" | "run_abort_requested", ...}
 * Captured live (no credentials, so the error path):
 *   {"type":"agent_event","event":{"type":"error","error":{"name":"Error",
 *    "message":"Anthropic API key is missing. ..."},"errorClass":"unknown",
 *    "recoverable":false,"iteration":1}}
 *   {"type":"run_result","finishReason":"error","iterations":1,"usage":{
 *    "inputTokens":0,"outputTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0,
 *    "totalCost":0},"aggregateUsage":{...},"durationMs":52,"text":"...","model":{...}}
 *
 * ACP (`cline --acp`, JSON-RPC 2.0 over stdio): `session/update`
 * notifications — agent_message_chunk / agent_thought_chunk {content:{text}},
 * tool_call {toolCallId, kind, rawInput, title}, tool_call_update
 * {toolCallId, status: completed|failed, rawOutput}. No usage, no iteration
 * events (cline's acp/session-updates.ts drops both).
 */

import type { ClineEvent, ClineUsage } from './cline-runner-types.js';

type Raw = Record<string, unknown>;

function rec(v: unknown): Raw {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : {};
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** A cline usage object (`run_result.usage`, history `metadata.usage`). */
export function toUsage(v: unknown): ClineUsage | undefined {
  const u = rec(v);
  if (!('inputTokens' in u) && !('outputTokens' in u)) return undefined;
  return {
    inputTokens: num(u.inputTokens),
    outputTokens: num(u.outputTokens),
    cacheReadTokens: num(u.cacheReadTokens),
    cacheWriteTokens: num(u.cacheWriteTokens),
    ...(typeof u.totalCost === 'number' ? { totalCost: u.totalCost } : {}),
  };
}

/** The running totals of a `usage` agent event. */
function usageTotals(e: Raw): ClineUsage {
  return {
    inputTokens: num(e.totalInputTokens),
    outputTokens: num(e.totalOutputTokens),
    cacheReadTokens: num(e.totalCacheReadTokens),
    cacheWriteTokens: num(e.totalCacheWriteTokens),
    ...(typeof e.totalCost === 'number' ? { totalCost: e.totalCost } : {}),
  };
}

function errorText(v: unknown): string {
  if (typeof v === 'string') return v;
  const m = rec(v).message;
  return typeof m === 'string' ? m : JSON.stringify(v ?? '');
}

export interface ParsedJsonLine {
  events: ClineEvent[];
  /** Top-level `iteration_start` number. */
  iteration?: number;
  /** Running totals from a top-level `usage` event. */
  usage?: ClineUsage;
  /** An unrecoverable `error` event's message. */
  error?: string;
  result?: { finishReason: string; usage?: ClineUsage; text?: string };
}

/** Stateful `cline --json` line parser: text arrives one `content_start`
 *  chunk at a time and is released as one block at its `content_end`. */
export class ClineJsonParser {
  private text = '';

  feed(line: string): ParsedJsonLine {
    const out: ParsedJsonLine = { events: [] };
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) return out;
    let msg: Raw;
    try {
      msg = rec(JSON.parse(trimmed));
    } catch {
      return out;
    }
    if (msg.type === 'run_result') {
      this.flush(out.events);
      out.result = {
        finishReason: typeof msg.finishReason === 'string' ? msg.finishReason : 'unknown',
        usage: toUsage(msg.aggregateUsage) ?? toUsage(msg.usage),
        text: typeof msg.text === 'string' ? msg.text : undefined,
      };
      return out;
    }
    if (msg.type !== 'agent_event') {
      if (msg.type === 'hook_event' || msg.type === 'team_event') out.events.push({ kind: 'ping' });
      return out;
    }
    const e = rec(msg.event);
    const sub = e.parentAgentId !== undefined && e.parentAgentId !== null;
    switch (e.type) {
      case 'content_start':
        if (e.contentType === 'text') {
          if (!sub && typeof e.text === 'string') this.text += e.text;
        } else if (e.contentType === 'tool' && typeof e.toolCallId === 'string') {
          this.flush(out.events);
          out.events.push({
            kind: 'tool_start',
            id: e.toolCallId,
            name: typeof e.toolName === 'string' ? e.toolName : 'unknown_tool',
            input: e.input,
          });
        } else {
          out.events.push({ kind: 'ping' });
        }
        break;
      case 'content_end':
        if (e.contentType === 'text') {
          if (!sub) {
            if (typeof e.text === 'string' && e.text) this.text = e.text;
            this.flush(out.events);
          }
        } else if (e.contentType === 'tool' && typeof e.toolCallId === 'string') {
          out.events.push({
            kind: 'tool_end',
            id: e.toolCallId,
            name: typeof e.toolName === 'string' ? e.toolName : undefined,
            output: e.output,
            ...(typeof e.error === 'string' && e.error ? { error: e.error } : {}),
          });
        }
        break;
      case 'iteration_start':
        if (!sub) {
          this.flush(out.events);
          out.iteration = num(e.iteration);
        }
        out.events.push({ kind: 'ping' });
        break;
      case 'usage':
        if (!sub) out.usage = usageTotals(e);
        break;
      case 'error':
        if (e.recoverable !== true && !sub) out.error = errorText(e.error);
        break;
      case 'iteration_end':
      case 'done':
        if (!sub) this.flush(out.events);
        break;
      default:
        out.events.push({ kind: 'ping' });
    }
    return out;
  }

  /** Release any text still buffered (a block whose content_end never came). */
  flush(into: ClineEvent[]): void {
    if (this.text.trim()) into.push({ kind: 'text', text: this.text });
    this.text = '';
  }
}

/** The message of a JSON diagnostic cline writes to stderr
 *  (`{"type":"error","message":...}`), last one wins. */
export function stderrErrorMessage(stderr: string): string | undefined {
  let found: string | undefined;
  for (const line of stderr.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const o = rec(JSON.parse(t));
      if (o.type === 'error' && typeof o.message === 'string') found = o.message;
    } catch {
      /* not JSON */
    }
  }
  return found;
}

/** One ACP `session/update` payload → normalized events. `text` chunks are
 *  returned separately so the caller can join them into blocks. */
export function parseAcpUpdate(update: unknown): {
  textChunk?: string;
  thought?: boolean;
  toolStart?: { id: string; acpKind: unknown; rawInput: unknown; title: unknown };
  toolEnd?: { id: string; failed: boolean; output: unknown };
} {
  const u = rec(update);
  switch (u.sessionUpdate) {
    case 'agent_message_chunk': {
      const t = rec(u.content).text;
      return typeof t === 'string' ? { textChunk: t } : {};
    }
    case 'agent_thought_chunk':
      return { thought: true };
    case 'tool_call':
      if (typeof u.toolCallId !== 'string') return {};
      return {
        toolStart: { id: u.toolCallId, acpKind: u.kind, rawInput: u.rawInput, title: u.title },
      };
    case 'tool_call_update':
      if (typeof u.toolCallId !== 'string') return {};
      if (u.status !== 'completed' && u.status !== 'failed') return {};
      return { toolEnd: { id: u.toolCallId, failed: u.status === 'failed', output: u.rawOutput } };
    default:
      return {};
  }
}
