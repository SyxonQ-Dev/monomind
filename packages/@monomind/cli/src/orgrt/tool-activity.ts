// packages/@monomind/cli/src/orgrt/tool-activity.ts
/**
 * `tool_activity` events (#357, doc/agent-exec-protocol.md §3.2) — start/end
 * pairs for NATIVE tool calls (Bash, Edit, Write, Read, ...) on `agent exec`
 * stdout, correlated by the SDK's own tool_use id, in every access mode
 * (observability only — never affects the canUseTool allow/deny decision).
 *
 * New module rather than a growth of orgrt/agent-exec.ts (already at this
 * project's 500-line file cap) — agent-exec.ts only owns wiring: it feeds
 * every 'tool_use'/'tool_result' AgentMessage to a ToolActivityTracker and
 * emits whatever it produces.
 *
 * Deliberately message-stream-driven, not canUseTool-driven: start/end
 * pairing (onMessage/onToolUse/onToolResult) reads ONLY the AgentMessage
 * stream every access mode already produces. `wrapCanUseTool`/`markDenied`
 * are a separate, optional add-on solely for the scoped-mode `denied:true`
 * end field — #355's `--access full` runs the SDK with
 * `permissionMode:'bypassPermissions'`, under which canUseTool is shadowed
 * and never invoked at all (`CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`); this
 * tracker degrades safely there (the `denied` set simply stays empty, `ok`
 * still comes from the real tool_result's `is_error`) rather than losing
 * start/end pairing, which would be the case if it were built from
 * canUseTool call sites instead of the message stream.
 *
 * Bridged (`--tools stdio`) calls keep their existing `tool_call`/
 * `tool_result` frames (§4) untouched: the Claude SDK reports those with the
 * `mcp__org__<name>` prefix agent-exec.ts registers them under (see its own
 * `allowedToolNames`), so this module simply skips any tool_use/tool_result
 * whose name carries that prefix.
 *
 * Fidelity varies by runtime (doc §9, runner-registry.ts's
 * `toolActivityFidelity`):
 *  - `full` (claude, codex, opencode, antigravity, kimicode, grok, qwen,
 *    copilot): start/end
 *    pairs correlated by a real id — any runner that yields the rich
 *    `tool_use` shape (id + name) and a matching `tool_result` gets them,
 *    whatever its runtime. ClaudeAgentRunner gates its rich shape behind
 *    extras.includePartialMessages (agent-exec.ts sets it, session.ts, the
 *    org runtime, never does).
 *  - `start-only` (crush/pi): a lightweight
 *    `{type:'tool_use', text: toolName}` liveness signal with no id —
 *    mapped best-effort to a START-ONLY tool_activity under a locally-
 *    minted id (no matching end is possible without one, and none is
 *    emitted). A `full` runner may still send one for a call it cannot pair.
 *  - `none` (vercel/hermes/qwen-rpc/pi-rpc): no tool_activity at all.
 *
 * Rev 19: every start carries `kind` (tool-kind.ts) — the runner's own
 * `AgentMessage.kind` when set, else derived from the tool name — and an
 * end carries `exit_code` when the runner reported one.
 */

import type { AgentMessage } from './agent-runner.js';
import { toolKind } from './tool-kind.js';

/** Per-string-field cap (§3.2: "16 KiB per string field"). */
const MAX_FIELD_BYTES = 16 * 1024;
/** Whole-event safety net for pathological inputs (e.g. a MultiEdit with
 *  many edits) that per-field capping alone can't bound — §3.2: "the event
 *  stays well under ~64 KiB". Comfortably below 64 KiB to leave headroom for
 *  a caller's own line-length limits. */
const MAX_EVENT_BYTES = 55 * 1024;
/** The mcp__org__ prefix the Claude SDK reports for a bridged (`--tools
 *  stdio`) tool call — mirrors agent-exec.ts's own `allowedToolNames`. */
const BRIDGED_PREFIX = 'mcp__org__';

function capString(s: string, maxBytes = MAX_FIELD_BYTES): { value: string; truncated: boolean } {
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return { value: s, truncated: false };
  let value = s.slice(0, maxBytes);
  // Trim by UTF-16 length first (always >= the byte length for any string),
  // then shrink until the byte cap is met so a multi-byte codepoint or
  // surrogate pair is never split at the boundary.
  while (Buffer.byteLength(value, 'utf8') > maxBytes) value = value.slice(0, -1);
  return { value, truncated: true };
}

/** Recursively cap every string leaf of a plain JSON-ish value (object,
 *  array, or scalar), adding a sibling `<key>_truncated: true` next to any
 *  object property that was cut. Covers Edit/MultiEdit's old_string/
 *  new_string and Write's content generically, including MultiEdit's own
 *  nested `edits` array. */
function capValue(val: unknown): { value: unknown; truncated: boolean } {
  if (typeof val === 'string') {
    const r = capString(val);
    return { value: r.value, truncated: r.truncated };
  }
  if (Array.isArray(val)) {
    let truncated = false;
    const value = val.map((item) => {
      const r = capValue(item);
      if (r.truncated) truncated = true;
      return r.value;
    });
    return { value, truncated };
  }
  if (val && typeof val === 'object') {
    const value: Record<string, unknown> = {};
    let truncated = false;
    for (const [key, v] of Object.entries(val as Record<string, unknown>)) {
      const r = capValue(v);
      value[key] = r.value;
      if (r.truncated) {
        value[`${key}_truncated`] = true;
        truncated = true;
      }
    }
    return { value, truncated };
  }
  return { value: val, truncated: false };
}

function capInput(input: Record<string, unknown>): Record<string, unknown> {
  return capValue(input).value as Record<string, unknown>;
}

