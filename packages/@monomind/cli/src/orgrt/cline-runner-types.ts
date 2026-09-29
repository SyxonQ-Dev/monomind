// packages/@monomind/cli/src/orgrt/cline-runner-types.ts
/** Shared types of the Cline CLI runner (cline-runner.ts). */

/** Token/cost totals as cline reports them (`run_result.usage`,
 *  `aggregateUsage`, a `usage` event's running totals, a history row's
 *  `metadata.usage`). `totalCost` is USD; absent when cline did not price it. */
export interface ClineUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalCost?: number;
}

/** One normalized event of a cline turn, whichever protocol carried it
 *  (`--json` NDJSON or ACP `session/update`). */
export type ClineEvent =
  /** A finished assistant text block. */
  | { kind: 'text'; text: string }
  | { kind: 'tool_start'; id: string; name: string; input: unknown }
  | { kind: 'tool_end'; id: string; name?: string; output: unknown; error?: string }
  /** Liveness only (turn start, reasoning, tool progress, notices). */
  | { kind: 'ping' };

/** Row of `cline history --json` (the fields this runner reads). */
export interface ClineHistoryRow {
  sessionId: string;
  pid?: number;
  cwd?: string;
  prompt?: string;
  provider?: string;
  model?: string;
  startedAt?: string;
  isSubagent?: boolean;
  metadata?: {
    totalCost?: number;
    usage?: Partial<ClineUsage>;
    aggregateUsage?: Partial<ClineUsage>;
  };
}

/** End-of-turn facts, filled in by the turn stream as it runs. */
export interface ClineTurnOutcome {
  exitCode: number;
  stderrTail: string;
  timedOut: boolean;
  /** The runner stopped the turn at `AgentRunArgs.maxTurns` iterations. */
  maxTurnsHit: boolean;
  /** json: `run_result.finishReason`; acp: the prompt's `stopReason`. */
  finishReason?: string;
  /** Last unrecoverable error message (agent_event error, JSON-RPC error). */
  errorMessage?: string;
  /** The error is a setup problem a retry cannot fix (e.g. no key for ACP). */
  fatal?: boolean;
  /** This turn's own usage: json `run_result.usage`; acp the growth of the
   *  session's cumulative usage in `cline history`. */
  usage?: ClineUsage;
  /** json turn: the session id recovered from `cline history --json`. */
  sessionId?: string;
  /** json turn: provider/model the session ran with (history row). */
  provider?: string;
  model?: string;
}

/**
 * Side effects the runner needs beyond spawning the turn itself — injected so
 * tests can drive the runner with a fake spawn and a fake host.
 */
export interface ClineHost {
  /** `cline history --json --limit <n>` rows, newest first ([] on failure). */
  history(bin: string, env: Record<string, string>, limit: number): Promise<ClineHistoryRow[]>;
  /** pids named by `<dataDir>/locks/hub/*.json` (the hub daemon's lock). */
  hubLockPids(dataDir: string): number[];
  /** Live pids whose environment holds `name=value` (Linux /proc; [] elsewhere). */
  pidsWithEnv(name: string, value: string): number[];
  /** A pid's command line, or undefined when it cannot be read. */
  cmdline(pid: number): string | undefined;
  /** Signal a pid (its process group first when it leads one). Never throws. */
  kill(pid: number, signal: NodeJS.Signals | 0): boolean;
  /** Persistent isolated cline state for scoped turns. */
  scopedDir(): string;
}
