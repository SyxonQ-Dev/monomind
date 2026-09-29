// packages/@monomind/cli/src/orgrt/pi-runner-stream.ts
import type { AgentRunArgs } from './agent-runner.js';
import { killOnAbort } from './agent-runner.js';
import { maskedCommand } from './authority-mask.js';
import { classifyStderr } from './kimicode-runner.js';
import { parsePiLine } from './pi-runner-parse.js';
import {
  type PiRunTracker,
  type PiTextStream,
  type PiTurnBudget,
  piCliArgs,
} from './pi-runner-state.js';
import { spawnRunnerProcess } from './process-group-spawn.js';
import { omitAnthropicManagedKeys } from './provider.js';

export const TURN_TIMEOUT_MS = 2 * 60 * 60 * 1000;
/** Distinct from TURN_TIMEOUT_MS: catches a hung first-run interactive prompt
 *  fast instead of waiting out the full turn timeout. Any output at all
 *  disarms it. `--mode json` never shows the trust prompt (pi
 *  docs/security.md), and the runner always passes --approve/--no-approve,
 *  so this is a defensive backstop. */
export const STARTUP_GRACE_MS = 45_000;

/**
 * One parsed pi stream event, normalized for incremental streaming.
 *   - 'assistant': rawText is one whole message_end text (fences intact) for
 *     end-of-turn tool-call parsing, absent on a text_delta increment; text
 *     is the prose to show now (fence-stripped), when there is any.
 *   - 'native':    pi's own tool call starting (`toolStart`) or ending
 *     (`toolEnd`), paired by toolCallId.
 *   - 'tool':      the spawn-time liveness yield — forwarded by run() as a
 *     `tool_use` liveness AgentMessage (see header).
 */
export interface PiStreamEvent {
  kind: 'assistant' | 'native' | 'tool';
  text?: string;
  rawText?: string;
  toolName?: string;
  toolStart?: { id: string; name: string; input: unknown };
  toolEnd?: { id: string; output: unknown; isError: boolean };
}

export interface TurnOutcome {
  exitCode: number;
  stderrTail: string;
  timedOut: boolean;
  /** True when the process was killed by STARTUP_GRACE_MS with no output —
   *  likely stuck on a first-run interactive prompt headless mode can't answer. */
  hangSuspected: boolean;
  /** The `session` header's id. */
  sessionId?: string;
}

/** Per-invocation state streamTurn folds pi's events into: usage/failure/
 *  completion, visible text, and the mailbox message's turn budget (shared
 *  across its tool rounds). */
export interface PiTurnState {
  tracker: PiRunTracker;
  text: PiTextStream;
  budget: PiTurnBudget;
}

/**
 * Run one `pi` invocation and stream its `--mode json` output
 * INCREMENTALLY: each parsed event is yielded as soon as its line arrives
 * on stdout (see the header's "Streaming / liveness" note for why
 * buffering until process exit was a bug, #204). End-of-turn facts (exit
 * code, stderr tail, timeout/hang flags) are written into `outcome`, usage
 * and completion into `state.tracker`; the caller reads both after this
 * generator completes.
 */
