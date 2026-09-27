// packages/@monomind/cli/src/orgrt/kimicode-runner-stream.ts
// Split out of kimicode-runner.ts (file-size sweep) — the `kimi` subprocess
// turn runner (streamTurn), usage-file reader (readUsageDelta), and the
// turn-failure error builder (turnError). streamTurn was a private method
// that only used `this.emptySkillsDir`; that one field is now an explicit
// parameter, so the class in kimicode-runner.ts calls it as an imported
// function — no other behavior changes.
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentRunArgs } from './agent-runner.js';
import { killOnAbort } from './agent-runner.js';
import { maskedCommand } from './authority-mask.js';
import type { KimiStreamEvent } from './kimicode-runner-parse.js';
import {
  classifyStderr,
  extractStderrSessionId,
  parseStreamJsonLine,
} from './kimicode-runner-parse.js';
import { omitAnthropicManagedKeys } from './provider.js';

/** How long a single `kimi --print` invocation may run before we kill it (2 hours,
 *  matching kimi's own subagent default). */
const TURN_TIMEOUT_MS = 2 * 60 * 60 * 1000;

export interface TurnOutcome {
  sessionId?: string;
  exitCode: number;
  stderrTail: string;
  timedOut: boolean;
}

/**
 * Run one `kimi -p` invocation and stream its stream-json output
 * INCREMENTALLY: each parsed event is yielded as soon as its line arrives
 * on stdout (see kimicode-runner.ts's header "Streaming / liveness" note for
 * why buffering until process exit was a bug). End-of-turn facts (exit code,
 * stderr tail, final session id, timeout flag) are written into `outcome`,
 * which the caller reads after this generator completes.
 */
