// packages/@monomind/cli/src/orgrt/types-events.ts
/** #290: why a `decision-trace` audit event was recorded. Before this, a
 *  prompt-injection fence block and a routine "waiting for a human to approve
 *  this tool" emitted byte-identical structured fields (`decisionType: 'tool'`,
 *  `outcome: 'denied'`) and differed only in free text — so a consumer wanting
 *  to tell "blocked by the security fence" from "waiting for you" had to regex
 *  English out of `data.context`/`data.reasoning`. Prose stays for humans;
 *  consumers switch on `data.kind`. Set where the decision is made, never
 *  reconstructed by a reader. */
export type DecisionKind =
  /** monofence scanInput() rejected the tool's own input (prompt injection). */
  | 'fence-block'
  /** A pending decision gate is hard-blocking every tool call for this role. */
  | 'gate-pending'
  /** PolicyEngine.decide() denied it (allowlist, scope, budget, git level, …). */
  | 'policy-deny'
  /** Routine: an approval request is open and waiting on a human. */
  | 'approval-pending'
  /** A human (or a guardrail) rejected the approval request. */
  | 'approval-denied'
  /** An open approval request was resolved (approved or rejected). */
  | 'approval-resolved'
  /** Work/context crossed an org boundary via deliver(). */
  | 'cross-org-handoff';

/** #289: how much of a tool's result body a `tool_result` event carries.
 *  A single Bash result can be megabytes and there is one of these per tool
 *  call — two orders of magnitude more frequent than the 20k-char 'asset'
 *  content snapshot — so the head is kept and the rest dropped. Truncation is
 *  never implied by the text: `truncated` and `output_chars` say it outright. */
export const TOOL_RESULT_OUTPUT_MAX_CHARS = 4_000;

/** #289: the `data` payload of a `tool_result` bus event — the outcome of a
 *  tool call that a consumer can read without pattern-matching the agent's own
 *  narration about whether its command worked. */
export interface ToolResultEventData {
  /** The harness's tool-use id, matching `call_id` on the `tool` event that
   *  recorded the invocation. Correlating by id (not by tool name) is what
   *  makes two concurrent Bash calls from the same role tellable apart. */
  call_id?: string;
  /** Did the call succeed? The universal outcome: harnesses report a per-call
   *  error flag for every tool, including ones that never exit with a code
   *  (Read, WebFetch, an MCP tool). No `exitCode` is carried — the Claude
   *  Agent SDK does not surface one, and recovering it would mean parsing the
   *  result prose, which is the very thing this event exists to replace. */
  ok: boolean;
  /** Wall time from the invocation to the result landing, when observable. */
  duration_ms?: number;
  /** Redacted head of the result body, at most TOOL_RESULT_OUTPUT_MAX_CHARS. */
  output?: string;
  /** True when `output` is only the head of a longer body. */
  truncated?: boolean;
  /** Length of the result body BEFORE truncation, in characters. */
  output_chars?: number;
}

/** Superset of the legacy *-threads.jsonl line shape ({type,id,run_id,ts,from,to,msg,subject}). */
export interface BusEvent {
  id: string;
  ts: number;
  org: string;
  run: string;
  type:
    | 'message'
    | 'xorg'
    | 'tool'
    /** #289: a completed tool call. `tool` is the tool name, `from` the role,
     *  `data` a ToolResultEventData correlated to the 'tool' event by call_id. */
    | 'tool_result'
    | 'asset'
    | 'chat'
    | 'status'
    | 'audit'
    | 'usage'
    | 'question'
    | 'gate'
    | 'trace';
  from?: string;
  to?: string;
  subject?: string;
  msg?: string;
  tool?: string;
  decision?: 'allow' | 'deny';
  reason?: string;
  path?: string;
  data?: Record<string, unknown>;
  /** Parent event ID for message chains (e.g., a message responding to another message) */
  parentId?: string;
  /** OpenTelemetry tracing fields (optional, for distributed tracing and cost tracking) */
  conversationId?: string;
  interactionId?: string;
  agentSessionId?: string;
  traceNodeId?: string;
  traceDurationMs?: number;
  traceTokensIn?: number;
  traceTokensOut?: number;
}

export interface DecisionGate {
  id: string;
  name: string;
  description: string;
  roleId: string;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: number;
  resolvedBy?: string;
  resolvedAt?: number;
  resolution?: string;
}
