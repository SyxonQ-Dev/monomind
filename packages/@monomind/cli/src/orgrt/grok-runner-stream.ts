// packages/@monomind/cli/src/orgrt/grok-runner-stream.ts
// Split out of grok-runner.ts (file-size sweep) — the `grok` subprocess turn
// runner (streamTurn) and the turn-failure error builder (turnError).
// streamTurn does not reference `this` — it was a private method purely for
// grouping, so moving it to a standalone function changes nothing observable;
// the class in grok-runner.ts now calls it as an imported function.
import type { AgentRunArgs } from './agent-runner.js';
import { killOnAbort } from './agent-runner.js';
import { maskedCommand } from './authority-mask.js';
import { grokSandboxArgs, roleGitLevel } from './cli-sandbox.js';
import type { OrgEffortLevel } from './cost-tier.js';
import {
  extractError,
  extractSessionId,
  extractText,
  extractToolBlocks,
  extractUsage,
  type GrokStreamEvent,
} from './grok-runner-parse.js';
import { classifyStderr } from './kimicode-runner.js';
import { spawnRunnerProcess } from './process-group-spawn.js';
import { omitAnthropicManagedKeys } from './provider.js';
import { TOOL_CALL_RE } from './tool-fence.js';

const TURN_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours, matching the other subprocess runners
/** Distinct from TURN_TIMEOUT_MS: catches a hung first-run interactive prompt
 *  (trust/telemetry gate) fast instead of waiting out the full turn timeout.
 *  Fires only if the process has produced ZERO stdout by this point — any
 *  output at all disarms it, since a slow model response is not a hang. */
const STARTUP_GRACE_MS = 45_000;

/** `grok --reasoning-effort` levels are low|medium|high|xhigh (the CLI's own
 *  bundled docs); grok ignores the flag on a model without reasoning. */
const GROK_EFFORT: Record<OrgEffortLevel, string> = {
  off: 'low',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'xhigh',
};

export interface TurnOutcome {
  sessionId?: string;
  exitCode: number;
  stderrTail: string;
  timedOut: boolean;
  /** True when the process was killed by STARTUP_GRACE_MS with no output —
   *  likely stuck on a first-run interactive prompt headless mode can't answer. */
  hangSuspected: boolean;
  inputTokens: number;
  outputTokens: number;
  /** `result.total_cost_usd` of this invocation, when grok reported one. */
  costUsd?: number;
  /** The invocation stopped at `--max-turns` (result subtype
   *  `error_max_turns`). */
  maxTurnsHit?: boolean;
  error?: string;
}

/**
 * Run one `grok` invocation and stream its NDJSON output INCREMENTALLY:
 * each parsed event is yielded as soon as its line arrives on stdout (see
 * grok-runner.ts's header "Streaming / liveness" note for why buffering
 * until process exit was a bug, #204). End-of-turn facts (exit code, stderr
 * tail, session id, usage, error, timeout/hang flags) are written into
 * `outcome`, which the caller reads after this generator completes.
 */
