// packages/@monomind/cli/src/orgrt/copilot-runner-stream.ts
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentRunArgs } from './agent-runner.js';
import { killOnAbort } from './agent-runner.js';
import { maskedCommand } from './authority-mask.js';
import { handleLine, parseCopilotUsage } from './copilot-runner-parse.js';
import type { CopilotStreamEvent, TurnOutcome } from './copilot-runner-types.js';
import type { OrgEffortLevel } from './cost-tier.js';
import { classifyStderr } from './kimicode-runner.js';
import { spawnRunnerProcess } from './process-group-spawn.js';
import { omitAnthropicManagedKeys } from './provider.js';

export const TURN_TIMEOUT_MS = 2 * 60 * 60 * 1000;
/** Distinct from TURN_TIMEOUT_MS: catches a hung first-run interactive prompt
 *  fast instead of waiting out the full turn timeout. Any output at all
 *  disarms it. Copilot CLI has a DOCUMENTED bug where its directory-trust
 *  and path-access prompts can hang indefinitely in CI/headless invocations
 *  with no way to answer them — this is the primary mitigation for copilot
 *  specifically, not just a defensive backstop. */
export const STARTUP_GRACE_MS = 45_000;

/** `copilot --reasoning-effort`: none|minimal|low|medium|high|xhigh|max. */
const COPILOT_EFFORT: Record<OrgEffortLevel, string> = {
  off: 'none',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
};

/**
 * Run one `copilot` invocation and stream its NDJSON output
 * INCREMENTALLY: each parsed line is yielded as soon as it arrives on
 * stdout (see the header's "Streaming / liveness" note for why buffering
 * until process exit was a bug, #204). End-of-turn facts (exit code,
 * stderr tail, timeout/hang flags) are written into `outcome`, which the
 * caller reads after this generator completes.
 */
export async function* streamTurn(
  bin: string,
  prompt: string,
  sessionId: string | undefined,
  args: AgentRunArgs,
  outcome: TurnOutcome,
): AsyncGenerator<CopilotStreamEvent> {
  // #181: copilot writes this invocation's real token counts here on exit.
  // Per-turn unique path so concurrent roles can't clobber each other's.
  const usageFile = join(tmpdir(), `monomind-copilot-usage-${randomUUID()}.json`);
  const cliArgs: string[] = [
    '-p',
    prompt,
    '--output-format',
    'json',
    '-s',
    // Full access: --allow-all (tools + every path + every URL), so a
    // headless turn never stops on a path/URL approval it cannot answer.
    args.access === 'full' ? '--allow-all' : '--allow-all-tools',
    '--no-ask-user',
    '--usage-output-file',
    usageFile,
  ];
  if (args.model) cliArgs.push(`--model=${args.model}`);
  if (args.effort) cliArgs.push('--reasoning-effort', COPILOT_EFFORT[args.effort]);
  // `=` form: --resume takes an optional value.
  if (sessionId) cliArgs.push(`--resume=${sessionId}`);
  cliArgs.push('--add-dir', args.cwd);

  // Process-group leader under --access full (process-group-spawn.ts).
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
  let sawOutput = false;
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

  let stdoutDrained = false;
  try {
    // Immediate liveness yield: session.ts races the FIRST pull from this
    // runner against a 4-minute silent-stream watchdog, and copilot's
    // first line can itself take minutes. Yielding at spawn wins that
    // race deterministically instead of depending on copilot's latency.
    yield { kind: 'tool', toolName: 'turn started' };

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
        const out = handleLine(line);
        if (out) yield out;
      }
    }
    if (buf.trim()) {
      const out = handleLine(buf);
      if (out) yield out;
    }
    stdoutDrained = true;
  } finally {
    // #181: on the normal path the usage file is read and removed after
    // the exit-code await below. If the consumer abandoned this stream
    // mid-turn (iterator.return()), nothing past this block runs — drop
    // the temp file here so it can't leak.
    if (!stdoutDrained) rmSync(usageFile, { force: true });
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
  outcome.timedOut = timedOut;
  outcome.hangSuspected = hangSuspected;
  // #181: copilot writes the usage file as it shuts down, so read it only
  // now that the process has actually exited. A missing/unreadable file
  // leaves outcome.usage undefined — the caller adds nothing rather than
  // adding a fabricated 0.
  try {
    outcome.usage = parseCopilotUsage(readFileSync(usageFile, 'utf8'));
  } catch {
    /* copilot wrote no usage file for this turn */
  } finally {
    rmSync(usageFile, { force: true });
  }
}

/** Build the actionable error for a failed copilot turn (hangSuspected is
 *  handled separately by the caller — it has its own, more specific message). */
export function turnError(outcome: TurnOutcome): Error {
  // #181: a copilot build predating `--usage-output-file` rejects it at
  // argv-parse time, before any model call — so nothing was spent and the
  // fix is a one-liner for the operator. Say so instead of letting the
  // generic "exit 1" message bury it, and do NOT silently retry without the
  // flag: a copilot role that reports 0 tokens forever is precisely the
  // silently-disabled budget cap this failure mode exists to prevent.
  if (outcome.stderrTail.includes("unknown option '--usage-output-file'")) {
    return new Error(
      'CopilotAgentRunner: this copilot CLI is too old — it does not support ' +
        '--usage-output-file, which this runner requires to report real token usage ' +
        '(without it a copilot role would report 0 tokens and its budget cap would never ' +
        'engage). Run `copilot update` (or npm install -g @github/copilot) and retry.',
    );
  }
  // Fatal provider errors (auth/permission/quota — classified from stderr):
  // report what actually happened, and tag the error so the daemon does NOT
  // restart into the same guaranteed failure (a restart on quota exhaustion
  // can only hang or fail again).
  const cls = classifyStderr(outcome.stderrTail);
  if (cls.fatal) {
    const err = new Error(
      `CopilotAgentRunner: FATAL provider error (${cls.label}) — not retrying.` +
        (outcome.stderrTail ? ` stderr: ${outcome.stderrTail.slice(-500)}` : ''),
    );
    (err as Error & { fatal?: boolean }).fatal = true;
    return err;
  }
  return new Error(
    `CopilotAgentRunner: copilot failed (exit ${outcome.exitCode})` +
      (outcome.timedOut
        ? ` — killed after exceeding the ${TURN_TIMEOUT_MS / 3_600_000}h turn timeout`
        : '') +
      (outcome.stderrTail ? `\nstderr: ${outcome.stderrTail.slice(-500)}` : ''),
  );
}
