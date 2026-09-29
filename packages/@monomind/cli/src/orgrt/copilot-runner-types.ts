// packages/@monomind/cli/src/orgrt/copilot-runner-types.ts

export interface CopilotEvent {
  type?: string;
  kind?: string;
  role?: string;
  /** The real 1.0.83 envelope: every event's payload lives here. The tool
   *  fields are `tool.execution_start`/`tool.execution_complete`'s (verified
   *  live against copilot 1.0.88). */
  data?: {
    content?: unknown;
    text?: string;
    toolCallId?: string;
    toolName?: string;
    arguments?: unknown;
    success?: boolean;
    result?: { content?: unknown };
    /** A shell tool's exit status (seen live on 1.0.88). */
    shellExecution?: { exitCode?: number };
  };
  /** `result` (the last line) carries the session id `--resume` takes. */
  sessionId?: string;
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
 *   - 'native':    copilot's own tool call starting (`toolStart`) or
 *     finishing (`toolEnd`), paired by its toolCallId.
 *   - 'tool':      any other event whose type/kind looks like tool activity
 *     (e.g. tool.execution_partial_result) — forwarded by run() as a
 *     `tool_use` liveness AgentMessage (see header).
 *   - 'session':   the closing `result` line's session id.
 */
export interface CopilotStreamEvent {
  kind: 'assistant' | 'native' | 'tool' | 'session';
  text?: string;
  rawText?: string;
  toolName?: string;
  toolStart?: { id: string; name: string; input: unknown };
  toolEnd?: { id: string; output: unknown; isError: boolean; exitCode?: number };
  sessionId?: string;
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
