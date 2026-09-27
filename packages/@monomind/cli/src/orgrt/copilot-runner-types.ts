// packages/@monomind/cli/src/orgrt/copilot-runner-types.ts

export interface CopilotEvent {
  type?: string;
  kind?: string;
  role?: string;
  /** The real 1.0.83 envelope: every event's payload lives here. */
  data?: { content?: unknown; text?: string };
  content?: unknown;
  text?: string;
  message?: { content?: unknown; text?: string };
}

/** Token counts for ONE `copilot -p` invocation, read back from the JSON
 *  copilot writes to `--usage-output-file`. */
export interface CopilotUsage {
  /** Total prompt tokens (fresh + cache read + cache write). */
  inputTokens: number;
  outputTokens: number;
}

/**
 * One parsed copilot NDJSON line, normalized for incremental streaming.
 *   - 'assistant': rawText is the event's whole text (fences intact) for
 *     end-of-turn tool-call parsing; text is the fence-stripped prose,
 *     present only when non-empty.
 *   - 'tool':      an event whose type/kind looks like tool activity —
 *     forwarded by run() as a `tool_use` liveness AgentMessage (see header).
 */
export interface CopilotStreamEvent {
  kind: 'assistant' | 'tool';
  text?: string;
  rawText?: string;
  toolName?: string;
}

export interface TurnOutcome {
  exitCode: number;
  stderrTail: string;
  timedOut: boolean;
  /** True when the process was killed by STARTUP_GRACE_MS with no output —
   *  likely stuck on copilot's documented directory-trust/path-access hang. */
  hangSuspected: boolean;
  /** This invocation's real token usage (#181), or undefined when copilot
   *  made no model call at all. */
  usage?: CopilotUsage;
}
