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
 * A single point-in-time `groupClosure` snapshot still has a gap: if the
 * intermediate shell has ALREADY exited by the time something checks (the
 * common case for "start it and leave it running" — the whole point of
 * backgrounding is that the shell returns immediately, often within
 * single-digit milliseconds), there is no live PPID edge left to walk, and
 * the shell's PGID was never recorded anywhere durable. `trackDescendants`
 * closes this gap by SAMPLING the closure continuously for the lifetime of
 * the turn (see its own doc comment for the two cadences it uses) and
 * accumulating every pid/pgid ever seen — a process group remains
 * signalable with `kill(-pgid, …)` long after its leader has exited, so a
 * recorded pgid still lets a later `kill()`/`liveMembers()` call reach a
 * job whose launching shell is long gone, PROVIDED at least one sample
 * caught that shell (or the job itself) while it was still connected to
 * the tree. This is fundamentally a race against real OS scheduling speed,
 * not a guarantee: #359's own live-check found a background job whose
 * ENTIRE launching chain completes in a handful of milliseconds can still
 * be missed even at a 4ms sampling rate (see `trackDescendants`'s doc for
 * the measured numbers) — documented as a residual limitation, not
 * silently assumed away. It was NOT observed for a job that stays
 * connected for even a couple hundred ms, which covers the common,
 * intentional "leave a server running" case this issue is about.
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

function readTable(plat: NodeJS.Platform): ProcEntry[] {
  return plat === 'linux' ? readLinuxProcTable() : readPsTable();
}

function groupByPgid(table: ProcEntry[]): Map<number, ProcEntry[]> {
  const byPgid = new Map<number, ProcEntry[]>();
  for (const e of table) {
    const list = byPgid.get(e.pgrp);
    if (list) list.push(e);
    else byPgid.set(e.pgrp, [e]);
  }
  return byPgid;
}

/** A recorded pgid is only trusted — i.e. only ever signalled or reported —
 *  if it was itself once a pid this tracker saw under the leader's tree
 *  (it was a nested shell/job we actually observed), or at least one of
 *  its CURRENT live members is a pid we previously saw. This is the guard
 *  against a stale, recycled pgid number later being reused by a totally
 *  unrelated process after everything we tracked has exited. */
function isTrustedPgid(
  pgid: number,
  leaderPid: number,
  seenPids: ReadonlySet<number>,
  members: ProcEntry[],
): boolean {
  if (pgid === leaderPid || pgid === 0 || pgid === 1) return false;
  return seenPids.has(pgid) || members.some((m) => seenPids.has(m.pid));
}

/** Every live pid belonging to the tracked tree: the CURRENT live closure
 *  from `leaderPid` (still-connected descendants — always safe, computed
 *  fresh) UNION the live members of every recorded, trusted pgid (reaches
 *  a job whose launching shell already exited — see module doc). */
function trackedMembers(
  leaderPid: number,
  seenPids: ReadonlySet<number>,
  seenPgids: ReadonlySet<number>,
  table: ProcEntry[],
): number[] {
  const result = new Set<number>(groupClosure(leaderPid, table));
  const byPgid = groupByPgid(table);
  for (const pgid of seenPgids) {
    const members = byPgid.get(pgid) ?? [];
    if (!isTrustedPgid(pgid, leaderPid, seenPids, members)) continue;
    for (const m of members) result.add(m.pid);
  }
  result.delete(leaderPid);
  return [...result];
}

/** One-shot signal to the tracked tree: the current closure (individually,
 *  each still-connected pid) UNION the leader's own group UNION a GROUP
 *  signal to every recorded, trusted pgid (reaching a job whose launching
 *  shell already exited, in one call, even though its members no longer
 *  share the leader's own group). Best-effort throughout — never throws. */
function signalTracked(
  leaderPid: number,
  seenPids: ReadonlySet<number>,
  seenPgids: ReadonlySet<number>,
  signal: NodeJS.Signals,
  table: ProcEntry[],
): void {
  for (const pid of groupClosure(leaderPid, table)) {
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
  }
  try {
    process.kill(-leaderPid, signal);
  } catch {
    /* leader's group already gone */
  }
  const byPgid = groupByPgid(table);
  for (const pgid of seenPgids) {
    const members = byPgid.get(pgid) ?? [];
    if (!isTrustedPgid(pgid, leaderPid, seenPids, members)) continue;
    try {
      process.kill(-pgid, signal);
    } catch {
      /* group already gone */
    }
    for (const m of members) {
      try {
        process.kill(m.pid, signal);
      } catch {
        /* already gone */
      }
    }
  }
}

