// packages/@monomind/cli/src/orgrt/qwen-rpc-runner-helpers.ts
import { spawn } from 'node:child_process';

/** Upper bound on how long a single turn's wait for `result` may run before
 *  the mid-session silence watchdog (below) considers qwen wedged. */
export const SETTLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
export const STARTUP_GRACE_MS = 45_000;

export interface QwenRpcContentBlock {
  type: string;
  text?: string;
  thinking?: string;
}
export interface QwenRpcMessage {
  content?: QwenRpcContentBlock[];
}

/** Pure, transport-independent JSONL line decoder — same shape as
 *  pi-rpc-runner.ts's JsonlDecoder. Exported for unit testing without a
 *  real subprocess. */
export class QwenJsonlDecoder {
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

/** Encode a client→server `user` message as one LF-terminated JSON line —
 *  the plain-string content form (see file header for why the
 *  content-block-array form isn't used). Exported for unit testing the
 *  exact wire format. */
export function encodeQwenRpcUserMessage(text: string): string {
  return `${JSON.stringify({ type: 'user', message: { content: text } })}\n`;
}

/** Extract assistant-visible text from an `assistant` event's
 *  `message.content` array. `thinking` blocks are dropped (internal
 *  reasoning, not meant for the bus). Exported for unit testing against
 *  fixture content arrays. */
export function extractQwenRpcText(message: QwenRpcMessage): string {
  return (message.content ?? [])
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n');
}

/** The subset of a spawned child process this runner needs — same
 *  duck-typed seam as pi-rpc-runner.ts's PiRpcProcess, so tests can supply
 *  a fake implementation to exercise the full turn-completion state
 *  machine without a real `qwen` binary. */
export interface QwenRpcProcess {
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

export type SpawnQwenRpc = (
  bin: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string | undefined> },
) => QwenRpcProcess;

export const defaultSpawnQwenRpc: SpawnQwenRpc = (bin, args, opts) =>
  spawn(bin, args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as unknown as QwenRpcProcess;
