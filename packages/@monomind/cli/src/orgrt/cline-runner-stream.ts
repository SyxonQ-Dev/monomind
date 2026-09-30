// packages/@monomind/cli/src/orgrt/cline-runner-stream.ts
/**
 * One fresh `cline --json` turn (no session yet): stream its NDJSON as
 * normalized events, enforce max turns, and recover the session id.
 *
 * Invocation: `cline --json --act --auto-approve true -c <cwd>
 *   [--config <dir> --data-dir <dir>] [-P <provider>] [-m <model>]
 *   [--thinking <level>] "Complete the task below."` with the prompt on a
 *   FIFO stdin (cline-runner-proc.ts). Never `-y/--yolo`: it narrows the
 *   toolset. `--act` and `--auto-approve true` pin act mode and approvals
 *   even when the user's persisted cline settings say plan / ask — a
 *   headless turn has nobody to answer an approval. A scoped turn passes
 *   `--auto-approve false` instead and refuses what needs approval
 *   (cline-runner-scoped.ts).
 * Provider: `CLINE_PROVIDER` from the turn env (the variable cline's ACP
 *   mode reads natively) becomes `-P`; unset leaves cline's last-used one.
 * Max turns: cline has no iteration flag (only loop detection and
 *   `--retries`), so the runner counts top-level `iteration_start` events
 *   and, past `maxTurns`, kills the turn: SIGTERM, then SIGKILL after
 *   MAX_TURNS_KILL_GRACE_MS. Verified live (3.0.65, OpenRouter): neither
 *   SIGTERM nor SIGINT stops a --json run — cline finishes every remaining
 *   iteration and only then exits — so the SIGKILL is what enforces the cap.
 *   Usage then comes from the last `usage` event's running totals.
 * Session id: not in the stream; read from `cline history --json` after the
 *   process exits (matching cwd + prompt, then pid).
 */

import type { AgentRunArgs } from './agent-runner.js';
import { type ClineSetup, matchHistoryRow } from './cline-runner-host.js';
import { ClineJsonParser, stderrErrorMessage } from './cline-runner-parse.js';
import { launchCline, POSITIONAL_PROMPT } from './cline-runner-proc.js';
import type { ClineEvent, ClineHost, ClineTurnOutcome } from './cline-runner-types.js';
import type { OrgEffortLevel } from './cost-tier.js';

/** `cline --thinking`: none|low|medium|high|xhigh (max clamps to xhigh). */
/** How long cline gets to exit on SIGTERM once past max turns. */
export const MAX_TURNS_KILL_GRACE_MS = 1500;

export const CLINE_THINKING: Record<OrgEffortLevel, string> = {
  off: 'none',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'xhigh',
};

export function jsonTurnArgs(setup: ClineSetup, args: AgentRunArgs): string[] {
  // Scoped: fail closed; the plugin re-approves the safe tools only.
  const out = [
    '--json',
    '--act',
    '--auto-approve',
    setup.scoped ? 'false' : 'true',
    '-c',
    args.cwd,
  ];
  out.push(...setup.configArgs, ...setup.dataDirArgs);
  if (setup.env.CLINE_PROVIDER) out.push('-P', setup.env.CLINE_PROVIDER);
  if (args.model) out.push('-m', args.model);
  if (args.effort) out.push('--thinking', CLINE_THINKING[args.effort]);
  return out;
}

export async function* streamJsonTurn(
  setup: ClineSetup,
  prompt: string,
  args: AgentRunArgs,
  host: ClineHost,
  outcome: ClineTurnOutcome,
): AsyncGenerator<ClineEvent> {
  const sinceMs = Date.now();
  const launch = launchCline(setup, jsonTurnArgs(setup, args), args, host, { stdinPrompt: prompt });
  const parser = new ClineJsonParser();
  let lastUsage: ClineTurnOutcome['usage'];

  let drained = false;
  try {
    yield { kind: 'ping' };
    let buf = '';
    const handle = (line: string): ClineEvent[] => {
      const p = parser.feed(line);
      if (p.usage) lastUsage = p.usage;
      if (p.error) outcome.errorMessage = p.error;
      if (p.result) {
        outcome.finishReason = p.result.finishReason;
        if (p.result.usage) outcome.usage = p.result.usage;
        // Model text, not an error from cline: kept apart so it is shown
        // but never classified (clineTurnFailure).
        if (p.result.finishReason !== 'completed' && p.result.text) {
          outcome.resultText = p.result.text;
        }
      }
      if (
        p.iteration !== undefined &&
        args.maxTurns > 0 &&
        p.iteration > args.maxTurns &&
        !outcome.maxTurnsHit
      ) {
        outcome.maxTurnsHit = true;
        launch.killChild(MAX_TURNS_KILL_GRACE_MS);
      }
      return p.events;
    };
    for await (const chunk of launch.child.stdout as AsyncIterable<Buffer>) {
      buf += chunk.toString();
      const parts = buf.split('\n');
      buf = parts.pop() ?? '';
      for (const line of parts) yield* handle(line);
    }
    if (buf.trim()) yield* handle(buf);
    const tail: ClineEvent[] = [];
    parser.flush(tail);
    yield* tail;
    drained = true;
  } finally {
    launch.dispose();
  }

  const exitCode = await launch.exit;
  outcome.exitCode = exitCode;
  outcome.stderrTail = launch.stderr();
  outcome.timedOut = launch.timedOut();
  outcome.usage ??= lastUsage;
  if (!outcome.errorMessage && exitCode !== 0)
    outcome.errorMessage = stderrErrorMessage(outcome.stderrTail);
  if (!drained) return;

  const rows = await host.history(setup.bin, setup.env, 20);
  const row = matchHistoryRow(rows, {
    cwd: args.cwd,
    prompt: `${POSITIONAL_PROMPT}\n\n${prompt.trim()}`,
    pid: launch.child.pid,
    sinceMs,
  });
  if (row) {
    outcome.sessionId = row.sessionId;
    outcome.provider = row.provider;
    outcome.model = row.model;
  }
}
