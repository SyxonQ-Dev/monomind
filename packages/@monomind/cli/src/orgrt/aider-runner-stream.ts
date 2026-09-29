// packages/@monomind/cli/src/orgrt/aider-runner-stream.ts
/**
 * One aider invocation (monoes/monomind#383): spawn the shim (or, in the
 * fallback, the plain `aider` CLI), stream its output line by line and
 * normalize it to AiderEvent. End-of-invocation facts land in `outcome`.
 *
 * Shim mode reads the shim's own NDJSON (see aider/monomind_aider_shim.py's
 * header for the schema). Fallback mode scrapes aider's plain-text lines:
 * `Applied edit to <file>` / `Commit <hash> <msg>` become start-only tool
 * pings, `Tokens: X sent, Y received. Cost: $a message, $b session.` becomes
 * usage, and litellm's auth/quota errors (which the CLI exits 0 on) become
 * an error.
 */

import type { AgentRunArgs } from './agent-runner.js';
import { killOnAbort } from './agent-runner.js';
import { maskedCommand } from './authority-mask.js';
import { spawnRunnerProcess } from './process-group-spawn.js';
import { omitAnthropicManagedKeys } from './provider.js';
import { classifyProviderLimit } from './provider-limit.js';

export const TURN_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const KILL_GRACE_MS = 5000;
const EXIT_GRACE_MS = 15_000;

export type AiderEvent =
  | { type: 'session'; session_id: string; resumed?: boolean }
  | { type: 'status'; message: string }
  | { type: 'text'; text: string }
  | { type: 'tool_start'; id: string; name: string; kind: string; input: Record<string, unknown> }
  | { type: 'tool_end'; id: string; ok: boolean; output: string; exit_code?: number }
  | { type: 'usage'; input_tokens: number; output_tokens: number; cost_usd: number }
  | { type: 'error'; code: string; message: string }
  | { type: 'result'; stop_reason: string; text: string }
  /** Fallback only: a start-only tool ping scraped from the CLI's text. */
  | { type: 'cli_tool'; name: string };

export interface AiderOutcome {
  exitCode: number;
  stderrTail: string;
  timedOut: boolean;
  error?: { code: string; message: string };
  usage?: { input: number; output: number; usd: number };
  stopReason?: string;
}

export interface AiderInvocation {
  mode: 'shim' | 'cli';
  command: string;
  argv: string[];
  /** Written to the child's stdin, which is then closed. */
  stdin: string;
}

const SHIM_TYPES = new Set([
  'session',
  'status',
  'text',
  'tool_start',
  'tool_end',
  'usage',
  'error',
  'result',
]);

/** One shim NDJSON line → event (anything else on stdout is ignored). */
export function parseShimLine(line: string): AiderEvent | undefined {
  const t = line.trim();
  if (!t.startsWith('{')) return undefined;
  try {
    const ev = JSON.parse(t) as { type?: unknown };
    return typeof ev.type === 'string' && SHIM_TYPES.has(ev.type) ? (ev as AiderEvent) : undefined;
  } catch {
    return undefined;
  }
}

/** `2.4k` / `1.1M` / `950` → a token count. */
export function parseTokenCount(s: string): number {
  const m = /^([\d.]+)\s*([kKmM]?)$/.exec(s.trim());
  if (!m) return 0;
  const mult = m[2].toLowerCase() === 'k' ? 1_000 : m[2].toLowerCase() === 'm' ? 1_000_000 : 1;
  return Math.round(Number(m[1]) * mult);
}

const TOKENS_RE = /^Tokens: ([\d.]+[kKmM]?) sent,.*?([\d.]+[kKmM]?) received\./;
const COST_RE = /Cost: \$([\d.]+) message/;
const CLI_NOISE =
  /^(Aider v\d|Main model:|Weak model:|Editor model:|Model:|Git repo:|Repo-map:|Added .* to the chat|You can use \/undo|https:\/\/aider\.chat|Use \/help|Cur working dir:|Git working dir:|Analytics have been|Git repository created|Added \.aider\* to \.gitignore)/;

/** One plain-CLI output line → event (fallback mode). */
export function parseCliLine(line: string): AiderEvent | undefined {
  const t = line.replace(/\s+$/, '');
  if (!t.trim()) return { type: 'text', text: '\n' };
  const applied = /^Applied edit to (.+)$/.exec(t);
  if (applied) return { type: 'cli_tool', name: 'edit_file' };
  if (/^Commit [0-9a-f]{7,} /.test(t)) return { type: 'cli_tool', name: 'git_commit' };
  const tok = TOKENS_RE.exec(t);
  if (tok) {
    const cost = COST_RE.exec(t);
    return {
      type: 'usage',
      input_tokens: parseTokenCount(tok[1]),
      output_tokens: parseTokenCount(tok[2]),
      cost_usd: cost ? Number(cost[1]) : 0,
    };
  }
  if (/AuthenticationError|invalid.*api.?key|incorrect api key|api key.*not (set|found)/i.test(t)) {
    return { type: 'error', code: 'auth', message: t };
  }
  if (/RateLimitError|insufficient_quota|exceeded your current quota/i.test(t)) {
    const code = classifyProviderLimit(t) === 'rate-limited' ? 'rate-limited' : 'quota';
    return { type: 'error', code, message: t };
  }
  if (CLI_NOISE.test(t)) return undefined;
  return { type: 'text', text: `${t}\n` };
}

