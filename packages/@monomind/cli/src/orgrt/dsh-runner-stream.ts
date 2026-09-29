// packages/@monomind/cli/src/orgrt/dsh-runner-stream.ts
import type { AgentMessage, AgentRunArgs } from './agent-runner.js';
import { killOnAbort } from './agent-runner.js';
import { maskedCommand } from './authority-mask.js';
import { type DshEvent, DshToolCalls, parseDshLine } from './dsh-runner-parse.js';
import { spawnRunnerProcess } from './process-group-spawn.js';
import { omitAnthropicManagedKeys } from './provider.js';
import { TOOL_CALL_RE } from './tool-fence.js';

export const TURN_TIMEOUT_MS = 2 * 60 * 60 * 1000; // matches the other CLI runners
const KILL_GRACE_MS = 5000;

/** Filled in by streamTurn while the process runs and when it exits. */
export interface DshTurnOutcome {
  exitCode: number;
  stderrTail: string;
  timedOut: boolean;
  sessionId?: string;
  /** Summed from every `step_end.usage` of this invocation. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** The `error` event's message (a failure outside a turn). */
  errorEvent?: string;
  /** The last `turn_end` reason. */
  turnEnd?: DshEvent['reason'];
  /** The emulated max-turns cap killed the process. */
  maxTurnsHit: boolean;
}

/** Steps (`step_start`) seen so far for this mailbox message, across tool
 *  rounds; the cap is AgentRunArgs.maxTurns (0 = none). */
export interface StepBudget {
  steps: number;
  max: number;
}

export type DshStreamEvent =
  | { kind: 'assistant'; rawText: string; text?: string }
  | { kind: 'message'; message: AgentMessage };

/**
 * Permission mode for the spawned dsh (dsh-base reads DSH_PERMISSION_MODE
 * for both the sandbox policy and the approval policy). Full access:
 * `danger-full-access` → sandbox off, approval `never`. Otherwise
 * `workspace-write` (approval `ask`, which headless mode, having no
 * answerer, fails closed), or `read-only` when the caller asked for it —
 * never an ambient `danger-full-access` inherited from the environment.
 */
export function dshPermissionMode(args: Pick<AgentRunArgs, 'access' | 'env' | 'sandbox'>): string {
  // #396: an explicit `agent exec --sandbox` mode wins, in any access mode.
  if (args.sandbox === 'read-only' || args.sandbox === 'workspace-write') return args.sandbox;
  if (args.access === 'full') return 'danger-full-access';
  return args.env.DSH_PERMISSION_MODE === 'read-only' ? 'read-only' : 'workspace-write';
}

/**
 * `dsh` argv for one invocation. Launcher flags (`--profile`, `--patch`)
 * must come before the first app flag: the launcher hands everything from
 * the first token it does not know (`--json`) to the headless app, which
 * rejects `--patch` (checked live). The task goes over stdin (`-`).
 */
export function dshArgs(sessionId: string | undefined, patchPath: string | undefined): string[] {
  const argv = ['--profile', 'headless'];
  if (patchPath) argv.push('--patch', patchPath);
  argv.push('--json');
  if (sessionId) argv.push('--session-id', sessionId);
  argv.push('-');
  return argv;
}

/**
 * Run one `dsh --profile headless --json` invocation and stream its events
 * as they arrive. Text/thinking are per committed step, not per token.
 */
