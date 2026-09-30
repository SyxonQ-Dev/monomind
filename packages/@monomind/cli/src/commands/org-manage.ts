// packages/@monomind/cli/src/commands/org-manage.ts
//
// `monomind org test-loop | list | delete | mark-complete | migrate` — org
// config and run-record management.

import { existsSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { migrateOrgFile } from '../orgrt/migrate.js';
import { recordedPidLiveness } from '../orgrt/run-liveness.js';
import { ORG_DIR } from '../orgrt/types.js';
import { output } from '../output.js';
import type { CommandContext, CommandResult } from '../types.js';
import {
  listOrgConfigFiles,
  ORG_ARTIFACT_SUFFIXES,
  ORG_NAME_RE,
  validateOrgName,
} from './org-control.js';

const log = (text: string): void => {
  console.log(text);
};

/** True when runtime.json records a running org whose recorded pid is still
 *  its process (#573: alive, and not reused by another process). */
const isOrgRunning = (cwd: string, name: string): boolean => {
  try {
    const rt = JSON.parse(readFileSync(join(cwd, ORG_DIR, name, 'runtime.json'), 'utf8')) as {
      status?: string;
      pid?: number;
      pidStart?: string;
    };
    if (rt.status !== 'running' || !rt.pid) return false;
    return recordedPidLiveness(rt.pid, rt.pidStart) === 'alive';
  } catch {
    return false;
  }
};

/** runtime.json's status as `org list` reports it: a 'running' record whose
 *  pid is gone or reused is a crashed daemon, not a running org (#573). */
const listedStatus = (rt: {
  status?: string;
  pid?: number;
  pidStart?: string;
}): string | undefined =>
  rt.status === 'running' && rt.pid && recordedPidLiveness(rt.pid, rt.pidStart) !== 'alive'
    ? 'crashed'
    : rt.status;

export const testLoopAction = async (ctx: CommandContext): Promise<CommandResult> => {
  // non-literal specifier: test-loop.ts lands in a later task; keeps tsc clean until then
  const testLoopModule = '../orgrt/test-loop.js';
  const { runTestLoop } = (await import(testLoopModule)) as {
    runTestLoop: (
      cwd: string,
      times: number,
      scenarioFile?: string,
    ) => Promise<{ summary: string; failed: number }>;
  };
  const n = Number(ctx.flags.times ?? ctx.flags.n ?? 5);
  const scenario = typeof ctx.flags.scenario === 'string' ? ctx.flags.scenario : undefined;
  const report = await runTestLoop(ctx.cwd, n, scenario);
  log(output.info(report.summary));
  return { success: report.failed === 0, message: report.summary };
};

// ---- legacy management subcommands (list / delete / mark-complete) ----

export const listAction = async (ctx: CommandContext): Promise<CommandResult> => {
  const orgsDir = join(ctx.cwd || process.cwd(), ORG_DIR);
  if (!existsSync(orgsDir)) {
    if (ctx.flags.format === 'json') {
      process.stdout.write(`${JSON.stringify({ v: 1, items: [] })}\n`);
      return { success: true };
    }
    log(output.info('No orgs directory found. Create an org first with /mastermind:createorg'));
    return { success: true };
  }
  const configs = listOrgConfigFiles(orgsDir);
  if (!configs.length) {
    if (ctx.flags.format === 'json') {
      process.stdout.write(`${JSON.stringify({ v: 1, items: [] })}\n`);
      return { success: true };
    }
    log(output.info('No orgs found.'));
    return { success: true };
  }
  if (ctx.flags.format === 'json') {
    const items = configs.map((f) => {
      const stem = f.replace(/\.json$/, '');
      try {
        const def = JSON.parse(readFileSync(join(orgsDir, f), 'utf8')) as {
          goal?: string;
          schedule?: string | number | null;
          roles?: unknown[];
        };
        let status = 'never run';
        try {
          const rt = JSON.parse(readFileSync(join(orgsDir, stem, 'runtime.json'), 'utf8'));
          // Same liveness rule as `org status` — list must not disagree.
          status = listedStatus(rt) ?? status;
        } catch {
          /* no runtime state yet */
        }
        return {
          name: stem,
          roles: Array.isArray(def.roles) ? def.roles.length : 0,
          schedule: def.schedule ?? null,
          status,
          goal: typeof def.goal === 'string' ? def.goal : '',
        };
      } catch {
        return { name: stem, roles: 0, schedule: null, status: 'invalid-config', goal: '' };
      }
    });
    process.stdout.write(`${JSON.stringify({ v: 1, items })}\n`);
    return { success: true };
  }
  log(output.info(`Found ${configs.length} org(s):`));
  for (const f of configs) {
    const stem = f.replace(/\.json$/, '');
    let detail = '';
    try {
      const def = JSON.parse(readFileSync(join(orgsDir, f), 'utf8')) as {
        goal?: string;
        schedule?: string | number | null;
        roles?: unknown[];
      };
      const roles = Array.isArray(def.roles) ? def.roles.length : 0;
      const sched = def.schedule ? `every ${def.schedule}` : 'manual';
      let status = 'never run';
      try {
        const rt = JSON.parse(readFileSync(join(orgsDir, stem, 'runtime.json'), 'utf8'));
        // Same liveness rule as `org status` — list must not disagree.
        status = listedStatus(rt) ?? status;
      } catch {
        /* no runtime state yet */
      }
      const goal =
        typeof def.goal === 'string' && def.goal
          ? ` — ${def.goal.length > 60 ? `${def.goal.slice(0, 57)}...` : def.goal}`
          : '';
      detail = `  (${roles} role${roles === 1 ? '' : 's'}, ${sched}, ${status})${goal}`;
    } catch {
      detail = '  (unreadable config — run `monomind org validate`)';
    }
    log(output.info(`  • ${stem}${detail}`));
  }
  return { success: true };
};

export const deleteAction = async (ctx: CommandContext): Promise<CommandResult> => {
  const orgName = ctx.args[0];
  if (!orgName) {
    log(output.error('Usage: monomind org delete <name>'));
    return { success: false, message: 'org name required' };
  }
  if (!ORG_NAME_RE.test(orgName)) {
    log(output.error(`Invalid org name: ${orgName}`));
    return { success: false, message: 'invalid org name' };
  }
  const confirmed = ctx.flags.yes === true || ctx.args.includes('--yes') || ctx.args.includes('-y');
  if (!confirmed) {
    log(output.warning(`This will permanently delete org "${orgName}" and all its data.`));
    log(output.warning('Pass --yes to confirm.'));
    return { success: false, message: 'confirmation required' };
  }
  const cwd = resolve(ctx.cwd || process.cwd());
  const orgsDir = join(cwd, ORG_DIR);
  const configFile = join(orgsDir, `${orgName}.json`);
  if (!existsSync(configFile)) {
    log(output.error(`Org not found: ${orgName}`));
    return { success: false, message: 'org not found' };
  }
  if (isOrgRunning(cwd, orgName) && ctx.flags.force !== true) {
    log(
      output.error(
        `Org "${orgName}" is currently running — stop it first (monomind org stop ${orgName}) or pass --force.`,
      ),
    );
    return { success: false, message: 'org is running' };
  }
  let removed = 0;
  for (const suf of ['', ...ORG_ARTIFACT_SUFFIXES]) {
    for (const ext of ['.json', '.jsonl']) {
      const f = join(orgsDir, `${orgName}${suf}${ext}`);
      try {
        if (existsSync(f)) {
          unlinkSync(f);
          removed++;
        }
      } catch {
        /* ignore */
      }
    }
  }
  try {
    unlinkSync(join(orgsDir, '.stops', `${orgName}.stop`));
  } catch {
    /* ignore */
  }
  const orgSubDir = join(orgsDir, orgName);
  try {
    if (existsSync(orgSubDir)) rmSync(orgSubDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  try {
    unlinkSync(join(cwd, '.monomind', 'loops', `${orgName}.md`));
  } catch {
    /* ignore */
  }
  try {
    unlinkSync(join(orgsDir, `${orgName}-run.md`));
  } catch {
    /* ignore */
  }
  log(output.success(`Org "${orgName}" deleted (${removed} file(s) removed).`));
  return { success: true };
};

/** Clear a stale `running` record from runtime.json. This is the state `org status`
 *  reads, so mark-complete MUST touch it — the dashboard's run:complete event alone
 *  left `org status` reporting the same "crashed" line it had just told the user to
 *  fix with this exact command. Refuses when the recorded pid is still alive: a live
 *  daemon would just rewrite the file, and `org stop` is the right command there. */
const clearStaleRuntime = (
  cwd: string,
  name: string,
):
  | { cleared: true; run?: string }
  | {
      cleared: false;
      reason: 'absent' | 'not-running' | 'alive' | 'unreadable';
      detail?: string;
    } => {
  const rtPath = join(cwd, ORG_DIR, name, 'runtime.json');
  if (!existsSync(rtPath)) return { cleared: false, reason: 'absent' };
  let rt: { status?: string; run?: string; pid?: number; pidStart?: string };
  try {
    rt = JSON.parse(readFileSync(rtPath, 'utf8'));
  } catch (err) {
    return {
      cleared: false,
      reason: 'unreadable',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  if (rt.status !== 'running' && rt.status !== 'crashed')
    return { cleared: false, reason: 'not-running' };
  // A pid that is gone, or now another process's (#573), is exactly the
  // stale case mark-complete exists for.
  if (rt.status === 'running' && rt.pid && recordedPidLiveness(rt.pid, rt.pidStart) === 'alive')
    return { cleared: false, reason: 'alive', detail: String(rt.pid) };
  // Same shape stopOrg's persistState() writes, so every reader (org status,
  // isOrgRunning, the mastermind-org* skills' jq checks) sees a stopped org.
  writeFileSync(
    rtPath,
    JSON.stringify(
      {
        status: 'stopped',
        run: rt.run,
        pid: rt.pid,
        updated: new Date().toISOString(),
        closedBy: 'mark-complete',
      },
      null,
      2,
    ),
  );
  return { cleared: true, run: rt.run };
};

export const markCompleteAction = async (ctx: CommandContext): Promise<CommandResult> => {
  const orgName = ctx.args[0];
  if (!orgName || !ORG_NAME_RE.test(orgName)) {
    log(output.error('Usage: monomind org mark-complete <name>'));
    return { success: false, message: 'valid org name required' };
  }
  const cwd = resolve(ctx.cwd || process.cwd());

  // Reject an org that does not exist, using the same check as runAction. Without
  // it `org mark-complete nosuchorg` printed "local state was cleared" and exited
  // 0 — a typo looked like a successful cleanup.
  const orgsDir = join(cwd, ORG_DIR);
  if (!existsSync(join(orgsDir, `${orgName}.json`))) {
    const known = existsSync(orgsDir)
      ? listOrgConfigFiles(orgsDir).map((f) => f.replace(/\.json$/, ''))
      : [];
    log(
      output.error(
        `Org not found: ${orgName}${known.length ? ` — available: ${known.join(', ')}` : ''}`,
      ),
    );
    return { success: false, message: 'org not found' };
  }

  // 1) Local runtime.json — the state `org status` actually reads. Done first and
  //    independently of the dashboard so the recommended remedy works with no server.
  const local = clearStaleRuntime(cwd, orgName);
  if (!local.cleared && local.reason === 'alive') {
    log(
      output.error(
        `Org "${orgName}" is still running (pid ${local.detail}) — stop it with "monomind org stop ${orgName}" instead.`,
      ),
    );
    return { success: false, message: 'org is running' };
  }
  if (local.cleared)
    log(
      output.success(
        `Cleared stale runtime state for "${orgName}"${local.run ? ` (run ${local.run})` : ''}.`,
      ),
    );
  else if (local.reason === 'unreadable')
    log(
      output.warning(
        `runtime.json for "${orgName}" is unreadable (${local.detail}) — left untouched.`,
      ),
    );
  else
    log(
      output.info(
        `No stale runtime state for "${orgName}" (runtime.json ${local.reason === 'absent' ? 'absent' : 'already not running'}).`,
      ),
    );

  // 2) Dashboard run:complete event — best effort. A missing/unauthorized dashboard
  //    must not make the command fail after the local state was already cleared.
  let ctrlUrl = 'http://localhost:4242';
  try {
    const ctl = JSON.parse(readFileSync(join(cwd, '.monomind', 'control.json'), 'utf8'));
    if (ctl.url) ctrlUrl = ctl.url;
  } catch {
    /* default */
  }
  try {
    // All dashboard /api routes are auth-gated — attach the local session token.
    let auth = '';
    try {
      auth = readFileSync(join(cwd, '.monomind', 'dashboard-token'), 'utf8').trim();
    } catch {
      /* server may be pre-auth */
    }
    // Bounded. Updating the dashboard is best-effort — the local state has
    // already been cleared by this point — but the fetch had no timeout, so a
    // dashboard that holds the port without answering (a wedged build from an
    // earlier session; see the stale-dashboard issue) hung `mark-complete`
    // indefinitely. "Unreachable" and "not answering" must cost the same.
    const res = await fetch(`${ctrlUrl}/api/orgs/${encodeURIComponent(orgName)}/mark-complete`, {
      method: 'POST',
      headers: auth ? { 'x-monomind-token': auth } : {},
      signal: AbortSignal.timeout(5_000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      log(
        output.warning(
          `Dashboard not updated (${res.status}: ${(body as { error?: string }).error || 'unknown error'}) — ${local.cleared ? 'local state was cleared' : 'there was no local state to clear'}.`,
        ),
      );
    } else {
      const runId = (body as { runId?: string }).runId;
      log(
        output.success(
          `Dashboard run marked complete for "${orgName}"${runId ? ` (run ${runId})` : ''}.`,
        ),
      );
    }
  } catch (err) {
    log(
      output.warning(
        `Dashboard unreachable at ${ctrlUrl} (${err instanceof Error ? err.message : 'error'}) — ${local.cleared ? 'local state was cleared' : 'there was no local state to clear'}.`,
      ),
    );
  }
  return local.cleared
    ? { success: true, message: `run marked complete for ${orgName}` }
    : { success: true, message: `nothing to clear for ${orgName}` };
};

export const migrateAction = async (ctx: CommandContext): Promise<CommandResult> => {
  const validated = validateOrgName(ctx.args[0]);
  if (!validated.ok) return validated.result;
  const name = validated.name;
  const cwd = ctx.cwd;
  const cfgPath = join(cwd, ORG_DIR, `${name}.json`);
  if (!existsSync(cfgPath)) {
    log(output.error(`Org not found: ${name}`));
    return { success: false, message: 'org not found' };
  }
  if (isOrgRunning(cwd, name)) {
    log(output.error(`Org "${name}" is currently running — stop it first, then migrate.`));
    return { success: false, message: 'org is running' };
  }
  try {
    const outcome = migrateOrgFile(cfgPath, join(cwd, ORG_DIR, `${name}.v1.json`));
    if (outcome.status === 'already-v2') {
      log(output.info(`${name}: already v2 — nothing to migrate.`));
      return { success: true, message: 'already v2' };
    }
    log(output.success(`${name}: migrated to v2 (backup: ${name}.v1.json)`));
    for (const d of outcome.dropped) log(output.info(`  dropped v1 field: ${d}`));
    for (const n of outcome.notes) log(output.info(`  ${n}`));
    log(output.info(`  run it with: monomind org run ${name}`));
    return { success: true, message: `migrated ${name}` };
  } catch (err) {
    log(
      output.error(`Cannot migrate ${name}: ${err instanceof Error ? err.message : String(err)}`),
    );
    return { success: false, message: 'migration produced an invalid config' };
  }
};