/**
 * Run one invocation and yield its events as they arrive. Usage, errors
 * and the stop reason are also folded into `outcome`, which the caller
 * reads once this generator completes.
 */
export async function* streamAider(
  inv: AiderInvocation,
  args: AgentRunArgs,
  outcome: AiderOutcome,
): AsyncGenerator<AiderEvent> {
  // Process-group leader under --access full (process-group-spawn.ts).
  const proc = spawnRunnerProcess(
    ...maskedCommand(args.authorityMask, inv.command, inv.argv),
    {
      cwd: args.cwd,
      // o-18: ambient ANTHROPIC_* creds are stripped like every vendor
      // runner's; an explicit value in args.env still reaches aider.
      env: {
        ...omitAnthropicManagedKeys(process.env),
        ...args.env,
        PYTHONUNBUFFERED: '1',
        PYTHONIOENCODING: 'utf-8',
        NO_COLOR: '1',
        // Our own nested-agent marker (aider has none); the shim sets it too.
        MONOMIND_AIDER: '1',
        AI_AGENT: 'aider',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
    args,
  );
  const child = proc.child;
  child.stdin?.on?.('error', () => {
    /* the child exited before reading its request — its exit code says why */
  });
  child.stdin?.write(inv.stdin);
  child.stdin?.end();

  let stderrTail = '';
  child.stderr?.on('data', (c: Buffer) => {
    stderrTail = (stderrTail + c.toString()).slice(-4000);
  });

  let timedOut = false;
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
  const unsubscribeAbort = killOnAbort(args.signal, proc.target, KILL_GRACE_MS);

  // Attached before reading stdout so a spawn failure (ENOENT) rejects
  // here instead of escaping as an unhandled 'error' event.
  const exitPromise = new Promise<number>((res, rej) => {
    child.on('error', rej);
    child.on('close', (code) => res(code ?? 1));
  });
  exitPromise.catch(() => {});

  const parse = inv.mode === 'shim' ? parseShimLine : parseCliLine;
  const fold = (ev: AiderEvent): AiderEvent => {
    if (ev.type === 'usage') {
      const u = outcome.usage ?? { input: 0, output: 0, usd: 0 };
      // The shim reports once per invocation; the CLI once per model call.
      outcome.usage = {
        input: u.input + ev.input_tokens,
        output: u.output + ev.output_tokens,
        usd: u.usd + ev.cost_usd,
      };
    } else if (ev.type === 'error' && !outcome.error) {
      outcome.error = { code: ev.code, message: ev.message };
    } else if (ev.type === 'result') {
      outcome.stopReason = ev.stop_reason;
    }
    return ev;
  };

  let drained = false;
  try {
    let buf = '';
    for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
      buf += chunk.toString();
      const parts = buf.split('\n');
      buf = parts.pop() ?? '';
      for (const line of parts) {
        const ev = parse(line);
        if (ev) yield fold(ev);
      }
    }
    if (buf.trim()) {
      const ev = parse(buf);
      if (ev) yield fold(ev);
    }
    drained = true;
  } finally {
    clearTimeout(timer);
    unsubscribeAbort();
    proc.stop();
    const alive = child.exitCode === null && child.signalCode === null;
    if (alive && !drained) {
      // Abandoned mid-turn, or a SIGTERM still inside its grace period:
      // keep (or start) the SIGKILL escalation rather than orphan aider.
      if (!child.killed) killChild();
    } else if (!alive && killTimer) {
      clearTimeout(killTimer);
    }
  }

  // stdout can close a moment before the process exits (interpreter
  // shutdown): give it EXIT_GRACE_MS, then kill. A kill here, after a clean
  // `result`, does not fail the turn.
  let shutdownKill = false;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  if (child.exitCode === null && child.signalCode === null) {
    graceTimer = setTimeout(() => {
      shutdownKill = true;
      killChild();
    }, EXIT_GRACE_MS);
    graceTimer.unref?.();
  }
  let exitCode: number;
  try {
    exitCode = await exitPromise;
  } finally {
    if (graceTimer) clearTimeout(graceTimer);
    if (killTimer) clearTimeout(killTimer);
  }
  outcome.exitCode = shutdownKill && outcome.stopReason && !outcome.error ? 0 : exitCode;
  outcome.stderrTail = stderrTail;
  outcome.timedOut = timedOut;
}
