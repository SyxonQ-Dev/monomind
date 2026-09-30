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
    // lstart is printed in the caller's locale and time zone; pin both so a
    // writer and a reader with different LANG/TZ (a launchd daemon vs a login
    // shell) print the same string for the same process.
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8',
      timeout: 1000,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, LC_ALL: 'C', LANG: 'C', TZ: 'UTC' },
    }).trim();
    return out ? `ps:${out}` : undefined;
  } catch {
    return undefined;
  }
}

/** Whether two start identities name the same process: true or false when
 *  they can be compared, undefined when they can't — they were read by
 *  different methods (procfs vs ps, e.g. one side had no /proc), which says
 *  nothing about the process. A missing boot id on either side compares the
 *  start time alone. */
export function sameStartId(recorded: string, now: string): boolean | undefined {
  const kind = (id: string) => id.slice(0, id.indexOf(':') + 1);
  if (kind(recorded) !== kind(now)) return undefined;
  if (kind(recorded) !== 'linux:') return recorded === now;
  const split = (id: string) => {
    const rest = id.slice('linux:'.length);
    const at = rest.lastIndexOf(':');
    return { boot: rest.slice(0, at), start: rest.slice(at + 1) };
  };
  const a = split(recorded);
  const b = split(now);
  if (a.boot && b.boot && a.boot !== b.boot) return false;
  return a.start === b.start;
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
  // Unreadable or incomparable identity for a pid that answers: don't call a
  // live run dead.
  const same = now === undefined ? undefined : sameStartId(pidStart, now);
  return same === false ? 'reused' : 'alive';
}

/** True only when the record's pid is alive AND its start identity was read
 *  and matches — proof the run is still there, not just a pid that answers.
 *  A record without `pidStart` (pre-#573) never proves it: its pid may since
 *  belong to anything. */
export function recordedPidVerified(pid: unknown, pidStart?: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  if (typeof pidStart !== 'string' || !pidStart) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const now = processStartId(pid);
  return now !== undefined && sameStartId(pidStart, now) === true;
}

/** Short reason for a record whose pid is no longer its process. */
export function deadPidReason(pid: unknown, liveness: PidLiveness): string {
  return liveness === 'reused' ? `pid ${pid} now belongs to another process` : `pid ${pid} gone`;
}
