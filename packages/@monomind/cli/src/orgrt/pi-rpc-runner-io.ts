// packages/@monomind/cli/src/orgrt/pi-rpc-runner-io.ts
/**
 * Wire helpers for PiRpcAgentRunner (pi-rpc-runner.ts): the JSONL decoder,
 * the command encoder, assistant-text extraction, and the duck-typed child
 * process seam tests drive with a fake.
 */
import type { AgentRunArgs } from './agent-runner-types.js';
import { piMessageText } from './pi-runner-parse.js';
import { spawnRunnerProcess } from './process-group-spawn.js';

/** Pure, transport-independent JSONL line decoder — feed it raw string
 *  chunks, get back every complete parsed object found so far (silently
 *  skipping malformed lines rather than throwing, matching this repo's
 *  other subprocess parsers). Splits on LF only, as pi docs/json.md
 *  requires (U+2028/U+2029 are valid inside JSON strings). */
export class JsonlDecoder {
  private buf = '';
  feed(chunk: string): Record<string, unknown>[] {
    this.buf += chunk;
    const parts = this.buf.split('\n');
    this.buf = parts.pop() ?? '';
    const out: Record<string, unknown>[] = [];
    for (const line of parts) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        out.push(JSON.parse(trimmed));
      } catch {
        /* skip malformed line */
      }
    }
    return out;
  }
}

/** A client→server RPC command (pi docs/rpc-commands.md). */
export interface PiRpcCommand {
  type: string;
  message?: string;
  id?: string;
}

/** Encode a client→server RPC command as one LF-terminated JSON line. */
export function encodePiRpcCommand(cmd: PiRpcCommand): string {
  return `${JSON.stringify(cmd)}\n`;
}

/** Assistant-visible text of a message's `content`: text blocks joined with
 *  '\n'; `thinking` and `toolCall` blocks are dropped. */
export function extractPiRpcText(message: { content?: unknown }): string {
  return piMessageText(message);
}

/** The subset of a spawned child process this runner needs — duck-typed so
 *  tests can supply an EventEmitter-backed fake and exercise the whole
 *  turn-completion state machine without a real `pi` binary. */
export interface PiRpcProcess {
  stdin: {
    write(data: string): void;
    /** Optional so the test fakes stay minimal; the real ChildProcess has it. */
    on?(event: 'error', cb: (err: Error) => void): void;
  } | null;
  stdout: { on(event: 'data', cb: (chunk: Buffer) => void): void } | null;
  stderr: { on(event: 'data', cb: (chunk: Buffer) => void): void } | null;
  on(event: 'close', cb: (code: number | null) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  kill(signal?: string): void;
}

export type SpawnPiRpc = (
  bin: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string | undefined> },
  runArgs: Pick<AgentRunArgs, 'access' | 'onProcessSpawned'>,
) => PiRpcProcess;

/** Spawns through the process-group helper, so under `--access full` the
 *  returned `kill` (the watchdogs, the caller's abort, the final cleanup)
 *  signals pi's whole process tree, like the `--mode json` runner. */
export const defaultSpawnPiRpc: SpawnPiRpc = (bin, args, opts, runArgs) => {
  const proc = spawnRunnerProcess(
    bin,
    args,
    { cwd: opts.cwd, env: opts.env, stdio: ['pipe', 'pipe', 'pipe'] },
    runArgs,
  );
  const child = proc.child;
  child.on('close', () => proc.stop());
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    on: (event: string, cb: (...a: unknown[]) => void) => {
      child.on(event, cb);
    },
    kill: (signal?: string) => proc.target.kill(signal as NodeJS.Signals | undefined),
  } as PiRpcProcess;
};
