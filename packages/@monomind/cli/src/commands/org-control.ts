// packages/@monomind/cli/src/commands/org-control.ts
//
// Shared org helpers used across the `org` subcommand modules: org-name
// validation, org config discovery, the stop/reload/pause control files, and
// run/serve-daemon liveness checks.

import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { recordedPidLiveness } from '../orgrt/run-liveness.js';
import { ORG_DIR, OrgDefSchema } from '../orgrt/types.js';
import { output } from '../output.js';
import type { CommandResult } from '../types.js';

const log = (text: string): void => {
  console.log(text);
};

/** Org names are used to build filesystem paths under .monomind/orgs — reject
 * anything that isn't a plain identifier to prevent path traversal (e.g.
 * `monomind org stop '../../../../tmp/x'`). */
export const ORG_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/i;

export function validateOrgName(
  name: string | undefined,
): { ok: true; name: string } | { ok: false; result: CommandResult } {
  if (!name) return { ok: false, result: { success: false, message: 'org name required' } };
  if (!ORG_NAME_RE.test(name)) {
    log(output.error(`Invalid org name: ${name}`));
    return { ok: false, result: { success: false, message: 'invalid org name' } };
  }
  return { ok: true, name };
}

/** Suffixes of org-internal artifact files (state/goals/threads/etc) that
 * share the `<org>.json`/`.jsonl` naming pattern with the org's own config
 * file. Single source of truth for both listOrgConfigFiles() (which must
 * exclude them when discovering real org configs) and deleteAction (which
 * must remove all of them when deleting an org). */
export const ORG_ARTIFACT_SUFFIXES = [
  '-state',
  '-goals',
  '-threads',
  '-activity',
  '-approvals',
  '-members',
  '-secrets',
  '-budgets',
  '-routines',
  '-issues',
  '-projects',
  '-workspaces',
  '-worktrees',
  '-environments',
  '-plugins',
  '-adapters',
  '-join-requests',
  '-bootstrap',
  '-project-workspaces',
  '-approval-comments',
  '-runstate',
  '-skills',
];
export function listOrgConfigFiles(orgsDir: string): string[] {
  // endsWith, not includes: substring matching hid legitimate orgs whose NAME
  // merely contains an artifact suffix anywhere (e.g. "state-machine.json",
  // "issues-triage.json") — and anything hidden here is also invisible to
  // run/list/serve while `org delete <sibling>` would still remove its files.
  //
  // ORG_NAME_RE on the stem (#309): a file is only an org config if its stem
  // is a name an org could actually have. Otherwise any stray `.json` in the
  // orgs dir (a tool's `.mcp.json`, `.DS_Store.json`, ...) becomes a phantom
  // org that `org list` reports but validateOrgName rejects everywhere else.
  // This subsumes the old `._` AppleDouble check (a leading dot fails the
  // pattern) since a leading `.` doesn't match the required first character.
  //
  // A valid-looking stem isn't enough (#309 follow-up): a same-directory
  // tool config can still pass ORG_NAME_RE (e.g. `toolconfig.json`). When a
  // candidate parses as JSON, also require it to carry the one field every
  // org config schema requires (OrgDefSchema's `name`) before calling it an
  // org, so an unrelated tool config is skipped rather than surfaced as one.
  // A file that fails to parse at all is left in the list on purpose: that's
  // a real org config corrupted on disk, and callers like `org validate`
  // (no name given) and `org list` already detect and report that case
  // (invalid-config / validation failure) rather than treating it as healthy
  // — silently dropping it here would hide the corruption instead.
  return readdirSync(orgsDir).filter((f) => {
    if (
      !f.endsWith('.json') ||
      f.endsWith('.v1.json') ||
      ORG_ARTIFACT_SUFFIXES.some((suf) => f.endsWith(`${suf}.json`)) ||
      !ORG_NAME_RE.test(f.slice(0, -'.json'.length))
    ) {
      return false;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(orgsDir, f), 'utf8'));
    } catch {
      return true;
    }
    return OrgDefSchema.pick({ name: true }).safeParse(parsed).success;
  });
}

/** Remove a lingering stopfile so a fresh `org run` doesn't self-terminate. */
export const clearStopfile = (cwd: string, name: string): void => {
  rmSync(join(cwd, ORG_DIR, name, 'stop'), { force: true });
};

/** Remove a lingering reload request so a fresh `org run` doesn't apply it on
 *  its first tick. One is left behind when a previous run's stop and reload
 *  landed in the same tick: the stop ends the wait before the reload poll runs. */
export const clearReloadfile = (cwd: string, name: string): void => {
  rmSync(join(cwd, ORG_DIR, name, 'reload'), { force: true });
};

