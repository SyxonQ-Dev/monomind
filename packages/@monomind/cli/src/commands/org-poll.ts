// packages/@monomind/cli/src/commands/org-poll.ts
//
// Control-file polling for `org run` / `org serve`: the foreground run's wait
// loop and exit-outcome decision, and the stop/reload/run file polls.

import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { OrgDaemon } from '../orgrt/daemon.js';
import { orgSignatureEnforced, verifyOrgDef } from '../orgrt/org-signature.js';
import { sweepPlantWatches } from '../orgrt/planted-paths.js';
import { ORG_DIR } from '../orgrt/types.js';
import { output } from '../output.js';
import type { CommandResult } from '../types.js';
import { clearStopfile, listOrgConfigFiles } from './org-control.js';

const log = (text: string): void => {
  console.log(text);
};

/** The foreground `org run` wait loop. Every `intervalMs` it ends the wait
 *  when `org stop` wrote the stopfile (stoppedManually) or the daemon no
 *  longer hosts the org (org_complete, idle watchdog, crash), and otherwise
 *  applies a pending `org reload`. Before the reload poll was added here only
 *  `org serve` read the reload file, so `org reload` against an `org run`
 *  process printed "picks it up within ~2s", exited 0, and changed nothing —
 *  a rotated endpoint URL kept receiving deliveries until it went dead.
 *  SIGINT/SIGTERM also end the wait (reported as `signal: true`). */
export async function waitForRunEnd(
  cwd: string,
  name: string,
  daemon: Pick<OrgDaemon, 'getOrg' | 'listRunning' | 'reloadOrgDef'>,
  intervalMs = 2000,
): Promise<{ stoppedManually: boolean; signal?: true }> {
  const stopfile = join(cwd, ORG_DIR, name, 'stop');
  return new Promise((resolvePromise) => {
    const finish = (stoppedManually: boolean, signal = false) => {
      clearInterval(iv);
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
      resolvePromise(signal ? { stoppedManually, signal } : { stoppedManually });
    };
    const onSignal = () => finish(false, true);
    const iv = setInterval(() => {
      if (existsSync(stopfile)) {
        finish(true);
      } else if (!daemon.getOrg(name)) {
        finish(false);
      } else {
        pollReloadfiles(cwd, daemon as OrgDaemon).catch((err) => {
          console.error('[org run] reloadfile poll failed:', err);
        });
        // #502 review round 4: the same planted-path sweep as `org serve`.
        sweepPlantWatches().catch((err) => {
          console.error('[org run] planted-path sweep failed:', err);
        });
      }
    }, intervalMs);
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
  });
}

/** Just the fields determineRunOutcome needs from runtime.json. */
export type RunTerminalState = { status?: string; closedBy?: string; error?: string };

/** runtime.json's final record; {} when unreadable (the non-clean-stop case). */
export const runtimeState = (cwd: string, name: string): RunTerminalState => {
  try {
    return JSON.parse(readFileSync(join(cwd, ORG_DIR, name, 'runtime.json'), 'utf8'));
  } catch {
    return {};
  }
};

/** Decides `org run`'s exit-code-bearing CommandResult from the run's final
 *  recorded state. Extracted (matching resolvedIdleNudgeCount's precedent for
 *  the idle watchdog) so this decision is unit-testable without spinning up a
 *  real daemon/org. Exit 0 ONLY for a clean, goal-driven end (closedBy:
 *  'org-complete', set by daemon.ts's org-complete auto-stop path) — every
 *  other outcome (idle-watchdog stop, boss-restart-exhausted, a process-level
 *  crash) exits 1 so scripts/supervisors can tell success from failure. */
export function runOutcomeResult(name: string, final: RunTerminalState): CommandResult {
  if (final.closedBy === 'org-complete') {
    return { success: true, message: `org ${name} completed` };
  }
  if (final.status === 'crashed') {
    return {
      success: false,
      message: `org ${name} crashed: ${final.error ?? 'unknown error'}`,
      exitCode: 1,
    };
  }
  return {
    success: false,
    message: `org ${name} stopped without completing (not via org_complete) — check 'monomind org status ${name}' or the run history for the reason`,
    exitCode: 1,
  };
}

/** One pass of the `org serve` stopfile poll.
 *
 * `monomind org stop <name>` writes `.monomind/orgs/<name>/stop`. `org run` has always
 * polled that file; `org serve` did not — so against a serve daemon `org stop` was a
 * silent no-op that still printed "daemon exits within 2s" and exited 0 while the org
 * kept running. Stops every running org whose stopfile is present, then clears the
 * stopfile so the next scheduled iteration isn't killed on sight.
 *
 * Returns the names it stopped (awaited), so callers/tests don't have to guess. */