export interface DescendantTracker {
  /** Live members of every pid/pgid ever recorded under the leader,
   *  including ones whose launching shell has since exited/reparented —
   *  this is what makes `nohup cmd &` still discoverable minutes later.
   *  `supported:false` on win32 (matches `listGroupMembers`), in which
   *  case `pids` is always empty and the caller should OMIT the field
   *  rather than report a false "none running". Safe to call after
   *  `stop()`. */
  liveMembers(): GroupMembersResult;
  /** Fire `signal` at the tracked tree right now — no internal grace/
   *  timer; the caller drives the SIGTERM-then-SIGKILL ladder (e.g.
   *  `killOnAbort`, agent-runner-types.ts). Safe to call after `stop()`,
   *  and safe to call more than once. */
  signal(signal: NodeJS.Signals): void;
  /** Sample RIGHT NOW, outside the regular interval — a native tool call
   *  can start and its shell exit again well inside one interval period
   *  (live-verified: a `nohup cmd &` round-trip completing in ~50ms is
   *  common), so `agent-runner-claude.ts` calls this at the SDK's own
   *  `tool_use`/`tool_result` event boundaries to bracket each call with
   *  an extra chance to catch it, on top of the timer. Idempotent-safe
   *  (just folds in whatever's found), and safe to call after `stop()`
   *  (it does not restart the interval). */
  sampleNow(): void;
  /** Switch sampling cadence: `true` while at least one native tool call
   *  is in flight (a much faster interval — the actual fork/exec/exit of a
   *  Bash-tool shell can complete in low single-digit milliseconds, live-
   *  verified during #359 — a background job's WHOLE round trip, shell
   *  included, sometimes finishing in ~40-50ms end to end, faster than
   *  `sampleNow()`'s two bracketing calls reliably straddle given IPC
   *  latency on each side), `false` to fall back to the relaxed base rate
   *  once nothing is in flight (long-lived survivors like a dev server
   *  don't need fast sampling — they're not going anywhere). Idempotent:
   *  redundant calls with the same value are a no-op, no timer is
   *  restarted needlessly. `agent-runner-claude.ts` drives this off its
   *  own `pendingToolCalls` map size (#289) crossing 0. */
  setBurstMode(active: boolean): void;
  /** Stop periodic sampling. Idempotent, and safe to call at any time —
   *  `liveMembers()`/`signal()` keep working afterward against whatever
   *  was recorded up to that point. Call this once the turn ends so the
   *  (already unref'd — see `trackDescendants`) interval is freed
   *  promptly rather than lingering until the process exits anyway. */
  stop(): void;
}

/**
 * Samples `leaderPid`'s process-tree closure every `intervalMs` (default
 * 50ms — see below) for as long as this turn runs, accumulating every pid
 * and pgid ever observed under it. See the module doc for why a single
 * point-in-time closure isn't enough: a background job's launching shell
 * typically exits within milliseconds of starting it, and only a sample
 * taken WHILE it was still connected can ever record its pgid for later
 * use. The very first sample runs synchronously and immediately (not after
 * waiting a full interval) specifically to catch a fast-exiting shell on
 * turns that themselves end quickly.
 *
 * Two sampling cadences (see `setBurstMode`): a relaxed base rate
 * (`intervalMs`, default 50ms) for the turn's idle time — plenty for a
 * long-lived survivor like a dev server, which stays connected for
 * seconds to minutes — and a much faster burst rate (`burstIntervalMs`,
 * default 4ms) while a native tool call is actually in flight. #359's own
 * live-check against the real, installed Claude Code CLI found that
 * matters: a `nohup sleep 600 & echo started` Bash tool round trip —
 * spawn the shell, fork `nohup`+`sleep`, the shell exits, the CLI reports
 * back — sometimes completed in as little as ~40-50ms end to end, with
 * the shell's OWN live window inside that likely only a few ms once IPC
 * latency on either side is accounted for. A once-per-500ms timer missed
 * it outright in that check; even the 50ms base rate alone still missed
 * it on repeated live runs (confirmed empirically, not just estimated) —
 * only concentrating fast samples specifically DURING the in-flight
 * window closed the gap. Table reads are cheap (a handful of ms for a
 * typical process count), so a few-ms burst rate for the bounded duration
 * of one tool call is not a meaningful CPU cost.
 *
 * The interval timer is `unref()`'d: this tracker must never be the reason
 * the process stays alive, even if a caller forgets to call `stop()`.
 * Scoped mode never calls this at all (see agent-runner-claude.ts).
 */
export function trackDescendants(
  leaderPid: number,
  opts: { intervalMs?: number; burstIntervalMs?: number; plat?: NodeJS.Platform } = {},
): DescendantTracker {
  const plat = opts.plat ?? process.platform;
  const supported = plat !== 'win32';
  const baseIntervalMs = opts.intervalMs ?? 50;
  const burstIntervalMs = opts.burstIntervalMs ?? 4;
  const seenPids = new Set<number>([leaderPid]);
  const seenPgids = new Set<number>([leaderPid]);
  let timer: NodeJS.Timeout | undefined;
  let bursting = false;

  /** One sample: recompute the CURRENT closure and fold every pid found
   *  (plus its pgid) into the accumulated sets. */
  const sampleOnce = () => {
    const table = readTable(plat);
    const byPid = new Map(table.map((e) => [e.pid, e]));
    for (const pid of groupClosure(leaderPid, table)) {
      seenPids.add(pid);
      const entry = byPid.get(pid);
      if (entry) seenPgids.add(entry.pgrp);
    }
  };

  const restartTimer = (ms: number) => {
    if (timer) clearInterval(timer);
    timer = setInterval(sampleOnce, ms);
    timer.unref?.();
  };

  if (supported) {
    sampleOnce();
    restartTimer(baseIntervalMs);
  }

  return {
    liveMembers(): GroupMembersResult {
      if (!supported) return { pids: [], supported: false };
      const table = readTable(plat);
      return { pids: trackedMembers(leaderPid, seenPids, seenPgids, table), supported: true };
    },
    signal(signal: NodeJS.Signals): void {
      if (!supported) {
        signalGroup(leaderPid, signal, plat);
        return;
      }
      const table = readTable(plat);
      signalTracked(leaderPid, seenPids, seenPgids, signal, table);
    },
    sampleNow(): void {
      if (supported) sampleOnce();
    },
    setBurstMode(active: boolean): void {
      if (!supported || active === bursting) return; // no-op: unsupported, or already in that mode
      bursting = active;
      sampleOnce(); // catch the transition instant itself, don't wait for the new interval's first tick
      restartTimer(active ? burstIntervalMs : baseIntervalMs);
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