export async function* streamTurn(
  bin: string,
  prompt: string,
  sessionId: string,
  args: AgentRunArgs,
  outcome: TurnOutcome,
  state: PiTurnState,
): AsyncGenerator<PiStreamEvent> {
  // `--` ends option parsing so a prompt starting with '-' stays a message
  // (pi docs/cli.md); the prompt is always last.
  const cliArgs = [...piCliArgs('json', sessionId, args), '--', prompt];

  // Process-group leader under --access full (process-group-spawn.ts).
  const proc = spawnRunnerProcess(
    ...maskedCommand(args.authorityMask, bin, cliArgs),
    {
      cwd: args.cwd,
      // PI_TELEMETRY/PI_SKIP_VERSION_CHECK: confirmed via pi's own docs —
      // suppresses install/update telemetry and version-check network calls
      // that otherwise add latency/flakiness to every headless turn.
      // o-18: ambient ANTHROPIC_* creds never belong to a non-Anthropic
      // vendor CLI; an explicit value in args.env still wins below.
      env: {
        ...omitAnthropicManagedKeys(process.env),
        PI_TELEMETRY: '0',
        PI_SKIP_VERSION_CHECK: '1',
        ...args.env,
      },
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
  // (ENOENT, bad binary) the 'error' event fires almost immediately —
  // if no listener is attached yet it escapes as an unhandled 'error'
  // event and crashes the process instead of reaching our catch block.
  const exitPromise = new Promise<number>((res, rej) => {
    child.on('error', rej);
    child.on('close', (code) => res(code ?? 1));
  });
  // Prevent an unhandled-rejection crash if the stdout loop below throws
  // before we await exitPromise (the await still sees the rejection).
  exitPromise.catch(() => {});

  // Emit one parsed line as PiStreamEvents (if any) and fold it into
  // `state` as a side effect — shared by the main stdout loop and the final
  // partial-line flush below.
  function* emit(line: string): Generator<PiStreamEvent> {
    const parsed = parsePiLine(line);
    if (!parsed) return;
    if (parsed.sessionId) outcome.sessionId = parsed.sessionId;
    state.tracker.observe(parsed);
    // Emulated max turns: abort the turn past the cap through the
    // process-group target (the whole tree under --access full).
    if (state.budget.observe(parsed)) killChild();
    if (parsed.assistantStart) state.text.messageStart();
    if (parsed.textDelta) {
      const inc = state.text.delta(parsed.textDelta.index, parsed.textDelta.delta);
      if (inc) yield { kind: 'assistant', text: inc };
    }
    if (parsed.assistantEnd) {
      const raw = parsed.assistantText ?? '';
      const text = state.text.messageEnd(raw);
      if (raw || text) yield { kind: 'assistant', rawText: raw || undefined, text };
    }
    if (parsed.toolStart || parsed.toolEnd) {
      proc.sampleNow();
      yield { kind: 'native', toolStart: parsed.toolStart, toolEnd: parsed.toolEnd };
    }
  }

  try {
    // Immediate liveness yield: session.ts races the FIRST pull against a
    // 4-minute silent-stream watchdog, and pi's first event can itself
    // take minutes (long thinking chains, large file reads). Yielding at
    // spawn wins that race deterministically instead of depending on
    // pi's latency.
    yield { kind: 'tool', toolName: 'turn started' };

    let buf = '';
    for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
      if (hangTimer) {
        clearTimeout(hangTimer);
        hangTimer = undefined;
      }
      buf += chunk.toString();
      const parts = buf.split('\n');
      buf = parts.pop() ?? '';
      for (const line of parts) {
        yield* emit(line);
      }
    }
    if (buf.trim()) yield* emit(buf);
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
  outcome.exitCode = exitCode;
  outcome.stderrTail = stderrTail;
  // Text a fence or trailing whitespace held back until now.
  const rest = state.text.flush();
  if (rest) yield { kind: 'assistant', text: rest };
  outcome.timedOut = timedOut;
  outcome.hangSuspected = hangSuspected;
}

/** Build the actionable error for a failed pi turn. `failure` is the error
 *  pi reported in the stream (a final assistant error or a failed
 *  auto-retry) — pi exits 0 on those, so stderr alone misses them. */
export function turnError(outcome: TurnOutcome, round: number, failure?: string): Error {
  if (outcome.timedOut) {
    return new Error(
      `PiAgentRunner: pi turn (tool round ${round}) exceeded the ${TURN_TIMEOUT_MS / 3_600_000}h turn timeout ` +
        `and was killed.${outcome.stderrTail ? ` stderr: ${outcome.stderrTail.slice(-500)}` : ''}`,
    );
  }
  const detail =
    (failure ? ` error: ${failure.slice(-500)}` : '') +
    (outcome.stderrTail ? `\nstderr: ${outcome.stderrTail.slice(-500)}` : '');
  // Fatal provider errors (auth/permission/quota): report what actually
  // happened, and tag the error so the daemon does NOT restart into the
  // same guaranteed failure (a restart on quota exhaustion can only hang or
  // fail again).
  const cls = classifyStderr(`${failure ?? ''}\n${outcome.stderrTail}`);
  if (cls.fatal) {
    const err = new Error(
      `PiAgentRunner: FATAL provider error (${cls.label}) on turn ${round} — not retrying.${detail}`,
    );
    (err as Error & { fatal?: boolean }).fatal = true;
    return err;
  }
  return new Error(
    failure
      ? `PiAgentRunner: pi reported an error on turn ${round}.${detail}`
      : `PiAgentRunner: pi failed (exit ${outcome.exitCode})${detail}`,
  );
}