export const pollStopfiles = async (cwd: string, daemon: OrgDaemon): Promise<string[]> => {
  const stopped: string[] = [];
  for (const name of daemon.listRunning()) {
    if (!existsSync(join(cwd, ORG_DIR, name, 'stop'))) continue;
    log(output.info(`org ${name}: stop requested — shutting it down`));
    try {
      await daemon.stopOrg(name);
      stopped.push(name);
    } catch (err) {
      console.error(`org ${name}: stop failed:`, err);
    } finally {
      clearStopfile(cwd, name);
    }
  }
  return stopped;
};

export const pollReloadfiles = async (cwd: string, daemon: OrgDaemon): Promise<string[]> => {
  const reloaded: string[] = [];
  for (const name of daemon.listRunning()) {
    const reloadFile = join(cwd, ORG_DIR, name, 'reload');
    if (!existsSync(reloadFile)) continue;
    try {
      unlinkSync(reloadFile);
    } catch {
      /* already gone */
    }
    try {
      const result = daemon.reloadOrgDef(name);
      const parts: string[] = [];
      if (result.changed.length) parts.push(`${result.changed.length} fields updated`);
      if (result.newRoles.length)
        parts.push(`${result.newRoles.length} new roles: ${result.newRoles.join(', ')}`);
      if (result.removedRoles.length)
        parts.push(
          `${result.removedRoles.length} roles removed: ${result.removedRoles.join(', ')}`,
        );
      log(output.info(`org ${name}: reloaded — ${parts.join('; ') || 'no changes'}`));
      reloaded.push(name);
    } catch (err) {
      log(
        output.warning(
          `org ${name}: reload failed — ${err instanceof Error ? err.message : 'unknown'}`,
        ),
      );
    }
  }
  return reloaded;
};

/** One pass of the `org serve` runfile poll — the mirror of pollStopfiles.
 *
 * A serve daemon owns its orgs, and nothing could ask it to start one off-cycle:
 * a scheduled org simply waited for its next tick, and `org run` against a
 * served org would spawn a second daemon competing for the same runtime.json
 * and broker lease. "Run it now" therefore meant killing and restarting the
 * daemon, which resets the schedule and drops any in-flight work.
 *
 * `.monomind/orgs/<name>/run` is the request. Consumed (deleted) before the
 * start, so a crash mid-run cannot wedge the org into a restart loop, and an
 * already-running org just clears it — "start now" on something already started
 * is satisfied, not an error.
 *
 * Returns the names it started, so callers/tests don't have to guess. */
function runfileOrgSigned(
  cwd: string,
  orgDir: string,
  name: string,
): { ok: true } | { ok: false; message: string } {
  if (!orgSignatureEnforced()) return { ok: true };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(orgDir, `${name}.json`), 'utf8'));
  } catch (err) {
    return { ok: false, message: `definition unreadable (${(err as Error).message})` };
  }
  const check = verifyOrgDef(cwd, name, raw);
  return check.ok ? check : { ok: false, message: check.message };
}

export const pollRunfiles = async (cwd: string, daemon: OrgDaemon): Promise<string[]> => {
  const started: string[] = [];
  const orgDir = join(cwd, ORG_DIR);
  if (!existsSync(orgDir)) return started;
  for (const f of listOrgConfigFiles(orgDir)) {
    const name = f.replace(/\.json$/, '');
    const runfile = join(orgDir, name, 'run');
    if (!existsSync(runfile)) continue;
    // Read before consuming. Pre-runfile writers (and a hand-touched file) left
    // a bare timestamp or nothing at all, so an unparseable body is a plain
    // "start it" request, not an error.
    let task: string | undefined;
    try {
      const body = JSON.parse(readFileSync(runfile, 'utf8')) as { task?: string | null };
      if (typeof body.task === 'string' && body.task.trim()) task = body.task;
    } catch {
      /* bare/empty runfile — start with the org's own goal */
    }
    try {
      unlinkSync(runfile);
    } catch {
      /* already gone */
    }
    if (daemon.listRunning().includes(name)) continue; // already running — request satisfied
    // #502: a role that can write .monomind/orgs/ could drop in a new org
    // plus its runfile. Never start one the operator has not signed.
    // (prepareOrgStart checks again on the bytes it actually parses.)
    const signed = runfileOrgSigned(cwd, orgDir, name);
    if (!signed.ok) {
      log(output.warning(`org ${name}: run request refused — ${signed.message}`));
      continue;
    }
    log(output.info(`org ${name}: run requested — starting now${task ? ' (with task)' : ''}`));
    try {
      await daemon.startOrg(name, task);
      started.push(name);
    } catch (err) {
      console.error(`org ${name}: requested start failed:`, err);
    }
  }
  return started;
};
