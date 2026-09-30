// packages/@monomind/cli/src/commands/org-stale-run.ts
/**
 * #573: close out a runtime.json record left saying "running" by a process
 * that is gone. A standalone `org run` killed from outside (SIGKILL, or its
 * parent app taking it down) never reaches its stop or crash handlers, so the
 * record claimed a live run forever. `org status`, `org run` and `org serve`
 * call this: once classifyRun finds no sign of life, the record is rewritten
 * as crashed and the change is logged in the org's `liveness.jsonl`.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deadPidReason, recordedPidLiveness } from '../orgrt/run-liveness.js';
import { ORG_DIR } from '../orgrt/types.js';
import { writeJsonFileAtomic } from '../utils/json-file.js';
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
  /** The run is alive; `pid` is set when its recorded pid proves it. */
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
    return { outcome: 'live', ...(verdict.evidence === 'pid' ? { pid: rt.pid } : {}) };
  // Re-read before writing: a run that started since the first read owns the
  // file now and must not be overwritten.
  const again = readRecord(path);
  if (again?.status !== 'running' || again.run !== rt.run || again.pid !== rt.pid)
    return { outcome: 'none' };
  const reason = deadPidReason(rt.pid, recordedPidLiveness(rt.pid, rt.pidStart));
  const updated = new Date(now).toISOString();
  writeJsonFileAtomic(path, {
    ...rt,
    status: 'crashed',
    updated,
    closedBy: STALE_RUN_CLOSED_BY,
    error: reason,
  });
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
