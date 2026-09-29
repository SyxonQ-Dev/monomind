// packages/@monomind/cli/src/orgrt/kimicode-runner-parse.ts
// Split out of kimicode-runner.ts (file-size sweep) — kimi stream-json wire
// format parsing and stderr fatal-error classification.
import { classifyProviderLimit } from './provider-limit.js';
import { TOOL_CALL_RE } from './tool-fence.js';

/**
 * One parsed kimi stream-json event, normalized for incremental streaming.
 *   - 'assistant': rawText is the full assistant text (fences intact) for
 *     end-of-turn tool-call parsing; text is the fence-stripped prose,
 *     present only when non-empty.
 *     `toolCalls` carries the native tool calls the same message started.
 *   - 'native':    a tool-call-only assistant message (`toolCalls`) or a
 *     tool result ({"role":"tool","tool_call_id",...} → `toolResult`) —
 *     forwarded by run() as rich tool_use/tool_result AgentMessages.
 *   - 'tool':      a {"role":"tool",...} event with no call id — forwarded by
 *     run() as a `tool_use` liveness AgentMessage (see header).
 *   - 'meta':      any other event that only carries a session id.
 */
export interface KimiStreamEvent {
  kind: 'assistant' | 'native' | 'tool' | 'meta';
  text?: string;
  rawText?: string;
  toolName?: string;
  toolCalls?: Array<{ id: string; name: string; input: unknown }>;
  toolResult?: { id: string; output: unknown };
  sessionId?: string;
}

/** OpenAI-style `tool_calls` on a kimi assistant message (kimi-code 2.x
 *  PromptJsonWriter: {type:'function', id, function:{name, arguments}},
 *  `arguments` a JSON string). */
function parseToolCallsField(v: unknown): Array<{ id: string; name: string; input: unknown }> {
  if (!Array.isArray(v)) return [];
  const out: Array<{ id: string; name: string; input: unknown }> = [];
  for (const c of v) {
    const call = c as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
    if (typeof call?.id !== 'string' || typeof call.function?.name !== 'string') continue;
    out.push({ id: call.id, name: call.function.name, input: call.function.arguments ?? {} });
  }
  return out;
}

/**
 * Parse ONE kimi stream-json line into a normalized event (null for blank,
 * non-JSON, or content-free lines). Exported for unit tests — this encodes
 * the wire format verified against kimi 0.29.2, and a CLI format change
 * should fail loudly in CI, not silently starve an org at runtime.
 *
 * Real shapes (verified):
 *   {"role":"assistant","content":"..."}                 — reply text
 *   {"role":"assistant","content":[{"type":"text",...}]} — block form
 *   {"role":"meta","type":"session.resume_hint",session_id} — resume hint
 *   {"role":"tool","content":"Bash(ls ...)"}             — tool progress
 * kimi-code 2.x stream-json (read from its PromptJsonWriter, not live —
 * no kimi install here) adds the call/result pairing:
 *   {"role":"assistant","content":...,"tool_calls":[{id,function:{name,arguments}}]}
 *   {"role":"tool","tool_call_id":"...","content":"<output>"}
 */
export function parseStreamJsonLine(line: string): KimiStreamEvent | null {
  const t = line.trim();
  if (!t?.startsWith('{')) return null;
  let ev: Record<string, unknown>;
  try {
    ev = JSON.parse(t) as Record<string, unknown>;
  } catch {
    return null;
  }

  // Capture the session id from ANY event that carries it — resume needs it
  // on the next turn.
  const sid = (ev.session_id ??
    ev.sessionId ??
    (ev.session as Record<string, unknown> | undefined)?.id) as string | undefined;
  const sessionId = sid && typeof sid === 'string' ? sid : undefined;

  const role = (ev.role ?? ev.type) as string | undefined;
  if (role === 'assistant') {
    const content = ev.content ?? (ev.message as Record<string, unknown> | undefined)?.content;
    let text = '';
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .filter((b: Record<string, unknown>) => b?.type === 'text')
        .map((b: Record<string, unknown>) => String(b.text ?? ''))
        .join('\n');
    } else if (typeof ev.text === 'string') {
      text = ev.text;
    }
    const toolCalls = parseToolCallsField(ev.tool_calls);
    if (text) {
      const stripped = text.replace(TOOL_CALL_RE, '').trim();
      return {
        kind: 'assistant',
        rawText: text,
        text: stripped || undefined,
        sessionId,
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      };
    }
    if (toolCalls.length > 0) return { kind: 'native', toolCalls, sessionId };
  } else if (role === 'tool') {
    if (typeof ev.tool_call_id === 'string') {
      return { kind: 'native', toolResult: { id: ev.tool_call_id, output: ev.content }, sessionId };
    }
    return { kind: 'tool', toolName: describeToolEvent(ev), sessionId };
  }
  // Meta/unknown events matter only when they carry a session id.
  return sessionId ? { kind: 'meta', sessionId } : null;
}