export async function* streamTurn(
  bin: string,
  prompt: string,
  sessionId: string | undefined,
  args: AgentRunArgs,
  outcome: TurnOutcome,
): AsyncGenerator<GrokStreamEvent> {
  // --output-format, not --format: confirmed against a live v1.0.5
  // install (`npm install -g @xai-official/grok`) — `--format` doesn't
  // exist ("unexpected argument '--format' found"). See #178.
  // `streaming-messages-json` rather than `json`: per the docs bundled in
  // grok 1.0.41, `json` is ONE object {text, stopReason, sessionId,
  // requestId} at exit (none of this parser's shapes matched its `text`),
  // while `streaming-messages-json` is NDJSON in the Anthropic Messages
  // shape — assistant text, tool_use/tool_result blocks with real ids,
  // `session_id`, and a `result` with usage and total_cost_usd. Its
  // `system`/`result` envelope was confirmed live (an unsigned-in run);
  // the assistant/user frames follow the bundled docs.
  const cliArgs: string[] = [
    '-p',
    prompt,
    '--output-format',
    'streaming-messages-json',
    '--always-approve',
  ];
  // #263: below policy.git 'push', grok runs in its own `workspace` sandbox
  // profile (Landlock/Seatbelt) instead of the default `off`. Tool approval
  // stays automatic — the org gates tools itself. See cli-sandbox.ts.
  // Full access (`--access full`) is --always-approve with no sandbox at
  // any git level.
  if (args.access !== 'full') cliArgs.push(...grokSandboxArgs(roleGitLevel(args.env)));
  if (args.model) cliArgs.push('--model', args.model);
  if (args.effort) cliArgs.push('--reasoning-effort', GROK_EFFORT[args.effort]);
  if (args.maxTurns > 0) cliArgs.push('--max-turns', String(args.maxTurns));
  cliArgs.push('--cwd', args.cwd);
  if (sessionId) cliArgs.push('--resume', sessionId);

  const proc = spawnRunnerProcess(
    ...maskedCommand(args.authorityMask, bin, cliArgs),
    {
      cwd: args.cwd,
      // o-18: ambient ANTHROPIC_* creds never belong to a non-Anthropic
      // vendor CLI; an explicit value in args.env still wins below.
      env: { ...omitAnthropicManagedKeys(process.env), ...args.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
    args,
  );
  const child = proc.child;

  let stderrTail = '';
  child.stderr?.on('data', (c: Buffer) => {
    stderrTail = (stderrTail + c.toString()).slice(-4000);
  });

  // Arm the turn timeout BEFORE consuming stdout — a hung CLI must be
  // killed while we're still reading, not after it finishes.
  let timedOut = false;
  let hangSuspected = false;
  // SIGTERM→SIGKILL escalation, shared by the turn timeout, the startup
  // hang check, the abort signal, and the abandoned-stream path in
  // `finally` — a CLI that ignores SIGTERM must not leak a zombie per turn.
  const KILL_GRACE_MS = 5000;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const killChild = (): void => {
    proc.target.kill('SIGTERM');
    killTimer = setTimeout(() => proc.target.kill('SIGKILL'), KILL_GRACE_MS);
    killTimer.unref?.();
  };
  const timer = setTimeout(() => {
    timedOut = true;
    killChild();
  }, TURN_TIMEOUT_MS);

  // See STARTUP_GRACE_MS — disarmed by the first stdout chunk below.
  let hangTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
    hangSuspected = true;
    killChild();
  }, STARTUP_GRACE_MS);
  // Abort hook (see AgentRunArgs.signal): kill the child so the stdout
  // loop below unblocks instead of orphaning it on iterator.return().
  const unsubscribeAbort = killOnAbort(args.signal, proc.target, KILL_GRACE_MS);

  // Attach the exit promise BEFORE consuming stdout: on a spawn failure
  // (ENOENT, bad binary) the 'error' event fires almost immediately — if
  // no listener is attached yet it escapes as an unhandled 'error' event
  // and crashes the process instead of reaching our catch block.
  const exitPromise = new Promise<number>((res, rej) => {
    child.on('error', rej);
    child.on('close', (code) => res(code ?? 1));
  });
  // Prevent an unhandled-rejection crash if the stdout loop below throws
  // before we await exitPromise (the await still sees the rejection).
  exitPromise.catch(() => {});

  let lastSessionId: string | undefined = sessionId;

  // Normalize one parsed wire event: capture the session id from ANY event
  // that carries it (resume needs it on the next turn), record
  // error/usage state, and return the GrokStreamEvent to yield (or null).
  // Reuses the same shape-tolerant helpers as the batch parseGrokEvents.
  const handleEvent = (ev: Record<string, unknown>): GrokStreamEvent | null => {
    const sid = extractSessionId(ev);
    if (sid) lastSessionId = sid;

    const usage = extractUsage(ev);
    if (usage) {
      outcome.inputTokens = usage.input;
      outcome.outputTokens = usage.output;
    }

    const errMsg = extractError(ev);
    if (errMsg) outcome.error = errMsg;
    if (ev.type === 'result' && typeof ev.total_cost_usd === 'number') {
      outcome.costUsd = ev.total_cost_usd;
    }
    if (ev.type === 'result' && ev.subtype === 'error_max_turns') outcome.maxTurnsHit = true;

    const { toolUses, toolResults } = extractToolBlocks(ev);
    const tools = {
      ...(toolUses.length > 0 ? { toolUses } : {}),
      ...(toolResults.length > 0 ? { toolResults } : {}),
    };
    const text = extractText(ev);
    if (text) {
      const stripped = text.replace(TOOL_CALL_RE, '').trim();
      return {
        kind: 'assistant',
        rawText: text,
        text: stripped || undefined,
        sessionId: lastSessionId,
        ...tools,
      };
    }
    if (toolUses.length > 0 || toolResults.length > 0) {
      return { kind: 'native', sessionId: lastSessionId, ...tools };
    }
    return null;
  };

  try {
    // Immediate liveness yield: session.ts races the FIRST pull against a
    // 4-minute silent-stream watchdog, and grok's first event can itself
    // take minutes. Yielding at spawn wins that race deterministically
    // instead of depending on grok's latency.
    yield { kind: 'tool', toolName: 'turn started', sessionId };

    let sawOutput = false;
    let buf = '';
    for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
      if (!sawOutput) {
        sawOutput = true;
        if (hangTimer) {
          clearTimeout(hangTimer);
          hangTimer = undefined;
        }
      }
      buf += chunk.toString();
      const parts = buf.split('\n');
      buf = parts.pop() ?? '';
      for (const line of parts) {
        const trimmed = line.trim();
        if (!trimmed?.startsWith('{')) continue;
        let ev: Record<string, unknown>;
        try {
          ev = JSON.parse(trimmed);
        } catch {
          continue;
        }
        const out = handleEvent(ev);
        if (out) yield out;
      }
    }
    const tail = buf.trim();
    if (tail?.startsWith('{')) {
      try {
        const out = handleEvent(JSON.parse(tail) as Record<string, unknown>);
        if (out) yield out;
      } catch {
        /* not JSON, skip */
      }
    }
  } finally {
    clearTimeout(timer);
    if (hangTimer) clearTimeout(hangTimer);
    unsubscribeAbort();
    proc.stop();
    if (child.exitCode === null && child.signalCode === null) {
      // NOT confirmed dead. Either the consumer abandoned this stream
      // mid-turn (session.ts's silent abort calls iterator.return(), the
      // mailbox closes, or an error is thrown downstream) — kill it, WITH
      // the SIGKILL escalation — or a SIGTERM from the timeout/hang/abort
      // is still inside its grace period: leave that escalation armed,
      // since clearing it here would orphan a CLI that ignores SIGTERM and
      // then wait on `exitPromise` forever (same fix as codex/kimi/pi-rpc).
      if (!child.killed) killChild();
    } else if (killTimer) {
      clearTimeout(killTimer);
    }
  }

  const exitCode = await exitPromise;
  if (killTimer) clearTimeout(killTimer);
  outcome.sessionId = lastSessionId;
  outcome.exitCode = exitCode;
  outcome.stderrTail = stderrTail;
  outcome.timedOut = timedOut;
  outcome.hangSuspected = hangSuspected;
}