/** Drop stop/reload requests left behind by a previous run, for every org
 *  `org serve` serves. #264: runAction clears these before its wait loop, but
 *  serveAction started polling with whatever was on disk — so an `org stop`
 *  that landed after the last daemon exited stopped the next daemon's org
 *  seconds into its run, and a leftover `org reload` was applied to a
 *  definition nobody had touched.
 *
 *  Scope is the org config files, not `daemon.listRunning()` (what
 *  pollStopfiles/pollReloadfiles walk): nothing is running yet at startup, so
 *  sweeping by that would sweep nothing. Called before the first org can
 *  start, so a request that arrives once serve is up is never discarded.
 *
 *  Runfiles are deliberately left in place. `.../run` is not the same kind of
 *  leftover: runAction writes one only against a live daemon and retracts it
 *  itself when nothing consumes it within 15s, and it reads the file's
 *  disappearance as "the daemon took the run". Deleting one here would report
 *  success to a waiting `org run` and start nothing — the silent loss that ack
 *  loop exists to prevent. A stale runfile at worst starts an org the operator
 *  did ask for; pollRunfiles already no-ops on one that is running.
 *
 *  Returns the orgs it cleared something for. */
export const clearStaleControlFiles = (cwd: string): string[] => {
  const orgDir = join(cwd, ORG_DIR);
  if (!existsSync(orgDir)) return [];
  const cleared: string[] = [];
  for (const f of listOrgConfigFiles(orgDir)) {
    const name = f.replace(/\.json$/, '');
    const stale = (['stop', 'reload'] as const).filter((kind) =>
      existsSync(join(orgDir, name, kind)),
    );
    if (!stale.length) continue;
    clearStopfile(cwd, name);
    clearReloadfile(cwd, name);
    log(
      output.warning(
        `org ${name}: discarding stale ${stale.join(' and ')} request left by a previous run`,
      ),
    );
    cleared.push(name);
  }
  return cleared;
};

/** True when a pause sentinel exists for an org. */
export const isOrgPaused = (cwd: string, name: string): boolean =>
  existsSync(join(cwd, ORG_DIR, name, 'pause'));

export const clearPausefile = (cwd: string, name: string): void => {
  rmSync(join(cwd, ORG_DIR, name, 'pause'), { force: true });
};

/** PID of a live `org serve` daemon for this project, or null.
 *
 *  The heartbeat file is written every 30s and removed on clean exit, but a
 *  SIGKILLed daemon leaves it behind — so liveness is confirmed against the pid
 *  itself, not the file's presence. A stale heartbeat must not make `org run`
 *  post a runfile nobody will ever read. */
export function liveServeDaemonPid(cwd: string): number | null {
  try {
    const hb = JSON.parse(readFileSync(join(cwd, '.monomind', 'serve-heartbeat.json'), 'utf8')) as {
      pid?: number;
      updatedAt?: string;
    };
    if (typeof hb.pid !== 'number' || hb.pid === process.pid) return null;
    // Freshness as well as liveness. The daemon beats every 30s, so a stamp
    // older than a few beats means it is gone or wedged — and a pid alone can
    // be recycled onto an unrelated process, which would send the runfile to
    // something that will never read it.
    const age = Date.now() - Date.parse(hb.updatedAt ?? '');
    if (!Number.isFinite(age) || age > 3 * 60_000) return null;
    process.kill(hb.pid, 0); // throws if the process is gone
    return hb.pid;
  } catch {
    return null;
  }
}

/** How long a run's own event log counts as proof of life after its last
 *  appended event. Deliberately generous: calling a live run "crashed" sends
 *  the operator to `org mark-complete`, which closes out a run that is still
 *  working, while being slow to notice a genuinely dead one costs nothing. */
const RUN_ACTIVITY_WINDOW_MS = 10 * 60_000;

/** Verdict of {@link classifyRun} — what `org status` should say about a
 *  runtime.json record that claims to be running.
 *  - `running` — alive and producing events.
 *  - `idle` — alive, but its event log has been silent for a while.
 *  - `crashed` — nothing says it is alive any more. */
export type RunState = 'running' | 'idle' | 'crashed';

/** Why a run was judged alive — `pid` is the recorded one still answering;
 *  the others mean the recorded pid is stale but the run demonstrably isn't. */
export type RunLiveEvidence = 'pid' | 'daemon-heartbeat' | 'run-activity';