/** Short human-readable label for a {"role":"tool",...} progress event —
 *  used only as liveness text (never parsed, never shown as chat). */
function describeToolEvent(ev: Record<string, unknown>): string {
  const content = ev.content ?? (ev.message as Record<string, unknown> | undefined)?.content;
  let label: string | undefined;
  if (typeof content === 'string') label = content;
  else if (typeof ev.name === 'string') label = ev.name;
  else if (typeof ev.tool_name === 'string') label = ev.tool_name;
  else if (typeof ev.tool === 'string') label = ev.tool;
  else if (content !== undefined) label = JSON.stringify(content);
  return (label ?? 'tool activity').slice(0, 200);
}

/**
 * Parse kimi stream-json lines into normalized texts + session id.
 * Batch convenience wrapper over parseStreamJsonLine, kept for callers/tests
 * that parse a completed turn's output; the runner itself streams per line.
 */
export function parseStreamJsonLines(lines: string[]): {
  texts: string[];
  rawTexts: string[];
  sessionId?: string;
} {
  const texts: string[] = [];
  const rawTexts: string[] = [];
  let sessionId: string | undefined;

  for (const line of lines) {
    const ev = parseStreamJsonLine(line);
    if (!ev) continue;
    if (ev.sessionId) sessionId = ev.sessionId;
    if (ev.kind === 'assistant' && ev.rawText !== undefined) {
      rawTexts.push(ev.rawText);
      if (ev.text) texts.push(ev.text);
    }
  }
  return { texts, rawTexts, sessionId };
}

/** Scan stderr for session_id events. Kimi 0.33+ emits session.resume_hint on
 *  stderr (not stdout) in stream-json mode; the stdout parser captures session_id
 *  from assistant events, but if kimi emits it ONLY on stderr we'd miss it and
 *  fall back to a cold session on every turn. This defensive scan catches it
 *  regardless of which stream kimi writes it to. */
export function extractStderrSessionId(stderr: string): string | undefined {
  let sessionId: string | undefined;
  for (const line of stderr.split('\n')) {
    const t = line.trim();
    if (!t?.startsWith('{')) continue;
    try {
      const ev = JSON.parse(t) as Record<string, unknown>;
      const sid = (ev.session_id ?? ev.sessionId) as string | undefined;
      if (sid && typeof sid === 'string') sessionId = sid;
    } catch {
      /* not JSON, skip */
    }
  }
  return sessionId;
}

/** Stderr patterns that mark a turn failure as FATAL (non-retryable): auth,
 *  quota, and billing errors can never be fixed by restarting the session —
 *  the daemon must not burn its crash-restart budget on them. A transient
 *  rate limit is fatal to the daemon too, but carries `rateLimited` so
 *  `agent exec` can retry it after a backoff (provider-limit.ts). */
const AUTH_FATAL_RE = /auth_error|401|403/i;

export interface FatalErrorInfo {
  fatal: boolean;
  label?: string;
  /** A transient provider rate limit (429), not exhausted quota. */
  rateLimited?: boolean;
}

/** Classify a CLI turn's stderr: is this a fatal (non-retryable) failure? */
export function classifyStderr(stderrTail: string): FatalErrorInfo {
  if (AUTH_FATAL_RE.test(stderrTail))
    return { fatal: true, label: 'authentication/permission error' };
  const limit = classifyProviderLimit(stderrTail);
  if (limit === 'rate-limited')
    return { fatal: true, label: 'provider rate limit (429)', rateLimited: true };
  if (limit === 'quota') return { fatal: true, label: 'provider quota/billing limit' };
  return { fatal: false };
}