/** Build the actionable error for a failed grok turn. */
export function turnError(outcome: TurnOutcome, round: number): Error {
  if (outcome.hangSuspected) {
    return new Error(
      `GrokAgentRunner: grok produced no output within ${STARTUP_GRACE_MS / 1000}s and was killed. ` +
        'This usually means it is stuck on a first-run interactive prompt (trust/telemetry gate) ' +
        'that headless mode has no way to answer. Run `grok` once manually in a real terminal in ' +
        `this project to accept any prompts, then retry.${outcome.stderrTail ? `\nstderr: ${outcome.stderrTail.slice(-500)}` : ''}`,
    );
  }
  // Fatal provider errors (auth/permission/quota — classified from the error
  // field AND stderr): report what actually happened, and tag the error so
  // the daemon does NOT restart into the same guaranteed failure (a restart
  // on quota exhaustion can only hang or fail again).
  const cls = classifyStderr(`${outcome.error ?? ''}\n${outcome.stderrTail}`);
  if (cls.fatal) {
    const err = new Error(
      `GrokAgentRunner: FATAL provider error (${cls.label}) on turn ${round} — not retrying.` +
        (outcome.error ? ` error: ${outcome.error}` : '') +
        (outcome.stderrTail ? ` stderr: ${outcome.stderrTail.slice(-500)}` : ''),
    );
    (err as Error & { fatal?: boolean }).fatal = true;
    return err;
  }
  return new Error(
    `GrokAgentRunner: grok failed (exit ${outcome.exitCode})` +
      (outcome.timedOut
        ? ` — killed after exceeding the ${TURN_TIMEOUT_MS / 3_600_000}h turn timeout`
        : '') +
      (outcome.error ? `: ${outcome.error}` : '') +
      (outcome.stderrTail ? `\nstderr: ${outcome.stderrTail.slice(-500)}` : ''),
  );
}