export async function* streamTurn(
  bin: string,
  promptText: string,
  sessionId: string | undefined,
  args: AgentRunArgs,
  agentFile: string,
  emptySkillsDir: string,
  outcome: TurnOutcome,
): AsyncGenerator<KimiStreamEvent> {
  // The prompt goes over STDIN, not `-p <text>`: a single argv element is
  // capped at 128 KiB on Linux (E2BIG), and a tool-results prompt can
  // exceed that. In `--print` mode kimi reads all of stdin as the prompt
  // when no `-p` is given (kimi-cli ui/print: `command is None and not
  // sys.stdin.isatty()` → `sys.stdin.read()`); `--output-format` is only
  // accepted in print mode anyway.
  const cliArgs: string[] = [
    '--print',
    '--output-format',
    'stream-json',
    '--skills-dir',
    emptySkillsDir,
  ];
  if (sessionId) {
    cliArgs.push('--session', sessionId);
  } else {
    // First turn: bind the role's system prompt via --agent-file.
    // (--agent-file and --session/--continue are mutually exclusive.)
    cliArgs.push('--agent-file', agentFile);
  }
  // Model only on the first turn: the session binds it at creation and
  // kimi rejects model changes on resume.
  if (args.model && !sessionId) cliArgs.push('--model', args.model);

  const child = spawn(...maskedCommand(args.authorityMask, bin, cliArgs), {
    cwd: args.cwd,
    env: {
      // o-18: ambient ANTHROPIC_* creds never belong to a non-Anthropic
      // vendor CLI; an explicit value in args.env still wins below.
      ...omitAnthropicManagedKeys(process.env),
      ...args.env,
      // --agent-file (the role's system prompt) requires kimi's v2
      // engine; without this the CLI exits 1 with
      // "--agent-file is only available with the v2 engine".
      KIMI_CODE_EXPERIMENTAL_FLAG: process.env.KIMI_CODE_EXPERIMENTAL_FLAG || '1',
      // Org sessions are single-purpose: each resumed turn re-reads the
      // whole session history, and keeping prior turns' thinking
      // ("thinkingKeep: all") inflates every request's cache reads.
      // Org roles don't need reasoning continuity between turns — the
      // mailbox + session history carry the state.
      KIMI_MODEL_THINKING_KEEP: process.env.KIMI_MODEL_THINKING_KEEP || 'off',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  // A CLI that exits before reading stdin (bad args, auth failure) makes
  // this write EPIPE — surfaced via the exit code/stderr below, not as an
  // unhandled stream error.
  child.stdin?.on('error', () => {});
  child.stdin?.end(promptText);

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

  let lastSessionId: string | undefined;
  try {
    // Immediate liveness yield: session.ts races the FIRST pull against a
    // 4-minute silent-stream watchdog, and the model's first event can
    // itself take minutes (long thinking chains). Yielding at spawn wins
    // that race deterministically instead of depending on kimi's latency.
    yield { kind: 'tool', toolName: 'turn started', sessionId };

    let buf = '';
    for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
      buf += chunk.toString();
      const parts = buf.split('\n');
      buf = parts.pop() ?? '';
      for (const line of parts) {
        const ev = parseStreamJsonLine(line);
        if (!ev) continue;
        if (ev.sessionId) lastSessionId = ev.sessionId;
        yield ev;
      }
    }
    if (buf.trim()) {
      const ev = parseStreamJsonLine(buf);
      if (ev) {
        if (ev.sessionId) lastSessionId = ev.sessionId;
        yield ev;
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
  // Also scan stderr for session_id — kimi 0.33+ may emit
  // session.resume_hint on stderr instead of stdout. The stdout parser
  // already captures session_id from any event that carries it; this
  // ensures we catch it regardless of which stream kimi emits it on.
  const stderrSid = extractStderrSessionId(stderrTail);
  outcome.sessionId = lastSessionId ?? stderrSid ?? sessionId;
  outcome.exitCode = exitCode;
  outcome.stderrTail = stderrTail;
  outcome.timedOut = timedOut;
}

/**
 * Sum usage.record entries in the session's wire.jsonl written at or after
 * `since` (the round's start time). Timestamp filtering (not line offsets)
 * is what makes resume safe: a resumed session's wire file already contains
 * historical entries from previous processes, and those must not be
 * double-counted. Returns zeros when the wire file can't be found — usage
 * reporting must never break a turn.
 */
export function readUsageDelta(
  sessionId: string | undefined,
  env: Record<string, string>,
  since: number,
): { input: number; output: number } {
  if (!sessionId) return { input: 0, output: 0 };
  try {
    const home =
      env.KIMI_CODE_HOME || process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code');
    const sessionsDir = path.join(home, 'sessions');
    const wirePath = findWireFile(sessionsDir, sessionId);
    if (!wirePath) return { input: 0, output: 0 };

    const lines = fs.readFileSync(wirePath, 'utf-8').split('\n').filter(Boolean);
    let input = 0,
      output = 0;
    for (const line of lines) {
      let ev: Record<string, unknown>;
      try {
        ev = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (ev.type !== 'usage.record') continue;
      if (typeof ev.time === 'number' && ev.time < since) continue;
      const u = (ev.usage ?? {}) as Record<string, number>;
      input += (u.inputOther ?? 0) + (u.inputCacheRead ?? 0) + (u.inputCacheCreation ?? 0);
      output += u.output ?? 0;
    }
    return { input, output };
  } catch {
    return { input: 0, output: 0 };
  }
}

/** Locate $KIMI_CODE_HOME/sessions/<wd>/<sessionId>/agents/main/wire.jsonl.
 *  The wd_ directory name is a hash of the cwd — scan one level instead of
 *  reimplementing the hash. */
function findWireFile(sessionsDir: string, sessionId: string): string | null {
  let wds: string[];
  try {
    wds = fs.readdirSync(sessionsDir);
  } catch {
    return null;
  }
  for (const wd of wds) {
    const candidate = path.join(sessionsDir, wd, sessionId, 'agents', 'main', 'wire.jsonl');
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/** Build the actionable error for a failed CLI turn. */
export function turnError(outcome: TurnOutcome, round: number, bin: string): Error {
  if (outcome.timedOut) {
    return new Error(
      `KimiCodeAgentRunner: kimi turn (tool round ${round}) exceeded the ${Math.round(TURN_TIMEOUT_MS / 60000)}min ` +
        `turn timeout and was killed.${outcome.stderrTail ? ` stderr: ${outcome.stderrTail.slice(-500)}` : ''}`,
    );
  }
  // Fatal provider errors: report what actually happened, and tag the error
  // so the daemon does NOT restart into the same guaranteed failure (a
  // restart on quota exhaustion can only hang or fail again).
  const cls = classifyStderr(outcome.stderrTail);
  if (cls.fatal) {
    const err = new Error(
      `KimiCodeAgentRunner: FATAL provider error (${cls.label}) on turn ${round} — not retrying.` +
        (outcome.stderrTail ? ` stderr: ${outcome.stderrTail.slice(-500)}` : ''),
    );
    (err as Error & { fatal?: boolean }).fatal = true;
    return err;
  }
  const hint =
    bin === 'kimi' || bin.endsWith('/kimi')
      ? ' Is the Kimi Code CLI installed and logged in (kimi --version, /login)?'
      : '';
  return new Error(
    `KimiCodeAgentRunner: kimi exited with code ${outcome.exitCode} (tool round ${round}).${hint}` +
      (outcome.stderrTail ? ` stderr: ${outcome.stderrTail.slice(-500)}` : ''),
  );
}