/** Liveness verdict for one org's runtime.json record.
 *
 *  #274: a single `process.kill(pid, 0)` probe used to be the whole verdict, so
 *  a run whose recorded pid had gone stale — the orchestrating process was
 *  restarted or re-attached without runtime.json being rewritten — was reported
 *  as "crashed" while its roles were actively exchanging messages, with a
 *  `mark-complete` suggestion that would have closed out live work. The pid is
 *  still the first and best signal; when it is gone, two independent signs of
 *  life are cross-checked before declaring a crash: a fresh `org serve`
 *  heartbeat that still lists this org, and the run's own event log still
 *  growing.
 *
 *  Unchanged from before: a record that already says 'crashed' (including one
 *  written by the process-level crash handler) stays crashed — that is a
 *  recorded fact, not an inference. */
export function classifyRun(
  cwd: string,
  org: string,
  state: { status?: string; run?: string; pid?: number; pidStart?: string; closedBy?: string },
  now: number = Date.now(),
): { state: RunState; evidence?: RunLiveEvidence } {
  if (state.status === 'crashed') return { state: 'crashed' };
  const busAge = (): number | null => {
    if (!state.run) return null;
    try {
      const age = now - statSync(join(cwd, ORG_DIR, org, state.run, 'bus.jsonl')).mtimeMs;
      return age >= 0 ? age : 0;
    } catch {
      return null;
    }
  };
  const live = (evidence: RunLiveEvidence): { state: RunState; evidence: RunLiveEvidence } => {
    const age = busAge();
    return { state: age !== null && age > RUN_ACTIVITY_WINDOW_MS ? 'idle' : 'running', evidence };
  };
  if (state.pid) {
    // #573: alive AND still the process that wrote the record — a pid the
    // kernel has handed to something else is as gone as a dead one.
    if (recordedPidLiveness(state.pid, state.pidStart) === 'alive') return live('pid');
    /* recorded pid is gone or reused — fall through to the cross-checks */
  } else {
    // No pid was ever recorded; there is nothing to call stale.
    return live('pid');
  }
  try {
    const hb = JSON.parse(readFileSync(join(cwd, '.monomind', 'serve-heartbeat.json'), 'utf8')) as {
      pid?: number;
      updatedAt?: string;
      running?: string[];
    };
    const age = now - Date.parse(hb.updatedAt ?? '');
    if (
      typeof hb.pid === 'number' &&
      Number.isFinite(age) &&
      age <= 3 * 60_000 &&
      (hb.running ?? []).includes(org)
    ) {
      process.kill(hb.pid, 0); // throws if that daemon is gone too
      return live('daemon-heartbeat');
    }
  } catch {
    /* no heartbeat file, unparseable, or its daemon is gone as well */
  }
  const age = busAge();
  if (age !== null && age <= RUN_ACTIVITY_WINDOW_MS)
    return { state: 'running', evidence: 'run-activity' };
  return { state: 'crashed' };
}

/** Result of {@link checkServeLock}. */
export type ServeLockCheck =
  | { ok: true; staleHeartbeatRemoved: boolean }
  | { ok: false; pid: number };

/** Mutual-exclusion check for `org serve` startup.
 *
 *  Two `org serve` processes started against the same project root have zero
 *  visibility into each other — each builds its own in-memory `OrgDaemon` and
 *  independently decides which orgs are "due now", so both can call
 *  `daemon.startOrg(name)` for the same org and have both processes write to
 *  the same on-disk state (runtime.json, decisions.jsonl, history.jsonl,
 *  .mail/) at once. `liveServeDaemonPid` already knows how to read this
 *  project's serve-heartbeat.json and tell a live daemon's heartbeat from a
 *  stale one (dead pid, or aged past a few missed 30s beats) — reused here
 *  as the actual pidfile lock, rather than inventing a second file, since it
 *  already IS a pidfile (pid + timestamp, written at startup and every
 *  heartbeat, removed on clean shutdown by `daemon.clearHeartbeat()`).
 *
 *  Call this before the daemon/server/scheduler are constructed, so a
 *  refusal never opens a port, binds a broker lease, or touches any org's
 *  state. */
export function checkServeLock(cwd: string): ServeLockCheck {
  const owner = liveServeDaemonPid(cwd);
  if (owner != null) return { ok: false, pid: owner };
  // liveServeDaemonPid() has already ruled out a live owner — any heartbeat
  // file still on disk here is stale (dead pid, or a SIGKILLed daemon that
  // never reached clearHeartbeat()). Remove it so it can't be misread by
  // `org run`/`org status` before this daemon's own writeHeartbeat() lands.
  const heartbeatPath = join(cwd, '.monomind', 'serve-heartbeat.json');
  const staleHeartbeatRemoved = existsSync(heartbeatPath);
  if (staleHeartbeatRemoved) rmSync(heartbeatPath, { force: true });
  return { ok: true, staleHeartbeatRemoved };
}
