// packages/@monomind/cli/src/orgrt/run-liveness.ts
/**
 * #573: is the process a runtime.json record names still the one that wrote it?
 *
 * `process.kill(pid, 0)` only says that SOME process has that pid. A killed
 * `org run` leaves runtime.json saying "running", and once the kernel hands
 * its pid to an unrelated process the probe keeps succeeding — `org status`
 * reported the dead run as running indefinitely. The writer therefore records
 * the process's start identity next to its pid (`pidStart`), and a reader
 * trusts the pid only while that identity still matches.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** A token that names one process for its whole life and changes when the pid
 *  is reused: the kernel start time (Linux: /proc/<pid>/stat field 22 plus the
 *  boot id; elsewhere: `ps -o lstart=`). Undefined when it can't be read. */
export function processStartId(pid: number): string | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // Fields after the parenthesised command name start at field 3 (state);
    // starttime is field 22. The name itself may contain spaces or ')'.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const start = fields[22 - 3];
    if (start) {
      let boot = '';
      try {
        boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      } catch {
        /* no boot id — the start time alone still tells a reused pid apart */
      }
      return `linux:${boot}:${start}`;
    }
  } catch {
    /* no procfs (macOS) or the process is gone */
  }
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8',
      timeout: 1000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out ? `ps:${out}` : undefined;
  } catch {
    return undefined;
  }
}

let selfStartId: string | undefined | null = null;

/** This process's start identity, read once — what persistState records. */
export function ownStartId(): string | undefined {
  if (selfStartId === null) selfStartId = processStartId(process.pid);
  return selfStartId;
}

/** - `alive` — the recorded process is still running.
 *  - `dead` — nothing has that pid any more.
 *  - `reused` — the pid now belongs to a different process. */
export type PidLiveness = 'alive' | 'dead' | 'reused';

/** Liveness of the process a record names by `pid` and, when the record has
 *  one, `pidStart`. A record written before #573 has no start identity; its
 *  pid is then trusted as before (kill -0), since there is nothing to compare. */
export function recordedPidLiveness(pid: unknown, pidStart?: unknown): PidLiveness {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return 'dead';
  try {
    process.kill(pid, 0);
  } catch (err) {
    // EPERM: the pid exists but belongs to another user — never an org run of ours.
    return (err as NodeJS.ErrnoException).code === 'EPERM' ? 'reused' : 'dead';
  }
  if (typeof pidStart !== 'string' || !pidStart) return 'alive';
  const now = processStartId(pid);
  // Unreadable identity for a pid that answers: don't call a live run dead.
  if (now === undefined) return 'alive';
  return now === pidStart ? 'alive' : 'reused';
}

/** Short reason for a record whose pid is no longer its process. */
export function deadPidReason(pid: unknown, liveness: PidLiveness): string {
  return liveness === 'reused' ? `pid ${pid} now belongs to another process` : `pid ${pid} gone`;
}
