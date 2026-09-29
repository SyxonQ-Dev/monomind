// packages/@monomind/cli/src/commands/org-follow.ts
//
// Shared live-tail machinery for `org logs --follow`, `org watch` and
// `org events --follow` (#433): an append-only byte-offset reader over a
// run's bus.jsonl, and a follow loop that ends when nobody is left to read
// it (parent gone, stdout closed, SIGHUP) or the run itself has closed.

import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { type BusEvent, ORG_DIR } from '../orgrt/types.js';

export const FOLLOW_INTERVAL_MS = 500;

/** Incremental line reader: each call returns the complete lines appended to
 *  `file` since the previous call, reading only the new bytes. A trailing
 *  line without its newline yet is a mid-append partial write — it is held
 *  back until it parses as JSON (or its newline arrives). */
export function createLineTail(file: string): () => string[] {
  let offset = 0;
  let pending = Buffer.alloc(0);
  return () => {
    if (!existsSync(file)) return [];
    let fd: number;
    try {
      fd = openSync(file, 'r');
    } catch {
      return [];
    }
    try {
      const size = fstatSync(fd).size;
      if (size < offset) {
        // Truncated or replaced — start over from the top.
        offset = 0;
        pending = Buffer.alloc(0);
      }
      if (size > offset) {
        const chunk = Buffer.alloc(size - offset);
        const n = readSync(fd, chunk, 0, chunk.length, offset);
        offset += n;
        pending = Buffer.concat([pending, chunk.subarray(0, n)]);
      }
    } finally {
      closeSync(fd);
    }
    const lines: string[] = [];
    let start = 0;
    for (let nl = pending.indexOf(0x0a); nl !== -1; nl = pending.indexOf(0x0a, start)) {
      const line = pending.toString('utf8', start, nl);
      if (line) lines.push(line);
      start = nl + 1;
    }
    pending = pending.subarray(start);
    if (pending.length) {
      const last = pending.toString('utf8');
      try {
        JSON.parse(last);
        lines.push(last);
        pending = Buffer.alloc(0);
      } catch {
        /* partial write — retry on the next call */
      }
    }
    return lines;
  };
}

/** True once `run` can gain no more events. runtime.json records the run as
 *  stopped/crashed only after its bus is sealed; when runtime.json is about a
 *  newer run (or absent), the run's own terminal `org-stopped` status event —
 *  which every stop path emits — is the signal. */
export function isRunClosed(cwd: string, org: string, run: string, stopSeen: boolean): boolean {
  let rt: { status?: unknown; run?: unknown } | null = null;
  try {
    rt = JSON.parse(readFileSync(join(cwd, ORG_DIR, org, 'runtime.json'), 'utf8'));
  } catch {
    rt = null;
  }
  if (rt?.run === run) return rt.status === 'stopped' || rt.status === 'crashed';
  return stopSeen;
}

/** Parsed tail of one run's bus.jsonl: `read()` returns new events (corrupt
 *  lines skipped), `closed()` reports whether the run has ended. */
export function tailRun(
  cwd: string,
  org: string,
  run: string,
): { read: () => BusEvent[]; closed: () => boolean } {
  const lines = createLineTail(join(cwd, ORG_DIR, org, run, 'bus.jsonl'));
  let stopSeen = false;
  return {
    read: () => {
      const events: BusEvent[] = [];
      for (const line of lines()) {
        try {
          const e = JSON.parse(line) as BusEvent;
          if (e.type === 'status' && e.reason === 'org-stopped') stopSeen = true;
          events.push(e);
        } catch {
          /* corrupt interior line — skip it and keep going */
        }
      }
      return events;
    },
    closed: () => isRunClosed(cwd, org, run, stopSeen),
  };
}

export type FollowEnd = 'closed' | 'signal' | 'consumer-gone' | 'orphaned';

const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

/** Run `drain` every interval until: the parent process changes (we were
 *  re-parented, so our consumer is gone), stdout errors (EPIPE) or closes,
 *  SIGINT/SIGTERM/SIGHUP arrives, or `closed()` reports the run has ended
 *  (after one final drain). Every listener is removed when it stops. */
export function followUntilDone(
  drain: () => void,
  closed: () => boolean,
  intervalMs = FOLLOW_INTERVAL_MS,
): Promise<FollowEnd> {
  const initialPpid = process.ppid;
  return new Promise<FollowEnd>((resolve) => {
    let done = false;
    const onSignal = (): void => stop('signal');
    const onConsumerGone = (): void => stop('consumer-gone');
    const iv = setInterval(() => {
      if (process.ppid !== initialPpid) return stop('orphaned');
      drain();
      if (!done && closed()) {
        drain();
        stop('closed');
      }
    }, intervalMs);
    function stop(why: FollowEnd): void {
      if (done) return;
      done = true;
      clearInterval(iv);
      for (const s of STOP_SIGNALS) process.off(s, onSignal);
      process.stdout.off('error', onConsumerGone);
      process.stdout.off('close', onConsumerGone);
      resolve(why);
    }
    for (const s of STOP_SIGNALS) process.once(s, onSignal);
    process.stdout.on('error', onConsumerGone);
    process.stdout.on('close', onConsumerGone);
  });
}
