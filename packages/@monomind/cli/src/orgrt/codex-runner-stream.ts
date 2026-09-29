// packages/@monomind/cli/src/orgrt/codex-runner-stream.ts
import { spawn } from 'node:child_process';
import type { AgentRunArgs } from './agent-runner.js';
import { killOnAbort } from './agent-runner.js';
import { maskedCommand } from './authority-mask.js';
import { codexSandboxArgs, roleGitLevel } from './cli-sandbox.js';
import { codexEffortArgs } from './codex-runner-tools.js';
import type { CodexEvent, CodexStreamEvent, TurnOutcome } from './codex-runner-types.js';
import { classifyStderr } from './kimicode-runner.js';
import { omitAnthropicManagedKeys } from './provider.js';
import { TOOL_CALL_RE } from './tool-fence.js';

export const TURN_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours, matching kimi/antigravity runners

/**
 * Run one `codex exec` invocation and stream its JSONL output
 * INCREMENTALLY: each parsed event is yielded as soon as its line arrives
 * on stdout (see the header's "Streaming / liveness" note for why
 * buffering until process exit was a bug, #204). End-of-turn facts (exit
 * code, stderr tail, thread id, usage, error, timeout flag) are written
 * into `outcome`, which the caller reads after this generator completes.
 */
export async function* streamTurn(
  bin: string,
  prompt: string,
  threadId: string | undefined,
  args: AgentRunArgs,
  outcome: TurnOutcome,
): AsyncGenerator<CodexStreamEvent> {
  // ARG ORDER — see file header for the live-verified citation:
  //   codex exec --json [--model X] [-c model_reasoning_effort=L] [--cd Y]
  //              [--skip-git-repo-check] [--sandbox <mode>]
  //              [resume <threadId>] -- -
  // The prompt goes over STDIN, not argv: a single argv element is capped
  // at 128 KiB on Linux (E2BIG), and a system prompt + tool protocol +
  // tool results routinely exceeds that. `-` is codex's documented "read
  // instructions from stdin" marker on both `exec` and `exec resume`
  // (confirmed live, v0.153.2); `--` ends option parsing so nothing
  // positional is ever mistaken for a flag.
  const cliArgs: string[] = ['exec', '--json'];
  if (args.model) cliArgs.push('--model', args.model);
  cliArgs.push(...codexEffortArgs(args.effort));
  cliArgs.push('--cd', args.cwd);
  cliArgs.push('--skip-git-repo-check');
  // #263: codex's own sandbox follows the role's policy.git level — only a
  // 'push' role still gets danger-full-access. See cli-sandbox.ts.
  cliArgs.push(...codexSandboxArgs(roleGitLevel(args.env)));
  if (threadId) {
    cliArgs.push('resume', threadId);
  }
  cliArgs.push('--', '-');

  const child = spawn(...maskedCommand(args.authorityMask, bin, cliArgs), {
    cwd: args.cwd,
    // o-18: ambient ANTHROPIC_* creds never belong to a non-Anthropic
    // vendor CLI; an explicit value in args.env still wins below.
    env: { ...omitAnthropicManagedKeys(process.env), ...args.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  // A CLI that exits before reading stdin (bad args, auth failure) makes
  // this write EPIPE — surfaced via the exit code/stderr below, not as an
  // unhandled stream error.
  child.stdin?.on('error', () => {});
  child.stdin?.end(prompt);

  let stderrTail = '';
  child.stderr?.on('data', (c: Buffer) => {
    stderrTail = (stderrTail + c.toString()).slice(-4000);
  });

  // SIGTERM→SIGKILL escalation, shared by the turn timeout, the abort
  // signal, and the abandoned-stream path in `finally` — a CLI that
  // ignores SIGTERM must not leak a zombie per turn.
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

  // Arm the turn timeout BEFORE consuming stdout — a hung CLI must be
  // killed while we're still reading, not after it finishes.
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killChild();
  }, TURN_TIMEOUT_MS);
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

  let lastThreadId: string | undefined = threadId;

  // Normalize one parsed wire event: capture the thread id from ANY event
  // that carries it (resume needs it on the next turn), record
  // error/usage state, and return the CodexStreamEvent to yield (or null).
  const handleEvent = (ev: CodexEvent): CodexStreamEvent | null => {
    if (
      (ev.type === 'session_configured' || ev.type === 'thread.started') &&
      (ev.session_id || ev.thread_id)
    ) {
      // LEGACY: session_configured.session_id/.thread_id
      // CURRENT: thread.started.thread_id
      lastThreadId = ev.session_id ?? ev.thread_id;
      return null;
    }
    if (ev.type === 'agent_message' && ev.message) {
      // LEGACY: top-level agent_message.message — whole message, no delta
      // accumulation needed.
      const stripped = ev.message.replace(TOOL_CALL_RE, '').trim();
      return {
        kind: 'assistant',
        rawText: ev.message,
        text: stripped || undefined,
        threadId: lastThreadId,
      };
    }
    if (ev.type === 'item.completed' && ev.item?.type === 'agent_message' && ev.item.text) {
      // CURRENT: item.completed with item.type === 'agent_message' — same
      // whole-message shape as legacy, different envelope.
      const stripped = ev.item.text.replace(TOOL_CALL_RE, '').trim();
      return {
        kind: 'assistant',
        rawText: ev.item.text,
        text: stripped || undefined,
        threadId: lastThreadId,
      };
    }
    if (ev.type === 'item.started' && ev.item?.type === 'command_execution') {
      // CURRENT: liveness for codex's own shell tool calls — mirrors
      // agy's 'tool' step_type forwarding (header's "Streaming / liveness"
      // note). Only item.started fires this (not item.completed too) to
      // avoid a duplicate liveness ping per command.
      return {
        kind: 'tool',
        toolName: (ev.item.command ?? 'shell').slice(0, 200),
        threadId: lastThreadId,
      };
    }
    if (ev.type === 'token_count' && ev.info?.last_token_usage) {
      // LEGACY: last_token_usage is per-TURN; total_token_usage is
      // cumulative for the whole session — using the latter here would
      // over-report on every turn after the first.
      outcome.inputTokens = ev.info.last_token_usage.input_tokens ?? 0;
      outcome.outputTokens = ev.info.last_token_usage.output_tokens ?? 0;
      return null;
    }
    if (ev.type === 'turn.completed' && ev.usage) {
      // CURRENT: turn.completed.usage — observed to stay roughly flat
      // across resumed turns rather than accumulate, i.e. per-turn like
      // legacy's last_token_usage (see file header).
      outcome.inputTokens = ev.usage.input_tokens ?? 0;
      outcome.outputTokens = ev.usage.output_tokens ?? 0;
      return null;
    }
    if (ev.type === 'task_complete') {
      // LEGACY only — CURRENT has no observed equivalent completion event
      // carrying an error; see file header on error handling.
      if (ev.error) outcome.error = ev.error.message;
      // last_agent_message is a convenience summary already covered by the
      // agent_message events collected above — not surfaced again here to
      // avoid duplicating the same text.
      return null;
    }
    if (ev.type === 'error' && ev.message) {
      outcome.error = ev.message;
      return null;
    }
    return null;
  };

  try {
    // Immediate liveness yield: session.ts races the FIRST pull against a
    // 4-minute silent-stream watchdog, and codex's first event can itself
    // take minutes (long thinking chains, large file reads). Yielding at
    // spawn wins that race deterministically instead of depending on
    // codex's latency.
    yield { kind: 'tool', toolName: 'turn started', threadId };

    let buf = '';
    for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
      buf += chunk.toString();
      const parts = buf.split('\n');
      buf = parts.pop() ?? '';
      for (const line of parts) {
        const trimmed = line.trim();
        if (!trimmed?.startsWith('{')) continue;
        let ev: CodexEvent;
        try {
          ev = JSON.parse(trimmed) as CodexEvent;
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
        const out = handleEvent(JSON.parse(tail) as CodexEvent);
        if (out) yield out;
      } catch {
        /* not JSON, skip */
      }
    }
  } finally {
    clearTimeout(timer);
    unsubscribeAbort();
    if (child.exitCode === null && child.signalCode === null) {
      // NOT confirmed dead. Either the consumer abandoned this stream
      // mid-turn (session.ts's silent abort calls iterator.return(), the
      // mailbox closes, or an error is thrown downstream) — kill it, WITH
      // the SIGKILL escalation — or a SIGTERM from the timeout/abort is
      // still inside its grace period: leave that escalation armed, since
      // clearing it here would orphan a CLI that ignores SIGTERM and then
      // wait on `exitPromise` forever (same fix as pi-rpc-runner.ts).
      if (!child.killed) killChild();
    } else if (killTimer) {
      clearTimeout(killTimer);
    }
  }

  const exitCode = await exitPromise;
  if (killTimer) clearTimeout(killTimer);
  outcome.threadId = lastThreadId;
  outcome.exitCode = exitCode;
  outcome.stderrTail = stderrTail;
  outcome.timedOut = timedOut;
}

/** Build the actionable error for a failed codex turn. */
export function turnError(outcome: TurnOutcome, round: number, _bin: string): Error {
  if (outcome.timedOut) {
    return new Error(
      `CodexAgentRunner: codex turn (tool round ${round}) exceeded the ${Math.round(TURN_TIMEOUT_MS / 60000)}min ` +
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
      `CodexAgentRunner: FATAL provider error (${cls.label}) on turn ${round} — not retrying.` +
        (outcome.error ? ` error: ${outcome.error}` : '') +
        (outcome.stderrTail ? ` stderr: ${outcome.stderrTail.slice(-500)}` : ''),
    );
    (err as Error & { fatal?: boolean }).fatal = true;
    return err;
  }
  return new Error(
    `CodexAgentRunner: codex exec failed (exit ${outcome.exitCode})` +
      (outcome.error ? `: ${outcome.error}` : '') +
      (outcome.stderrTail ? `\nstderr: ${outcome.stderrTail.slice(-500)}` : ''),
  );
}
