// packages/@monomind/cli/src/orgrt/process-tree.ts
/**
 * Coder mode (#359, part of the Coder mode epic #364): process-tree
 * discovery and kill primitives for `--access full` turns.
 *
 * Full access lets the agent start long-running or background processes via
 * its Bash tool: a dev server, `sleep 600 &`, a watcher. A single
 * `child.kill()` on the `claude` CLI process (what every other runner's
 * kill ladder does, see `killOnAbort` in agent-runner-types.ts) never
 * reaches those — they are grandchildren of the CLI's own shell
 * invocations, not direct children of monomind.
 *
 * `claude` is spawned as the leader of its own process group (`detached:
 * true` — see agent-runner-claude-fullaccess.ts's `fullAccessClaudeSpawn`),
 * so a naive fix would be "signal the group". That alone is NOT enough
 * against the real, installed Claude Code CLI: it was LIVE-VERIFIED (#359's
 * own live-check) that the CLI's Bash tool spawns EACH shell invocation as
 * the leader of its OWN, separate process group — not a member of the top
 * `claude` process's group — specifically so a per-call timeout can kill
 * just that one shell's tree. A background job (`nohup sleep 600 &`)
 * therefore ends up in a group whose id is that shell's pid, not the
 * top-level `claude` pid, and — once that shell exits (observed to happen
 * within tens of milliseconds of backgrounding a job, i.e. almost
 * immediately) — the job is reparented to init/a subreaper, severing even
 * the PPID chain back to `claude`.
 *
 * `groupClosure` below handles both hops with one fixed-point walk over
 * the whole process table: starting from the leader, repeatedly add any
 * process whose PPID **or** PGID is already in the set, until nothing new
 * is found. This finds `claude → shellA → job` (a live PPID edge, reached
 * promptly — before `shellA` exits, which is exactly when `agent-runner-
 * claude.ts`'s cancel/timeout/budget kill ladder fires) AND, once `shellA`
 * itself is in the set, everything sharing shellA's OWN group (its
 * `job`'s PGID, since `job` never called `setsid`) — a NESTED group, not
 * just the leader's own.
 *
 * Known v1 gap (documented, not silently dropped — see doc/agent-exec-
 * protocol.md's rev 13 note and `done.background_pids`'s own doc comment):
 * on a NORMAL end_turn, if the intermediate shell has ALREADY exited by
 * the time `agent-exec.ts` checks (the common case for "start it and leave
 * it running" — the whole point of backgrounding is that the shell returns
 * immediately), there is no live PPID edge left to walk, and the shell's
 * PGID was never recorded anywhere durable. A snapshot taken only at
 * end_turn can therefore miss a survivor whose launching shell is already
 * gone. Catching that reliably would need polling the tree throughout the
 * turn (recording every transient shell's PGID while it's still alive),
 * which is deferred rather than added here.
 *
 * Windows has no POSIX process groups; v1 leaves both discovery and the
 * kill's precise semantics unsupported there per the issue's own item 4
 * ("explicitly unsupported for v1 with a clear error"), and `signalGroup`'s
 * `taskkill /T` fallback (tree-based, not group-based) is a best-effort
 * approximation for the kill side only — never throws, never crashes a turn.
 */

import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';

export interface GroupMembersResult {
  /** Live pids in the leader's extended process tree (PPID descendants and
   *  nested process groups — see module doc), EXCLUDING the leader itself.
   *  Empty (not necessarily "none running" — see `supported`) when
   *  discovery isn't supported on this platform. */
  pids: number[];
  /** false on win32 — no POSIX process groups there (see module doc). */
  supported: boolean;
}

interface ProcEntry {
  pid: number;
  ppid: number;
  pgrp: number;
}

/** {pid, ppid, pgrp} for every readable entry under /proc. Best-effort: a
 *  pid that exits mid-scan (ENOENT) or whose /proc/<pid>/stat can't be
 *  parsed is silently skipped, never fatal — this is a point-in-time
 *  snapshot, not a transactional read. */
function readLinuxProcTable(): ProcEntry[] {
  const table: ProcEntry[] = [];
  let entries: string[];
  try {
    entries = readdirSync('/proc');
  } catch {
    return table;
  }
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      // Format: "pid (comm) state ppid pgrp session tty_nr ...". `comm` may
      // itself contain spaces or parens, so slice after the LAST ')' rather
      // than splitting naively on spaces.
      const afterComm = stat.slice(stat.lastIndexOf(')') + 2);
      const fields = afterComm.split(' ');
      const ppid = Number(fields[1]); // fields[0]=state, [1]=ppid, [2]=pgrp
      const pgrp = Number(fields[2]);
      if (Number.isFinite(ppid) && Number.isFinite(pgrp)) table.push({ pid, ppid, pgrp });
    } catch {
      /* pid exited mid-scan, or unreadable — not fatal */
    }
  }
  return table;
}