export async function* streamTurn(
  bin: string,
  prompt: string,
  sessionId: string | undefined,
  patchPath: string | undefined,
  args: AgentRunArgs,
  outcome: DshTurnOutcome,
  budget: StepBudget,
): AsyncGenerator<DshStreamEvent> {
  const proc = spawnRunnerProcess(
    ...maskedCommand(args.authorityMask, bin, dshArgs(sessionId, patchPath)),
    {
      cwd: args.cwd,
      env: {
        ...omitAnthropicManagedKeys(process.env),
        ...args.env,
        DSH_PERMISSION_MODE: dshPermissionMode(args),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
    args,
  );
  const child = proc.child;
  const tools = new DshToolCalls();
  child.stdin?.on('error', () => {});
  child.stdin?.end(prompt);

  let stderrTail = '';
  child.stderr?.on('data', (c: Buffer) => {
    stderrTail = (stderrTail + c.toString()).slice(-4000);
  });

  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const killChild = (): void => {
    if (killTimer) return;
    proc.target.kill('SIGTERM');
    killTimer = setTimeout(() => proc.target.kill('SIGKILL'), KILL_GRACE_MS);
    killTimer.unref?.();
  };
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killChild();
  }, TURN_TIMEOUT_MS);
  const unsubscribeAbort = killOnAbort(args.signal, proc.target, KILL_GRACE_MS);
  const exitPromise = new Promise<number>((res, rej) => {
    child.on('error', rej);
    child.on('close', (code) => res(code ?? 1));
  });
  exitPromise.catch(() => {});

  let sid = sessionId;
  const handle = (ev: DshEvent): DshStreamEvent[] => {
    switch (ev.type) {
      case 'session':
        if (ev.sessionId) {
          sid = ev.sessionId;
          outcome.sessionId = sid;
        }
        return [];
      case 'status':
        if (ev.phase === 'step_start') {
          // dsh has no max-turns flag: count model steps and stop the tree
          // when the next one would exceed the cap.
          budget.steps++;
          if (budget.max > 0 && budget.steps > budget.max && !outcome.maxTurnsHit) {
            outcome.maxTurnsHit = true;
            killChild();
          }
        } else if (ev.phase === 'step_end' && ev.usage) {
          outcome.inputTokens += ev.usage.inputTokens ?? 0;
          outcome.outputTokens += ev.usage.outputTokens ?? 0;
          outcome.cacheReadTokens += ev.usage.cacheReadTokens ?? 0;
          outcome.cacheWriteTokens += ev.usage.cacheWriteTokens ?? 0;
        } else if (ev.phase === 'turn_end') {
          outcome.turnEnd = ev.reason;
        }
        return [];
      case 'text': {
        if (typeof ev.text !== 'string') return [];
        const stripped = ev.text.replace(TOOL_CALL_RE, '').trim();
        return [{ kind: 'assistant', rawText: ev.text, text: stripped || undefined }];
      }
      case 'tool_call': {
        proc.sampleNow();
        const m = tools.start(ev, sid);
        return m ? [{ kind: 'message', message: m }] : [];
      }
      case 'tool_result': {
        proc.sampleNow();
        const m = tools.end(ev, sid);
        return m ? [{ kind: 'message', message: m }] : [];
      }
      case 'error':
        outcome.errorEvent = ev.message ?? 'unknown error';
        return [];
      default:
        // thinking: no AgentMessage carries reasoning; final: the text
        // events already carried every committed step.
        return [];
    }
  };

  try {
    // Spawn-time liveness (session.ts's first-pull watchdog), label-less so
    // it never becomes a tool_activity start.
    yield { kind: 'message', message: { type: 'tool_use', session_id: sid } };
    let buf = '';
    for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
      buf += chunk.toString();
      const parts = buf.split('\n');
      buf = parts.pop() ?? '';
      for (const line of parts) {
        const ev = parseDshLine(line);
        if (ev) yield* handle(ev);
      }
    }
    const ev = parseDshLine(buf);
    if (ev) yield* handle(ev);
    if (!timedOut && !args.signal?.aborted) {
      for (const m of tools.flush(sid)) yield { kind: 'message', message: m };
    }
  } finally {
    clearTimeout(timer);
    unsubscribeAbort();
    proc.stop();
    if (child.exitCode === null && child.signalCode === null) {
      if (!child.killed && !killTimer && !args.signal?.aborted) killChild();
    } else if (killTimer) {
      clearTimeout(killTimer);
    }
  }

  const exitCode = await exitPromise;
  if (killTimer) clearTimeout(killTimer);
  outcome.sessionId = sid;
  outcome.exitCode = exitCode;
  outcome.stderrTail = stderrTail;
  outcome.timedOut = timedOut;
}
