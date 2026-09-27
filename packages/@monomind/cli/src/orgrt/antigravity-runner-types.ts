// packages/@monomind/cli/src/orgrt/antigravity-runner-types.ts
// Split out of antigravity-runner.ts (file-size sweep) — agy wire-shape types.

// Wire shape (verified against agy 0.35.0 stream-json output): each line is
// { "event": "init" | "step_update" | "result", ...payload nested under a
// key matching the event name }. init's conversation_id is a sibling of
// "event"/"init"; step_update's and result's fields live inside their own
// nested object — NOT flat on the top-level event.
export interface AgyStepUpdatePayload {
  conversation_id?: string;
  step_index?: number;
  step_type?: 'user_input' | 'agent_response' | 'tool' | 'checkpoint' | 'unknown';
  state?: 'ACTIVE' | 'DONE';
  text_delta?: string;
  duration_seconds?: number;
  usage?: AgyUsage;
  tool_info?: { name: string; args?: Record<string, unknown> };
  subagent_info?: { name?: string };
}

export interface AgyUsage {
  input_tokens?: number;
  output_tokens?: number;
  thinking_tokens?: number;
  cache_read_tokens?: number;
  total_tokens?: number;
}

export interface AgyResultPayload {
  conversation_id?: string;
  status?: 'SUCCESS' | 'ERROR' | 'CANCELED' | 'INTERRUPTED' | 'INVALID' | 'WAITING' | 'RUNNING';
  response?: string;
  error?: string;
  usage?: AgyUsage;
  duration_seconds?: number;
  num_turns?: number;
}

export interface AgyEvent {
  event: 'init' | 'step_update' | 'result' | string;
  conversation_id?: string;
  init?: { model?: string; cwd?: string; tools?: string[]; permission_mode?: string };
  step_update?: AgyStepUpdatePayload;
  result?: AgyResultPayload;
}

/**
 * One parsed agy stream-json event, normalized for incremental streaming.
 *   - 'assistant': rawText is the accumulated agent_response text (fences
 *     intact) for end-of-turn tool-call parsing; text is the fence-stripped
 *     prose, present only when non-empty.
 *   - 'tool':      agy's own tool activity (step_type 'tool' with tool_info)
 *     — forwarded by run() as a `tool_use` liveness AgentMessage (see header).
 *   - 'meta':      any other event that only carries a conversation id.
 */
export interface AgyStreamEvent {
  kind: 'assistant' | 'tool' | 'meta';
  text?: string;
  rawText?: string;
  toolName?: string;
  conversationId?: string;
}

export interface TurnOutcome {
  conversationId?: string;
  exitCode: number;
  stderrTail: string;
  timedOut: boolean;
  inputTokens: number;
  outputTokens: number;
  error?: string;
}
