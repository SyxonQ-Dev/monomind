// packages/@monomind/cli/src/orgrt/codex-runner-types.ts

/** `EventMsg`'s legacy v1 wire format — see file header for the source
 *  citation (codex-rs/protocol/src/protocol.rs + legacy_events.rs). Only
 *  the variants this runner acts on are typed; everything else (exec
 *  command begin/end, mcp tool call begin/end, reasoning, …) is ignored. */
export interface CodexTokenUsage {
  input_tokens: number;
  cached_input_tokens?: number;
  cache_write_input_tokens?: number;
  output_tokens: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
}

/** Current (v0.149.0+) item-based wire format's `item` payload. Only the
 *  fields this runner acts on are typed — other item types (reasoning,
 *  patch_apply, mcp_tool_call, …) are ignored, same policy as the legacy
 *  format's untyped variants. */
export interface CodexItem {
  id: string;
  type: string;
  /** agent_message */
  text?: string;
  /** command_execution */
  command?: string;
  aggregated_output?: string;
  exit_code?: number | null;
  status?: string;
}

export interface CodexEvent {
  type: // LEGACY (v0.147.0-era) shape
    | 'session_configured'
    | 'task_started'
    | 'agent_message'
    | 'token_count'
    | 'task_complete'
    | 'error'
    // CURRENT (v0.149.0+) item-based shape
    | 'thread.started'
    | 'turn.started'
    | 'item.started'
    | 'item.completed'
    | 'turn.completed'
    | (string & {});
  // LEGACY session_configured / CURRENT thread.started
  session_id?: string;
  thread_id?: string;
  // LEGACY agent_message (top-level)
  message?: string;
  // LEGACY token_count
  info?: { last_token_usage?: CodexTokenUsage; total_token_usage?: CodexTokenUsage };
  // LEGACY task_complete
  turn_id?: string;
  last_agent_message?: string;
  error?: { message: string };
  // CURRENT item.started / item.completed
  item?: CodexItem;
  // CURRENT turn.completed
  usage?: CodexTokenUsage;
}

/**
 * One parsed codex event, normalized for incremental streaming.
 *   - 'assistant': rawText is one whole agent_message (fences intact) for
 *     end-of-turn tool-call parsing; text is the fence-stripped prose,
 *     present only when non-empty.
 *   - 'tool':      codex's own tool activity (a command_execution item's
 *     start, or the spawn-time liveness yield) — forwarded by run() as a
 *     `tool_use` liveness AgentMessage (see header).
 *   - 'meta':      any other event that only carries a thread id.
 */
export interface CodexStreamEvent {
  kind: 'assistant' | 'tool' | 'meta';
  text?: string;
  rawText?: string;
  toolName?: string;
  threadId?: string;
}

export interface TurnOutcome {
  threadId?: string;
  exitCode: number;
  stderrTail: string;
  timedOut: boolean;
  inputTokens: number;
  outputTokens: number;
  error?: string;
}
