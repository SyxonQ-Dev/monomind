// packages/@monomind/cli/src/commands/org-stale-run.ts
/**
 * #573: close out a runtime.json record left saying "running" by a process
 * that is gone. A standalone `org run` killed from outside (SIGKILL, or its
 * parent app taking it down) never reaches its stop or crash handlers, so the
 * record claimed a live run forever. `org status`, `org run` and `org serve`
 * call this: once classifyRun finds no sign of life, the record is rewritten
 * as crashed and the change is logged in the org's `liveness.jsonl`.
 */
import {
  appendFileSync,
  linkSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { deadPidReason, recordedPidLiveness, recordedPidVerified } from '../orgrt/run-liveness.js';
import { ORG_DIR } from '../orgrt/types.js';
import { classifyRun, listOrgConfigFiles } from './org-control.js';

/** `closedBy` on a record this module closed. */
export const STALE_RUN_CLOSED_BY = 'liveness-check';

type RuntimeRecord = {
  status?: string;
  run?: string;
  pid?: number;
  pidStart?: string;
  [k: string]: unknown;
};

export type StaleRunCheck =
  /** Nothing to do: no record, not 'running', or it is this process's own. */
  | { outcome: 'none' }
  /** The run is alive; `pid` is set only when its recorded pid AND start
   *  identity prove it (a pre-#573 record's pid may be anyone's now). */
  | { outcome: 'live'; pid?: number }
  /** The record was stale and is now marked crashed. */
  | { outcome: 'crashed'; run?: string; pid?: number; reason: string };

const readRecord = (path: string): RuntimeRecord | undefined => {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as RuntimeRecord;
  } catch {
    return undefined;
  }
};

/** Replace the dead run's record with `crashed`, but only while runtime.json
 *  still holds that record (#586). Re-reading and then renaming could still
 *  overwrite a record a new run wrote in between, so this compares and swaps:
 *   1. rename runtime.json to a private claim file, which atomically takes
 *      whatever record is current at that instant;
 *   2. if the claim is the dead record, write `crashed` to an exclusive-create
 *      temp file; otherwise (or if that write fails) keep the claim as is;
 *   3. link() the result back to runtime.json. link fails with EEXIST when a
 *      new run wrote runtime.json after step 1: that record is newer and
 *      stays. A claimed record that is not the dead one is put back.
 *  A live run's writes are never blocked or overwritten. False when nothing
 *  was marked (lost the race, or the file can't be written: a role sandbox
 *  binds it read-only, #498); no claim or temp file is left behind. */
const swapInCrashed = (path: string, dead: RuntimeRecord, crashed: RuntimeRecord): boolean => {
  const base = `${path}.${process.pid}.${Date.now()}`;
  const claim = `${base}.claim`;
  const tmp = `${base}.tmp`;
  try {
    renameSync(path, claim);
  } catch {
    return false; // gone, or read-only
  }
  let marked = false;
  try {
    const cur = readRecord(claim);
    if (
      cur?.status === 'running' &&
      cur.run === dead.run &&
      cur.pid === dead.pid &&
      cur.pidStart === dead.pidStart
    ) {
      try {
        writeFileSync(tmp, JSON.stringify(crashed, null, 2), { encoding: 'utf-8', flag: 'wx' });
        linkSync(tmp, path);
        marked = true;
      } catch {
        /* EEXIST (a newer record stays) or the write failed: restore below */
      }
    }
    if (!marked) {
      try {
        linkSync(claim, path);
      } catch {
        /* EEXIST: a newer record landed after the claim and stays */
      }
    }
  } finally {
    for (const f of [claim, tmp]) {
      try {
        unlinkSync(f);
      } catch {
        /* never created, or already gone */
      }
    }
  }
  return marked;
};

/** Check one org's runtime.json and mark it crashed when its run is dead.
 *  `by` names the command, for the audit line. */
export function reconcileStaleRun(
  cwd: string,
  org: string,
  by: string,
  now: number = Date.now(),
): StaleRunCheck {
  const path = join(cwd, ORG_DIR, org, 'runtime.json');
  const rt = readRecord(path);
  if (rt?.status !== 'running' || rt.pid === process.pid) return { outcome: 'none' };
  const verdict = classifyRun(cwd, org, rt, now);
  if (verdict.state !== 'crashed')
    return {
      outcome: 'live',
      ...(verdict.evidence === 'pid' && recordedPidVerified(rt.pid, rt.pidStart)
        ? { pid: rt.pid }
        : {}),
    };
  // runtime.json is the daemon's record (#498): a role's process never writes
  // it, and inside a role sandbox its pids are not the host's anyway.
  if (process.env.MONOMIND_ORG_ROLE) return { outcome: 'none' };
  const reason = deadPidReason(rt.pid, recordedPidLiveness(rt.pid, rt.pidStart));
  const updated = new Date(now).toISOString();
  // A run that started since the read above owns the file now and must not
  // be overwritten; swapInCrashed replaces only this exact record.
  if (
    !swapInCrashed(path, rt, {
      ...rt,
      status: 'crashed',
      updated,
      closedBy: STALE_RUN_CLOSED_BY,
      error: reason,
    })
  )
    return { outcome: 'none' }; // readers still classify it crashed on their own
  try {
    appendFileSync(
      join(cwd, ORG_DIR, org, 'liveness.jsonl'),
      `${JSON.stringify({ ts: updated, run: rt.run, pid: rt.pid, status: 'crashed', reason, by })}\n`,
    );
  } catch {
    /* best effort — runtime.json already carries the verdict */
  }
  return { outcome: 'crashed', run: rt.run, pid: rt.pid, reason };
}

/** reconcileStaleRun for every org in the project; returns the ones closed. */
export function reconcileAllStaleRuns(
  cwd: string,
  by: string,
): Array<{ org: string } & Extract<StaleRunCheck, { outcome: 'crashed' }>> {
  const closed: Array<{ org: string } & Extract<StaleRunCheck, { outcome: 'crashed' }>> = [];
  let names: string[] = [];
  try {
    names = listOrgConfigFiles(join(cwd, ORG_DIR)).map((f) => f.replace(/\.json$/, ''));
  } catch {
    return closed;
  }
  for (const org of names) {
    const r = reconcileStaleRun(cwd, org, by);
    if (r.outcome === 'crashed') closed.push({ org, ...r });
  }
  return closed;
}
