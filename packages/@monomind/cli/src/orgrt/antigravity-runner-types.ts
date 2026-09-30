// packages/@monomind/cli/src/orgrt/antigravity-runner-types.ts
// Split out of antigravity-runner.ts (file-size sweep) — agy wire-shape types.
import type { AgentMessage } from './agent-runner.js';
import type { CliUsage } from './runner-usage.js';

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
  /** Verified live (agy, 2026-09-29): an ACTIVE step carries `name` +
   *  `parameters`; its DONE step repeats them and adds `output`. The same
   *  `step_index` identifies both. */
  tool_info?: {
    name: string;
    parameters?: Record<string, unknown>;
    args?: Record<string, unknown>;
    output?: unknown;
  };
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
 *   - 'tool':      the spawn-time liveness ping — forwarded by run() as a
 *     `tool_use` AgentMessage (see header).
 *   - 'native':    agy's own tool steps (step_type 'tool' with tool_info) as
 *     rich tool_use/tool_result messages (kimicode-runner-tools.ts), paired
 *     by step_index.
 *   - 'usage':     #550 — what one completed step added to the turn's usage,
 *     cached input split out (runner-usage.ts).
 *   - 'meta':      any other event that only carries a conversation id.
 */
export interface AgyStreamEvent {
  kind: 'assistant' | 'tool' | 'native' | 'usage' | 'meta';
  usage?: CliUsage;
  text?: string;
  rawText?: string;
  toolName?: string;
  native?: AgentMessage[];
  conversationId?: string;
}

export interface TurnOutcome {
  conversationId?: string;
  exitCode: number;
  stderrTail: string;
  timedOut: boolean;
  /** Total input, cached part included (#550). */
  inputTokens: number;
  outputTokens: number;
  /** #550: result.usage.cache_read_tokens — part of inputTokens. */
  cachedInputTokens?: number;
  error?: string;
}