/** Same {pid, ppid, pgrp} table via `ps` (macOS/BSD, and any POSIX platform
 *  without a readable /proc). */
function readPsTable(): ProcEntry[] {
  const table: ProcEntry[] = [];
  let res: SpawnSyncReturns<string>;
  try {
    res = spawnSync('ps', ['-axo', 'pid=,ppid=,pgid='], { encoding: 'utf8' });
  } catch {
    return table;
  }
  if (res.status !== 0 || !res.stdout) return table;
  for (const line of res.stdout.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    const pgrp = Number(parts[2]);
    if (Number.isFinite(pid) && Number.isFinite(ppid) && Number.isFinite(pgrp)) {
      table.push({ pid, ppid, pgrp });
    }
  }
  return table;
}

/** Fixed-point walk (see module doc): starting from `leaderPid`, repeatedly
 *  add any process whose PPID or PGID is already in the included set,
 *  until a pass adds nothing new. O(n²) worst case over the WHOLE machine's
 *  process table — fine at the frequency this runs (a cancel/timeout/
 *  budget event, or once per turn's end), not a hot loop. */
function groupClosure(leaderPid: number, table: ProcEntry[]): number[] {
  const included = new Set<number>([leaderPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const e of table) {
      if (included.has(e.pid)) continue;
      if (included.has(e.ppid) || included.has(e.pgrp)) {
        included.add(e.pid);
        changed = true;
      }
    }
  }
  included.delete(leaderPid);
  return [...included];
}

/**
 * Every LIVE process in `leaderPid`'s extended process tree — PPID
 * descendants plus any nested process group one of them leads (see module
 * doc for why both are needed against the real Claude Code CLI) — other
 * than the leader itself. Used for `agent exec`'s `done.background_pids`
 * (§3.2): survivors still alive when a full-access turn ends normally.
 */
export function listGroupMembers(
  leaderPid: number,
  plat: NodeJS.Platform = process.platform,
): GroupMembersResult {
  if (plat === 'win32') return { pids: [], supported: false };
  const table = plat === 'linux' ? readLinuxProcTable() : readPsTable();
  return { pids: groupClosure(leaderPid, table), supported: true };
}

/**
 * Send `signal` to every process in `leaderPid`'s extended process tree —
 * the group signal (POSIX `process.kill(-leaderPid, signal)`, reaching
 * everything still sharing the leader's OWN group) UNION an individual
 * signal to each pid `groupClosure` finds (reaching a nested shell's own
 * group and its children even though they never joined the leader's
 * group) — or best-effort to the whole process TREE on Windows (via
 * `taskkill /T`, which needs neither). Best effort by design: ESRCH
 * (POSIX — "no such process", already exited) and a non-zero `taskkill`
 * (pid already gone) are both the expected, harmless outcome once nothing
 * is left to signal — this must never throw into a caller's termination
 * path.
 */
export function signalGroup(
  leaderPid: number,
  signal: NodeJS.Signals,
  plat: NodeJS.Platform = process.platform,
): void {
  if (plat !== 'win32') {
    // Compute the closure BEFORE signalling anything: killing the leader's
    // own group first would immediately orphan a nested shell (reparenting
    // it, e.g. to init), severing the very PPID edge `groupClosure` needs
    // to discover it — read-then-kill, never kill-then-read.
    const table = plat === 'linux' ? readLinuxProcTable() : readPsTable();
    const members = groupClosure(leaderPid, table);
    try {
      process.kill(-leaderPid, signal);
    } catch {
      /* group already gone, or the leader never became its own leader
       * (e.g. it exited before spawn() returned) — nothing left to signal */
    }
    for (const pid of members) {
      try {
        process.kill(pid, signal);
      } catch {
        /* already gone */
      }
    }
    return;
  }
  try {
    spawnSync(
      'taskkill',
      ['/PID', String(leaderPid), '/T', ...(signal === 'SIGKILL' ? ['/F'] : [])],
      { stdio: 'ignore' },
    );
  } catch {
    /* best effort — taskkill missing or the pid is already gone */
  }
}
