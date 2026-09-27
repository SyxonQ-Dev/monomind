// packages/@monomind/cli/src/orgrt/qwen-runner-stream.ts
// Split out of qwen-runner.ts (file-size sweep) — the `qwen` subprocess turn
// runner (streamTurn) and the turn-failure error builder (turnError).
// streamTurn does not reference `this` — it was a private method purely for
// grouping, so moving it to a standalone function changes nothing observable;
// the class in qwen-runner.ts now calls it as an imported function.
import { spawn } from 'node:child_process';
import type { AgentRunArgs } from './agent-runner.js';
import { killOnAbort } from './agent-runner.js';
import { maskedCommand } from './authority-mask.js';
import { classifyStderr } from './kimicode-runner.js';
import { omitAnthropicManagedKeys } from './provider.js';
import {
  handleQwenEvent,
  type QwenEvent,
  type QwenStreamEvent,
  type TurnOutcome,
} from './qwen-runner-parse.js';

const TURN_TIMEOUT_MS = 2 * 60 * 60 * 1000;
/** Distinct from TURN_TIMEOUT_MS: catches a hung first-run interactive prompt
 *  (trust/telemetry gate) fast instead of waiting out the full turn timeout.
 *  Fires only if the process has produced ZERO stdout by this point — any
 *  output at all disarms it, since a slow model response is not a hang.
 *  Exported: qwen-runner.ts's run() uses it to word the hang error message. */
export const STARTUP_GRACE_MS = 45_000;

/**
 * Run one `qwen` invocation and stream its stream-json output
 * INCREMENTALLY: each parsed event is yielded as soon as its line arrives
 * on stdout (see qwen-runner.ts's header "Streaming / liveness" note for why
 * buffering until process exit was a bug, #204). End-of-turn facts (exit
 * code, stderr tail, session id, usage, error, timeout/hang flags) are
 * written into `outcome`, which the caller reads after this generator
 * completes.
 */
export async function* streamTurn(
  bin: string,
  prompt: string,
  sessionId: string | undefined,
  args: AgentRunArgs,
  outcome: TurnOutcome,
): AsyncGenerator<QwenStreamEvent> {
  const cliArgs: string[] = ['-p', prompt, '--output-format', 'stream-json', '--yolo'];
  if (args.model) cliArgs.push('-m', args.model);
  if (sessionId) cliArgs.push('--resume', sessionId);

  const child = spawn(...maskedCommand(args.authorityMask, bin, cliArgs), {
    cwd: args.cwd,
    // o-18: ambient ANTHROPIC_* creds never belong to a non-Anthropic
    // vendor CLI; an explicit value in args.env still wins below.
    env: { ...omitAnthropicManagedKeys(process.env), ...args.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

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
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
    killTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, KILL_GRACE_MS);
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
  const unsubscribeAbort = killOnAbort(args.signal, child, KILL_GRACE_MS);

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

  try {
    // Immediate liveness yield: session.ts races the FIRST pull against a
    // 4-minute silent-stream watchdog, and qwen's first stdout line can
    // itself take minutes (long thinking chains, large file reads).
    // Yielding at spawn wins that race deterministically instead of
    // depending on qwen's latency.
    yield { kind: 'tool', toolName: 'turn started', sessionId };

    let buf = '';
    for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
      // Any stdout at all disarms the hang-suspicion timer — see
      // STARTUP_GRACE_MS.
      if (hangTimer) {
        clearTimeout(hangTimer);
        hangTimer = undefined;
      }
      buf += chunk.toString();
      const parts = buf.split('\n');
      buf = parts.pop() ?? '';
      for (const line of parts) {
        const trimmed = line.trim();
        if (!trimmed?.startsWith('{')) continue;
        let ev: QwenEvent;
        try {
          ev = JSON.parse(trimmed) as QwenEvent;
        } catch {
          continue;
        }
        const out = handleQwenEvent(ev, outcome);
        if (out) {
          if (out.sessionId) lastSessionId = out.sessionId;
          yield out;
        }
      }
    }
    const tail = buf.trim();
    if (tail?.startsWith('{')) {
      try {
        const out = handleQwenEvent(JSON.parse(tail) as QwenEvent, outcome);
        if (out) {
          if (out.sessionId) lastSessionId = out.sessionId;
          yield out;
        }
      } catch {
        /* not JSON, skip */
      }
    }
  } finally {
    clearTimeout(timer);
    if (hangTimer) clearTimeout(hangTimer);
    unsubscribeAbort();
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

/** Build the actionable error for a failed qwen turn. */
export function turnError(outcome: TurnOutcome, round: number): Error {
  if (outcome.timedOut) {
    return new Error(
      `QwenAgentRunner: qwen turn (tool round ${round}) exceeded the ${TURN_TIMEOUT_MS / 3_600_000}h ` +
        `turn timeout and was killed.${outcome.stderrTail ? ` stderr: ${outcome.stderrTail.slice(-500)}` : ''}`,
    );
  }
  // Fatal provider errors (auth/permission/quota — classified from the error
  // field AND stderr): report what actually happened, and tag the error so
  // the daemon does NOT restart into the same guaranteed failure (a restart
  // on quota exhaustion can only hang or fail again).
  const cls = classifyStderr(`${outcome.error ?? ''}\n${outcome.stderrTail}`);
  if (cls.fatal) {
    const err = new Error(
      `QwenAgentRunner: FATAL provider error (${cls.label}) on turn ${round} — not retrying.` +
        (outcome.error ? ` error: ${outcome.error}` : '') +
        (outcome.stderrTail ? ` stderr: ${outcome.stderrTail.slice(-500)}` : ''),
    );
    (err as Error & { fatal?: boolean }).fatal = true;
    return err;
  }
  return new Error(
    `QwenAgentRunner: qwen failed (exit ${outcome.exitCode})` +
      (outcome.error ? `: ${outcome.error}` : '') +
      (outcome.stderrTail ? `\nstderr: ${outcome.stderrTail.slice(-500)}` : ''),
  );
}