/** Whole-event fallback: per-field capping bounds any ONE string, but many
 *  capped fields together (a MultiEdit with many edits) can still add up
 *  past the budget — collapse the oversized field to a flat marker rather
 *  than try to re-balance nested caps. */
function shrinkToFit(ev: Record<string, unknown>): Record<string, unknown> {
  if (Buffer.byteLength(JSON.stringify(ev), 'utf8') <= MAX_EVENT_BYTES) return ev;
  const shrunk = { ...ev };
  if ('input' in shrunk) shrunk.input = { truncated: true };
  if (Buffer.byteLength(JSON.stringify(shrunk), 'utf8') <= MAX_EVENT_BYTES) return shrunk;
  if (typeof shrunk.output === 'string') {
    shrunk.output = shrunk.output.slice(0, 256);
    shrunk.output_truncated = true;
  }
  return shrunk;
}

export function isBridgedToolName(name: string | undefined): boolean {
  return typeof name === 'string' && name.startsWith(BRIDGED_PREFIX);
}

type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  meta?: { toolUseId?: string },
) => Promise<unknown>;

export class ToolActivityTracker {
  /** ids with an emitted start and no emitted end yet — closed with
   *  `cancelled:true` if the turn ends before a matching tool_result. */
  private open = new Map<string, string>(); // id -> name
  /** ids the caller's own canUseTool denied, recorded via wrapCanUseTool
   *  below at the moment of decision — the runner has no policy concept of
   *  its own to source this from. Consumed (checked-and-removed) by the
   *  matching tool_result. */
  private denied = new Set<string>();
  private syntheticCounter = 0;
  /** Count of every `tool_activity` "start" emitted (native rich-shape calls
   *  and vendor lightweight liveness signals alike) — the "number of native
   *  tool calls" the full-access audit log records per turn (#360). */
  private startCount = 0;

  /** `fidelity` is the runtime's own `RunnerSpec.toolActivityFidelity`
   *  (runner-registry.ts) — gates the best-effort vendor-lightweight
   *  mapping below so a runner with no REAL per-tool signal (e.g. hermes's
   *  single fixed "turn started" placeholder ping, fidelity `"none"`)
   *  never produces a misleading tool_activity event. */
  constructor(
    private emit: (ev: Record<string, unknown>) => void,
    private fidelity: 'full' | 'start-only' | 'none' = 'full',
  ) {}

  /** Wraps a canUseTool so a `deny` decision is also recorded by id, purely
   *  as an observation — the returned decision is passed through unchanged. */
  wrapCanUseTool(raw: CanUseTool): CanUseTool {
    return async (toolName, input, meta) => {
      const decision = (await raw(toolName, input, meta)) as { behavior?: string };
      if (meta?.toolUseId && decision?.behavior === 'deny') this.denied.add(meta.toolUseId);
      return decision;
    };
  }

  /** m.type === 'tool_use' | 'tool_result' — the only two AgentMessage
   *  types this tracker acts on. */
  onMessage(m: AgentMessage): void {
    if (m.type === 'tool_use') this.onToolUse(m);
    else if (m.type === 'tool_result') this.onToolResult(m);
  }

  private onToolUse(m: AgentMessage): void {
    if (m.tool_use_id && m.tool) {
      // Native (rich) shape — any runner that has a real id.
      if (isBridgedToolName(m.tool)) return; // bridged: tool_call/tool_result cover it (§4)
      this.open.set(m.tool_use_id, m.tool);
      this.startCount++;
      this.emit(
        shrinkToFit({
          v: 1,
          type: 'tool_activity',
          id: m.tool_use_id,
          phase: 'start',
          name: m.tool,
          kind: toolKind(m.tool, m.kind),
          input: capInput((m.input ?? {}) as Record<string, unknown>),
          parent_tool_use_id: m.parent_tool_use_id ?? null,
        }),
      );
      return;
    }
    // Vendor lightweight liveness signal (grok/copilot/pi/...): no id to
    // correlate an end with — best-effort, start-only (doc §9). Gated by
    // fidelity so a runner with no real per-tool signal at all (hermes)
    // never produces a misleading event from its own placeholder ping.
    if (this.fidelity === 'none' || !m.text) return;
    const id = `activity_${++this.syntheticCounter}`;
    this.startCount++;
    this.emit({
      v: 1,
      type: 'tool_activity',
      id,
      phase: 'start',
      name: m.text,
      kind: toolKind(m.text, m.kind),
      input: null,
      parent_tool_use_id: null,
    });
  }

  private onToolResult(m: AgentMessage): void {
    const id = m.tool_use_id;
    if (!id || !this.open.has(id)) return;
    this.open.delete(id);
    const denied = this.denied.delete(id);
    const { value: output, truncated } = capString(m.text ?? '');
    this.emit(
      shrinkToFit({
        v: 1,
        type: 'tool_activity',
        id,
        phase: 'end',
        name: m.tool,
        ok: !denied && m.is_error !== true,
        output,
        output_truncated: truncated,
        ...(denied ? { denied: true } : {}),
        ...(m.duration_ms !== undefined ? { duration_ms: m.duration_ms } : {}),
        ...(typeof m.exit_code === 'number' ? { exit_code: m.exit_code } : {}),
      }),
    );
  }

  /** Total `tool_activity` "start" events emitted so far this turn — the
   *  full-access audit log's `toolCalls` field (#360, full-access-audit.ts). */
  get toolCallCount(): number {
    return this.startCount;
  }

  /** Cancel/timeout: close every still-open id before `done` (§3.2). */
  closeInFlight(): void {
    for (const [id, name] of this.open) {
      this.emit({
        v: 1,
        type: 'tool_activity',
        id,
        phase: 'end',
        name,
        ok: false,
        cancelled: true,
      });
    }
    this.open.clear();
  }
}
