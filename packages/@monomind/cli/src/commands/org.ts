// packages/@monomind/cli/src/commands/org.ts

import { existsSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { migrateOrgFile } from '../orgrt/migrate.js';
import { ORG_DIR, OrgDefSchema } from '../orgrt/types.js';
import { output } from '../output.js';
import type { Command, CommandContext, CommandResult } from '../types.js';
import {
  listOrgConfigFiles,
  ORG_ARTIFACT_SUFFIXES,
  ORG_NAME_RE,
  validateOrgName,
} from './org-control.js';
import {
  pauseAction,
  reloadAction,
  resumeAction,
  statusAction,
  stopAction,
} from './org-lifecycle.js';
import { runAction } from './org-run.js';
import { serveAction, supervisorAction } from './org-serve.js';

export {
  checkServeLock,
  classifyRun,
  clearReloadfile,
  clearStaleControlFiles,
  clearStopfile,
  isOrgPaused,
  listOrgConfigFiles,
  type RunLiveEvidence,
  type RunState,
  type ServeLockCheck,
  validateOrgName,
} from './org-control.js';
export {
  pollReloadfiles,
  pollRunfiles,
  pollStopfiles,
  runOutcomeResult,
  waitForRunEnd,
} from './org-poll.js';

const log = (text: string): void => {
  console.log(text);
};

/** True when runtime.json records a running org whose recorded pid is still alive. */
const isOrgRunning = (cwd: string, name: string): boolean => {
  try {
    const rt = JSON.parse(readFileSync(join(cwd, ORG_DIR, name, 'runtime.json'), 'utf8')) as {
      status?: string;
      pid?: number;
    };
    if (rt.status !== 'running' || !rt.pid) return false;
    process.kill(rt.pid, 0); // throws if the pid is gone (crashed daemon left a stale file)
    return true;
  } catch {
    return false;
  }
};

const testLoopAction = async (ctx: CommandContext): Promise<CommandResult> => {
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

const listAction = async (ctx: CommandContext): Promise<CommandResult> => {
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
          const rt = JSON.parse(readFileSync(join(orgsDir, stem, 'runtime.json'), 'utf8')) as {
            status?: string;
            pid?: number;
          };
          status = rt.status ?? status;
          // Same liveness rule as `org status`: a 'running' record with a dead
          // pid is a crashed daemon, not a running org — list must not disagree.
          if (status === 'running' && rt.pid) {
            try {
              process.kill(rt.pid, 0);
            } catch {
              status = 'crashed';
            }
          }
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
        const rt = JSON.parse(readFileSync(join(orgsDir, stem, 'runtime.json'), 'utf8')) as {
          status?: string;
          pid?: number;
        };
        status = rt.status ?? status;
        // Same liveness rule as `org status`: a 'running' record with a dead
        // pid is a crashed daemon, not a running org — list must not disagree.
        if (status === 'running' && rt.pid) {
          try {
            process.kill(rt.pid, 0);
          } catch {
            status = 'crashed';
          }
        }
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

const deleteAction = async (ctx: CommandContext): Promise<CommandResult> => {
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
  let rt: { status?: string; run?: string; pid?: number };
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
  if (rt.status === 'running' && rt.pid) {
    try {
      process.kill(rt.pid, 0);
      return { cleared: false, reason: 'alive', detail: String(rt.pid) };
    } catch {
      /* pid is gone — this is exactly the stale case mark-complete exists for */
    }
  }
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

const markCompleteAction = async (ctx: CommandContext): Promise<CommandResult> => {
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

const migrateAction = async (ctx: CommandContext): Promise<CommandResult> => {
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

export const orgCommand: Command = {
  name: 'org',
  description: 'SDK-based org runtime — run agent organizations as a controlled daemon',
  subcommands: [
    {
      name: 'skills',
      description:
        'Browse the org skill library and import skills (MIT/Apache-2.0) from other repos',
      options: [
        { name: 'tag', description: 'Filter by tag (list, search)', type: 'string' },
        { name: 'limit', description: 'Max search results (default 10)', type: 'number' },
        {
          name: 'global',
          description: 'import: into ~/.monomind/org-skills instead of this project',
          type: 'boolean',
        },
        { name: 'into', description: 'import: into this library directory', type: 'string' },
        { name: 'only', description: 'import: comma-separated skill names', type: 'string' },
        {
          name: 'tags',
          description: 'import: comma-separated tags to give imported skills',
          type: 'string',
        },
        {
          name: 'overwrite',
          description: 'import: replace skills already in the library',
          type: 'boolean',
        },
      ],
      examples: [
        {
          command: 'monomind org skills search "backend api reviewer"',
          description: 'Find skills for a role',
        },
        { command: 'monomind org skills show systematic-debugging', description: 'Read one skill' },
        {
          command: 'monomind org skills import obra/superpowers --global',
          description: "Import a repo's skills",
        },
      ],
      action: async (ctx: CommandContext): Promise<CommandResult> => {
        const { orgSkillsAction } = await import('./org-skills.js');
        return orgSkillsAction(ctx);
      },
    },
    {
      name: 'run',
      description: 'Start an org (foreground daemon)',
      options: [
        { name: 'task', description: 'Override the org goal for this run', type: 'string' },
        {
          name: 'resume',
          description: 'Resume an org run from its persisted checkpoint instead of starting fresh',
          type: 'boolean',
        },
        {
          name: 'cross-process',
          description:
            'Discover and message orgs hosted by other monomind processes on this machine (default true)',
          type: 'boolean',
          default: true,
        },
        {
          name: 'dry-run',
          description:
            "Validate and print each role's briefing without starting any agent sessions",
          type: 'boolean',
        },
        {
          name: 'budget-usd',
          description:
            'Hard-stop the run if the upfront cost estimate exceeds this USD value (e.g. --budget-usd 5)',
          type: 'number',
        },
        {
          name: 'yes',
          short: 'y',
          description: 'Skip the interactive cost-estimate confirmation prompt',
          type: 'boolean',
        },
        {
          name: 'auto-approve',
          description:
            'Comma-separated gated tools every role may call without human approval for this run (e.g. org_complete). -y alone approves nothing',
          type: 'string',
        },
      ],
      examples: [
        {
          command: 'monomind org run growth --task "weekly report"',
          description: 'Run the growth org once with a task',
        },
        {
          command: 'monomind org run growth --task "weekly report" -y --auto-approve org_complete',
          description:
            'Unattended one-shot run that may end itself without a human approving org_complete',
        },
      ],
      action: runAction,
    },
    { name: 'stop', description: 'Request a running org daemon to stop', action: stopAction },
    {
      name: 'pause',
      description: 'Pause an org — current turns finish, no new cycles start',
      action: pauseAction,
    },
    { name: 'resume', description: 'Resume a paused org', action: resumeAction },
    {
      name: 'reload',
      description: 'Hot-reload an org definition without stopping sessions',
      action: reloadAction,
    },
    { name: 'status', description: 'Show runtime state of orgs', action: statusAction },
    {
      name: 'serve',
      description: 'Start the daemon server only (hosts scheduled orgs)',
      options: [
        {
          name: 'cross-process',
          description:
            'Discover and message orgs hosted by other monomind processes on this machine (default true)',
          type: 'boolean',
          default: true,
        },
      ],
      action: serveAction,
    },
    {
      name: 'supervisor',
      description: 'Print (or --install) a launchd/systemd unit that keeps `org serve` running',
      options: [
        { name: 'format', description: 'launchd or systemd (default: platform)', type: 'string' },
        {
          name: 'install',
          description: 'Write the unit into the per-user location',
          type: 'boolean',
        },
      ],
      action: supervisorAction,
    },
    {
      name: 'test-loop',
      description: 'Run the org e2e verification loop N times',
      options: [
        { name: 'times', short: 'n', description: 'Iterations', type: 'number', default: 5 },
        {
          name: 'scenario',
          description:
            'Run a declarative scenario file (.monomind/scenarios/<file>) instead of the built-in fixture — structural dry-run only',
          type: 'string',
        },
      ],
      action: testLoopAction,
    },
    {
      name: 'logs',
      description: 'Show (or follow) the formatted event log of an org run',
      options: [
        { name: 'run', description: 'Run id (default: latest)', type: 'string' },
        { name: 'role', description: 'Only events from/to this role', type: 'string' },
        {
          name: 'filter-tool',
          description: 'Filter events by tool name (e.g., Write, Edit)',
          type: 'string',
        },
        { name: 'filter-role', description: 'Filter events by role ID', type: 'string' },
        {
          name: 'tools-only',
          description: 'Show only tool events (exclude messages/status/audit)',
          type: 'boolean',
        },
        {
          name: 'audit-filter',
          description: 'Filter audit events by decision (allow|deny)',
          type: 'string',
        },
        { name: 'follow', short: 'f', description: 'Keep tailing until Ctrl-C', type: 'boolean' },
      ],
      examples: [
        { command: 'monomind org logs growth --follow', description: 'Live-tail the latest run' },
        {
          command: 'monomind org logs growth --tools-only',
          description: 'Show only tool call events',
        },
      ],
      action: async (ctx: CommandContext): Promise<CommandResult> => {
        const v = validateOrgName(ctx.args[0]);
        if (!v.ok) return v.result;
        const { logsAction } = await import('./org-observe.js');
        return logsAction(ctx, v.name);
      },
    },
    {
      name: 'events',
      description:
        "Tail a run's bus events as NDJSON — the machine streaming surface (agent-exec-protocol.md §7.3)",
      options: [
        { name: 'run', description: 'Run id (default: latest)', type: 'string' },
        { name: 'follow', short: 'f', description: 'Keep tailing until Ctrl-C', type: 'boolean' },
        {
          name: 'since',
          description: 'Replay cursor: an event id or ISO-8601 timestamp',
          type: 'string',
        },
        {
          name: 'ndjson',
          description: 'Accepted for spec symmetry — NDJSON is the only output mode',
          type: 'boolean',
        },
      ],
      examples: [
        {
          command: 'monomind org events growth --follow',
          description: 'Live NDJSON tail of the latest run',
        },
      ],
      action: async (ctx: CommandContext): Promise<CommandResult> => {
        const v = validateOrgName(ctx.args[0]);
        if (!v.ok) return v.result;
        const { eventsAction } = await import('./org-observe.js');
        return eventsAction(ctx, v.name);
      },
    },
    {
      name: 'watch',
      description:
        "Live-tail one role's assistant chat text (any runtime) — a filtered, friendlier `logs --follow`",
      options: [
        { name: 'run', description: 'Run id (default: latest)', type: 'string' },
        {
          name: 'follow',
          description:
            'Set --follow=false to print current output once and exit instead of live-tailing',
          type: 'boolean',
          default: true,
        },
        {
          name: 'verbose',
          description:
            'Also interleave status events (restart/crash/state-change) into the transcript',
          type: 'boolean',
        },
        {
          name: 'stats',
          description: 'Print a running token/cost line as usage events arrive',
          type: 'boolean',
        },
      ],
      examples: [
        {
          command: 'monomind org watch growth researcher',
          description: "Watch the researcher role's live output",
        },
        {
          command: 'monomind org watch growth researcher --verbose --stats',
          description: 'Also show restarts/crashes and a running token/cost total',
        },
      ],
      action: async (ctx: CommandContext): Promise<CommandResult> => {
        const v = validateOrgName(ctx.args[0]);
        if (!v.ok) return v.result;
        const { watchAction } = await import('./org-observe.js');
        return watchAction(ctx, v.name);
      },
    },
    {
      name: 'report',
      description: 'Summarize an org run: outcome, per-role activity, tokens, assets, crashes',
      options: [
        { name: 'run', description: 'Run id (default: latest)', type: 'string' },
        { name: 'all', description: 'List all recorded runs from history', type: 'boolean' },
        { name: 'by-role', description: 'Show per-role cost breakdown', type: 'boolean' },
        { name: 'audit', description: 'Show tool audit trail', type: 'boolean' },
        {
          name: 'tool',
          description: 'Filter tool audit by tool name (with --audit)',
          type: 'string',
        },
        { name: 'format', description: 'Output format (mermaid for flowchart)', type: 'string' },
      ],
      examples: [
        { command: 'monomind org report growth', description: 'Report on the latest run' },
      ],
      action: async (ctx: CommandContext): Promise<CommandResult> => {
        const v = validateOrgName(ctx.args[0]);
        if (!v.ok) return v.result;
        const { reportAction } = await import('./org-observe.js');
        return reportAction(ctx, v.name);
      },
    },
    {
      name: 'memory',
      description:
        "Inspect an org's cross-run memory and knowledge graph (stats | search <query> | rules | rollback <run-ref> | promote <run-ref>)",
      examples: [
        { command: 'monomind org memory growth stats', description: 'KG size and namespaces' },
        {
          command: 'monomind org memory growth search "launch checklist"',
          description: 'Search org memory + KG',
        },
        {
          command: 'monomind org memory growth rollback run:m4x2',
          description: "Withdraw one run's support from this org's KG",
        },
        {
          command: 'monomind org memory growth promote run:m4x2',
          description: "Share one run's claims with project-wide knowledge",
        },
      ],
      action: async (ctx: CommandContext): Promise<CommandResult> => {
        const v = validateOrgName(ctx.args[0]);
        if (!v.ok) return v.result;
        const sub = String(ctx.args[1] ?? 'stats');
        const { join } = await import('node:path');
        const cwd = ctx.cwd || process.cwd();
        const dbPath = join(cwd, '.monomind', 'org-memory');
        const kg = await import('../memory/memory-kg.js');
        const bridge = await import('../memory/memory-bridge.js');
        const { orgKgScope, orgMemoryNamespace } = await import('../orgrt/org-memory.js');
        // Every KG operation below is scoped to the requested org, so the org
        // name in the output describes what was actually read, not just what
        // was asked for. Reads of the shared store are unchanged.
        const scope = orgKgScope(v.name);
        const kgNs = kg.kgNamespaces(scope);
        // Flat org memory is namespaced by the org DEFINITION, not by name —
        // resolve it the way the runtime writes it (B4), so a configured
        // `memory_namespace` is searched instead of a guessed `org:<name>`.
        const defPath = join(cwd, ORG_DIR, `${v.name}.json`);
        const flatNs = existsSync(defPath)
          ? orgMemoryNamespace(
              v.name,
              OrgDefSchema.parse(JSON.parse(readFileSync(defPath, 'utf8'))),
            )
          : `org:${v.name}`;
        try {
          if (sub === 'stats') {
            const [stats, glossary, backend] = await Promise.all([
              kg.kgStats({ dbPath, scope }),
              kg.kgGlossary({ dbPath, limit: 15, scope }),
              bridge.bridgeGetBackendStats(dbPath),
            ]);
            // The backend reports every namespace in the SHARED store, so
            // listing it raw put other orgs' namespaces (and their counts)
            // under this org's name. Keep only what this org owns.
            // Spread kgNs rather than listing namespaces: the identity work
            // added `names` (the entity name index), and a hand-written list
            // silently omits any namespace added later, hiding rows this org
            // does own.
            const owned = new Set<string>([...Object.values(kgNs), flatNs]);
            const byNs = Object.fromEntries(
              Object.entries(backend?.entriesByNamespace ?? {}).filter(
                ([ns]) => owned.has(ns) || ns.startsWith(`agent:${flatNs}:`),
              ),
            );
            if (ctx.flags.format === 'json') {
              const payload = { v: 1, org: v.name, ...stats, glossary, namespaces: byNs };
              process.stdout.write(`${JSON.stringify(payload)}\n`);
              return { success: true, data: payload };
            }
            log(
              output.info(
                `Knowledge graph: ${stats.nodes} entities, ${stats.edges} relations, ${stats.rules} rules`,
              ),
            );
            if (glossary.length) log(output.info(`Top entities: ${glossary.join(', ')}`));
            for (const [ns, count] of Object.entries(byNs))
              log(output.info(`  ${ns}: ${count} entries`));
            return {
              success: true,
              message: 'org memory stats',
              data: { ...stats, namespaces: byNs },
            };
          }
          if (sub === 'search') {
            const q = ctx.args.slice(2).join(' ');
            if (!q) return { success: false, message: 'usage: org memory <org> search <query>' };
            const [mem, graph] = await Promise.all([
              bridge.bridgeSearchEntries({
                query: q,
                namespace: flatNs,
                limit: 5,
                dbPath,
              }),
              kg.kgSearch({ query: q, dbPath, limit: 8, scope }),
            ]);
            if (ctx.flags.format === 'json') {
              const payload = {
                v: 1,
                org: v.name,
                query: q,
                memories: mem?.results ?? [],
                triplets: graph.triplets,
                kg_context: graph.context ?? null,
              };
              process.stdout.write(`${JSON.stringify(payload)}\n`);
              return { success: true, data: payload };
            }
            for (const r of mem?.results ?? [])
              log(output.info(`[${r.score.toFixed(2)}] ${r.key}: ${r.content.slice(0, 160)}`));
            if (graph.context) log(output.info(`\nKnowledge graph:\n${graph.context}`));
            return {
              success: true,
              message: `${(mem?.results ?? []).length} memories, ${graph.triplets.length} triplets`,
            };
          }
          if (sub === 'rules') {
            const rules = await kg.kgListRules({ dbPath, limit: 50, scope });
            if (ctx.flags.format === 'json') {
              const payload = { v: 1, org: v.name, items: rules };
              process.stdout.write(`${JSON.stringify(payload)}\n`);
              return { success: true, data: payload };
            }
            for (const r of rules) log(output.info(`- ${r.rule.slice(0, 200)}`));
            return { success: true, message: `${rules.length} rules`, data: { rules } };
          }
          if (sub === 'rollback') {
            const ref = ctx.args[2];
            if (!ref)
              return {
                success: false,
                message: 'usage: org memory <org> rollback <origin-ref> (e.g. run:m4x2)',
              };
            // Scoped: the ref is resolved inside this org's namespaces and
            // origin space, so the org name in the command is an ownership
            // restriction rather than a label on an unfiltered rollback.
            const res = await kg.kgRollback({ originRef: ref, scope, dbPath });
            if (ctx.flags.format === 'json') {
              const payload = { v: 1, org: v.name, ref, ...res };
              process.stdout.write(`${JSON.stringify(payload)}\n`);
              return { success: res.success, data: payload };
            }
            log(
              output.info(
                `Rolled back ${ref} for org ${v.name}: ${res.deleted} deleted, ${res.retained} retained (shared with other origins)`,
              ),
            );
            return { success: res.success, message: `rollback ${ref}`, data: res };
          }
          if (sub === 'promote') {
            const ref = ctx.args[2];
            if (!ref)
              return {
                success: false,
                message: 'usage: org memory <org> promote <origin-ref> (e.g. run:m4x2)',
              };
            const res = await kg.kgPromote({ originRef: ref, from: scope, dbPath });
            if (ctx.flags.format === 'json') {
              const payload = { v: 1, org: v.name, ref, ...res };
              process.stdout.write(`${JSON.stringify(payload)}\n`);
              return { success: res.success, data: payload };
            }
            log(
              output.info(
                res.success
                  ? `Promoted ${ref} from org ${v.name} to project-shared knowledge: ${res.nodes} entities, ${res.edges} relations, ${res.rules} rules. Withdraw with origin ref ${res.promotedAs}.`
                  : `Promotion of ${ref} failed: ${res.error ?? 'unknown error'}`,
              ),
            );
            return { success: res.success, message: `promote ${ref}`, data: res };
          }
          return {
            success: false,
            message: `unknown subcommand "${sub}" — use stats | search | rules | rollback | promote`,
          };
        } finally {
          await bridge.shutdownBridge().catch(() => {
            /* best effort */
          });
        }
      },
    },
    {
      name: 'costs',
      description: 'Show per-role cost tracking from runtime.json',
      options: [{ name: 'run', description: 'Run ID (defaults to latest)', type: 'string' }],
      examples: [
        { command: 'monomind org costs growth', description: 'Show cost breakdown for latest run' },
        {
          command: 'monomind org costs growth --run run-20240130-123456',
          description: 'Show cost breakdown for specific run',
        },
      ],
      action: async (ctx: CommandContext): Promise<CommandResult> => {
        const v = validateOrgName(ctx.args[0]);
        if (!v.ok) return v.result;
        const { costsAction } = await import('./org-observe.js');
        return costsAction(ctx, v.name);
      },
    },
    {
      name: 'inbox',
      description:
        'Deliver an inbound cross-org message (live to a running org, queued to inbox.jsonl otherwise) — remote.ts shells out to this over SSH',
      options: [
        {
          name: 'json',
          description: 'JSON payload: {"from":"orgA:role","subject":"...","body":"..."}',
          type: 'string',
        },
        { name: 'to', description: "Target role (default: the org's coordinator)", type: 'string' },
        {
          name: 'from',
          description: 'Sender, qualified "org:role" (alternative to --json)',
          type: 'string',
        },
        { name: 'subject', description: 'Subject (alternative to --json)', type: 'string' },
        { name: 'body', description: 'Body (alternative to --json)', type: 'string' },
      ],
      examples: [
        {
          command:
            'monomind org inbox growth --json \'{"from":"sales:boss","subject":"leads","body":"..."}\'',
          description: 'Deliver a message to the growth org',
        },
        {
          command:
            'monomind org inbox growth --to lead --from growth:publisher-bot --subject "re: post" --body "done" --format json',
          description:
            'Reply as an automation role; prints {"v":1,"org","to","from","delivery","receipt","messageId"}',
        },
      ],
      action: async (ctx: CommandContext): Promise<CommandResult> => {
        const v = validateOrgName(ctx.args[0]);
        if (!v.ok) return v.result;
        const { inboxAction } = await import('./org-observe.js');
        return inboxAction(ctx, v.name);
      },
    },
    {
      name: 'flow',
      description: 'Export org flow as Mermaid diagram',
      options: [{ name: 'run', description: 'Run ID (defaults to latest)', type: 'string' }],
      examples: [
        {
          command: 'monomind org flow growth --run run-20250130120000',
          description: 'Export Mermaid flowchart',
        },
      ],
      action: async (ctx: CommandContext): Promise<CommandResult> => {
        const v = validateOrgName(ctx.args[0]);
        if (!v.ok) return v.result;
        const { flowAction } = await import('./org-observe.js');
        return flowAction(ctx, v.name);
      },
    },
    {
      name: 'questions',
      description: "List pending ask_human questions from an org's agents",
      options: [{ name: 'all', description: 'Include answered questions', type: 'boolean' }],
      examples: [
        { command: 'monomind org questions growth', description: 'Show unanswered questions' },
      ],
      action: async (ctx: CommandContext): Promise<CommandResult> => {
        const v = validateOrgName(ctx.args[0]);
        if (!v.ok) return v.result;
        const { questionsAction } = await import('./org-observe.js');
        return questionsAction(ctx, v.name);
      },
    },
    {
      name: 'approvals',
      description: "List pending tool/action approval requests from an org's agents",
      options: [{ name: 'all', description: 'Include resolved approvals', type: 'boolean' }],
      examples: [
        { command: 'monomind org approvals growth', description: 'Show pending approvals' },
      ],
      action: async (ctx: CommandContext): Promise<CommandResult> => {
        const v = validateOrgName(ctx.args[0]);
        if (!v.ok) return v.result;
        const { approvalsAction } = await import('./org-observe.js');
        return approvalsAction(ctx, v.name);
      },
    },
    {
      name: 'answer',
      description:
        'Answer a pending ask_human question (live if the org is running, queued otherwise)',
      options: [
        {
          name: 'by',
          description: 'Resolver recorded as resolvedBy (default: human)',
          type: 'string',
        },
      ],
      examples: [
        {
          command: 'monomind org answer growth q-123-ab "yes, ship it"',
          description: 'Answer question q-123-ab',
        },
      ],
      action: async (ctx: CommandContext): Promise<CommandResult> => {
        const v = validateOrgName(ctx.args[0]);
        if (!v.ok) return v.result;
        const { answerAction } = await import('./org-observe.js');
        return answerAction(ctx, v.name);
      },
    },
    {
      name: 'approve',
      description: 'Approve a pending tool/action approval',
      options: [
        {
          name: 'request',
          description: 'Resolve only this approval request id (apr-…)',
          type: 'string',
        },
        {
          name: 'by',
          description: 'Resolver recorded as resolvedBy (default: human)',
          type: 'string',
        },
      ],
      examples: [
        {
          command: 'monomind org approve growth coder "Bash"',
          description: 'Approve Bash tool for coder role',
        },
      ],
      action: async (ctx: CommandContext): Promise<CommandResult> => {
        const v = validateOrgName(ctx.args[0]);
        if (!v.ok) return v.result;
        const { approveAction } = await import('./org-observe.js');
        return approveAction(ctx, v.name);
      },
    },
    {
      name: 'deny',
      description: 'Deny a pending tool/action approval',
      options: [
        {
          name: 'request',
          description: 'Resolve only this approval request id (apr-…)',
          type: 'string',
        },
        {
          name: 'by',
          description: 'Resolver recorded as resolvedBy (default: human)',
          type: 'string',
        },
      ],
      examples: [
        {
          command: 'monomind org deny growth coder "Bash"',
          description: 'Deny Bash tool for coder role',
        },
      ],
      action: async (ctx: CommandContext): Promise<CommandResult> => {
        const v = validateOrgName(ctx.args[0]);
        if (!v.ok) return v.result;
        const { denyAction } = await import('./org-observe.js');
        return denyAction(ctx, v.name);
      },
    },
    {
      name: 'gates',
      description: "List decision gates from an org's agents",
      options: [{ name: 'all', description: 'Include resolved gates', type: 'boolean' }],
      examples: [
        { command: 'monomind org gates growth', description: 'Show pending gates' },
        { command: 'monomind org gates growth --all', description: 'Show all gates' },
      ],
      action: async (ctx: CommandContext): Promise<CommandResult> => {
        const v = validateOrgName(ctx.args[0]);
        if (!v.ok) return v.result;
        const { gatesAction } = await import('./org-observe.js');
        return gatesAction(ctx, v.name);
      },
    },
    {
      name: 'gate-approve',
      description: 'Approve a pending decision gate',
      options: [
        {
          name: 'by',
          description: 'Resolver recorded as resolvedBy (default: human)',
          type: 'string',
        },
      ],
      examples: [
        {
          command: 'monomind org gate-approve growth gate-123-ab "ship it"',
          description: 'Approve gate with resolution',
        },
      ],
      action: async (ctx: CommandContext): Promise<CommandResult> => {
        const v = validateOrgName(ctx.args[0]);
        if (!v.ok) return v.result;
        const { gateResolveAction } = await import('./org-observe.js');
        return gateResolveAction(ctx, v.name, true);
      },
    },
    {
      name: 'gate-reject',
      description: 'Reject a pending decision gate',
      options: [
        {
          name: 'by',
          description: 'Resolver recorded as resolvedBy (default: human)',
          type: 'string',
        },
      ],
      examples: [
        {
          command: 'monomind org gate-reject growth gate-123-ab "not ready"',
          description: 'Reject gate with reason',
        },
      ],
      action: async (ctx: CommandContext): Promise<CommandResult> => {
        const v = validateOrgName(ctx.args[0]);
        if (!v.ok) return v.result;
        const { gateResolveAction } = await import('./org-observe.js');
        return gateResolveAction(ctx, v.name, false);
      },
    },
    {
      name: 'replay',
      description:
        'Time-travel debugging: replay a run\'s bus events (does not resume live execution — use "org run --resume" for that)',
      examples: [
        {
          command: 'monomind org replay growth run-20250130120000-abc',
          description: "Replay a checkpoint's events for inspection",
        },
      ],
      action: async (ctx: CommandContext): Promise<CommandResult> => {
        const v = validateOrgName(ctx.args[0]);
        if (!v.ok) return v.result;
        const { replayAction } = await import('./org-observe.js');
        return replayAction(ctx, v.name);
      },
    },
    {
      name: 'resume-from',
      description:
        "Resume live execution from the org's persisted checkpoint (restores mailbox/policy/session state; subject to TTL and checksum validation)",
      examples: [
        {
          command: 'monomind org resume-from growth',
          description: 'Resume growth from its last checkpoint',
        },
      ],
      action: async (ctx: CommandContext): Promise<CommandResult> => {
        const v = validateOrgName(ctx.args[0]);
        if (!v.ok) return v.result;
        const { resumeFromAction } = await import('./org-observe.js');
        return resumeFromAction(ctx, v.name);
      },
    },
    {
      name: 'branch',
      description:
        "Snapshot a run's event log into a new run for replay — usage: org branch <org> <run-id> <label>. The new run's id is generated; <label> is only a note recorded in its .branch-source",
      examples: [
        {
          command: 'monomind org branch growth run-20250130 "before the outage"',
          description:
            'Snapshot run-20250130 into a new generated run id, noting why in .branch-source (the label does not name the run)',
        },
        {
          command: 'monomind org branch growth run-20250130 pre-outage --format json',
          description:
            'Same, printing {"run": "<generated id>", ...} so a script can replay it without parsing prose',
        },
      ],
      action: async (ctx: CommandContext): Promise<CommandResult> => {
        const v = validateOrgName(ctx.args[0]);
        if (!v.ok) return v.result;
        const { branchAction } = await import('./org-observe.js');
        return branchAction(ctx, v.name);
      },
    },
    {
      name: 'decisions',
      description: 'Show Rifft-style decision traces',
      examples: [
        {
          command: 'monomind org decisions growth --run run-20250130',
          description: 'Show decision traces',
        },
      ],
      action: async (ctx: CommandContext): Promise<CommandResult> => {
        const v = validateOrgName(ctx.args[0]);
        if (!v.ok) return v.result;
        const { decisionsAction } = await import('./org-observe.js');
        return decisionsAction(ctx, v.name);
      },
    },
    {
      name: 'create',
      description: 'Scaffold an org config from a starter template',
      options: [
        {
          name: 'template',
          description:
            'content-team | dev-team | research-pod | kg-extraction | advisor-orchestrator',
          type: 'string',
        },
        {
          name: 'goal',
          description: "Org goal (defaults to the template's placeholder)",
          type: 'string',
        },
        { name: 'schedule', description: 'Daemon schedule, e.g. 30m or 2h', type: 'string' },
        { name: 'force', description: 'Overwrite an existing org config', type: 'boolean' },
        {
          name: 'yes',
          short: 'y',
          description: 'Skip the per-role model confirmation prompt (TTY only)',
          type: 'boolean',
        },
      ],
      examples: [
        {
          command: 'monomind org create blog --template content-team --goal "3 posts/week"',
          description: 'Create a content org',
        },
      ],
      action: async (ctx: CommandContext): Promise<CommandResult> => {
        const v = validateOrgName(ctx.args[0]);
        if (!v.ok) return v.result;
        const { createAction } = await import('./org-observe.js');
        return createAction(ctx, v.name);
      },
    },
    {
      name: 'validate',
      description: 'Validate org config(s) against the runtime schema and structural invariants',
      examples: [
        { command: 'monomind org validate growth', description: 'Validate one org config' },
        {
          command: 'monomind org validate',
          description: 'Validate every org config in the project',
        },
      ],
      action: async (ctx: CommandContext): Promise<CommandResult> => {
        const { validateAction } = await import('./org-observe.js');
        return validateAction(ctx);
      },
    },
    {
      name: 'migrate',
      description: 'Convert a legacy-format org config (topology/board/loop) to the current format',
      examples: [
        {
          command: 'monomind org migrate growth',
          description: 'Migrate one org; original saved as growth.v1.json',
        },
      ],
      action: migrateAction,
    },
    { name: 'list', description: 'List all orgs in the current project', action: listAction },
    {
      name: 'delete',
      description: 'Delete an org and all its data',
      options: [
        { name: 'yes', short: 'y', description: 'Skip confirmation', type: 'boolean' },
        {
          name: 'force',
          description: 'Delete even if the org appears to be running',
          type: 'boolean',
        },
      ],
      action: deleteAction,
    },
    {
      name: 'mark-complete',
      description: 'Manually close a stale/crashed run',
      action: markCompleteAction,
    },
  ],
  examples: [
    { command: 'monomind org run my-org', description: 'Run an org under full daemon control' },
  ],
  action: async (): Promise<CommandResult> => {
    // index.ts's dispatcher never prints result.message on a failed action —
    // it only exits with result.exitCode — so this must log itself or bare
    // `monomind org` exits silently with code 1 and zero output.
    const message =
      'usage: monomind org <run|stop|status|serve|test-loop|logs|report|costs|inbox|questions|answer|approve|deny|replay|resume-from|branch|decisions|create|validate|migrate|list|delete|mark-complete>';
    log(output.error(message));
    return { success: false, message };
  },
};

export default orgCommand;
