// packages/@monomind/cli/src/commands/org-observe.ts
// Read-side org subcommands (logs / report) + template scaffolding (create).
// Kept out of org.ts to respect the 500-line file ceiling.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveOrgDefBlueprints } from '../catalog/blueprints.js';
import { branchCheckpoint } from '../orgrt/checkpoint-ops.js';
import { checkOrgStructure } from '../orgrt/migrate.js';
import { readRunEvents } from '../orgrt/reporting.js';
import { gitEnforcementFindings } from '../orgrt/role-sandbox.js';
import { resolveModel } from '../orgrt/session.js';
import { buildFromTemplate, ORG_TEMPLATES } from '../orgrt/templates.js';
import { type DecisionGate, ORG_DIR, OrgDefSchema } from '../orgrt/types.js';
import { output } from '../output.js';
import type { CommandContext, CommandResult } from '../types.js';
import { listOrgConfigFiles, validateOrgName } from './org.js';
import { orgJson, printOrgJson, resolveRun, resolverFlag } from './org-observe-shared.js';

export {
  approvalsAction,
  approveAction,
  denyAction,
} from './org-observe-approvals.js';
export {
  eventsAction,
  logsAction,
  watchAction,
} from './org-observe-logs.js';
export {
  answerAction,
  questionsAction,
} from './org-observe-questions.js';
export {
  costsAction,
  flowAction,
  reportAction,
} from './org-observe-report.js';
export {
  orgJson,
  printOrgJson,
} from './org-observe-shared.js';

const log = (text: string): void => {
  console.log(text);
};

/** Validate org config(s) against OrgDefSchema — the exact parse `org run`/`org serve`
 * perform — plus the structural invariants the runtime assumes but the schema can't
 * express (single root role, resolvable reports_to, unique ids, parseable schedule). */
export const validateAction = async (ctx: CommandContext): Promise<CommandResult> => {
  const orgsDir = join(ctx.cwd || process.cwd(), ORG_DIR);
  let files: string[];
  if (ctx.args[0]) {
    const validated = validateOrgName(ctx.args[0]);
    if (!validated.ok) return validated.result;
    files = [`${validated.name}.json`];
  } else {
    if (!existsSync(orgsDir))
      return {
        success: false,
        message: 'no orgs directory — create an org first with /mastermind:createorg',
      };
    files = listOrgConfigFiles(orgsDir);
    if (!files.length) return { success: false, message: 'no org configs found' };
  }
  let failed = 0;
  for (const f of files) {
    const stem = f.replace(/\.json$/, '');
    const path = join(orgsDir, f);
    const errors: string[] = [];
    const warnings: string[] = [];
    if (!existsSync(path)) {
      log(output.error(`${stem}: not found (${path})`));
      failed++;
      continue;
    }
    try {
      const parsedDef = OrgDefSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
      const bp = resolveOrgDefBlueprints(parsedDef, ctx.cwd || process.cwd());
      const def = bp.def;
      errors.push(...bp.errors);
      for (const n of bp.notes) log(output.info(`${stem}: ${n}`));
      errors.push(...checkOrgStructure(def));
      // ADR-O001 D8: a cost tier that can't resolve a model for a role's
      // provider is a config error, not a runtime fallback — surface it here
      // as well as at daemon start, so it's caught before a run is attempted.
      const { validateCostTiers } = await import('../orgrt/cost-tier.js');
      errors.push(...validateCostTiers(def));
      // S3: a typo'd placeholder would reach the prompt verbatim.
      const { unknownPromptVarErrors } = await import('../orgrt/prompt-vars.js');
      errors.push(...unknownPromptVarErrors(def));
      // ADR-O001 D7: catalog size (>15 is an error, <5 a warning) and every
      // loadout's skills/file must resolve — same checks as daemon start.
      const { validateLoadouts } = await import('../orgrt/loadouts.js');
      const loadoutFindings = validateLoadouts(def, ctx.cwd || process.cwd());
      errors.push(...loadoutFindings.errors);
      warnings.push(...loadoutFindings.warnings);
      const { validateRoleSkills } = await import('../orgrt/skill-library.js');
      errors.push(...def.roles.flatMap((r) => validateRoleSkills(r, ctx.cwd || process.cwd())));
      // #258: roles whose policy.git won't have the OS sandbox behind it here
      const gitFindings = gitEnforcementFindings(def);
      errors.push(...gitFindings.errors);
      warnings.push(...gitFindings.warnings);
      if (def.name !== stem)
        warnings.push(
          `def.name "${def.name}" differs from filename — the runtime addresses this org as "${stem}"`,
        );
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
    for (const w of warnings) log(output.warning(`${stem}: ${w}`));
    if (errors.length) {
      failed++;
      for (const e of errors) log(output.error(`${stem}: ${e}`));
    } else {
      log(
        output.success(
          `${stem}: valid${warnings.length ? ` (${warnings.length} warning(s))` : ''}`,
        ),
      );
    }
  }
  return failed
    ? { success: false, message: `${failed} of ${files.length} org config(s) failed validation` }
    : { success: true, message: `${files.length} org config(s) valid` };
};

/** `org inbox <name> --json '{"from":"orgA:role","subject":"...","body":"..."}' [--to role]`
 *  (or `--from/--subject/--body`) `[--format json]`.
 *  Inbound entrypoint for cross-org/remote delivery — orgrt/remote.ts's deliverRemote()
 *  shells out to exactly this command over SSH, and mono-agent replies through it.
 *
 *  Live path (M3): POST to the hosting daemon's /api/xdeliver with the OPERATOR
 *  credential (readOperatorCredential), which lets the daemon trust `from` as
 *  given — the sender org need not be registered (`workflow`, an automation
 *  role). Without an operator credential it presents the sender org's own
 *  broker credential, if that org is registered. Offline path: spool into
 *  inbox.jsonl, drained into the role's mailbox on the org's next start.
 *
 *  `--format json` prints `{"v":1,"org","to","from","delivery":"live"|"queued",
 *  "receipt","messageId"}`. Exit 0 for live and queued; non-zero only for
 *  invalid input or an unknown org. */
export const inboxAction = async (ctx: CommandContext, name: string): Promise<CommandResult> => {
  const json = orgJson(ctx);
  // JSON mode keeps stdout to the single payload — diagnostics go to stderr.
  const note = (text: string): void => {
    if (json) process.stderr.write(`${text}\n`);
    else log(text);
  };
  const fail = (message: string): CommandResult => {
    if (json) process.stdout.write(`${JSON.stringify({ v: 1, org: name, error: message })}\n`);
    else log(output.error(message));
    return { success: false, message };
  };

  let payload: { from?: unknown; subject?: unknown; body?: unknown } = {};
  const rawJson = ctx.flags.json;
  if (typeof rawJson === 'string') {
    try {
      payload = JSON.parse(rawJson) as typeof payload;
    } catch {
      return fail('org inbox: --json is not valid JSON');
    }
  } else {
    payload = { from: ctx.flags.from, subject: ctx.flags.subject, body: ctx.flags.body };
  }
  const from = typeof payload.from === 'string' ? payload.from.trim() : '';
  const subject = typeof payload.subject === 'string' ? payload.subject : '';
  const body = typeof payload.body === 'string' ? payload.body : '';
  if (!from || !body)
    return fail('org inbox: payload requires "from" and "body" (via --json or --from/--body)');
  if (!/^[^\s:]{1,128}(:[^\s:]{1,128})?$/.test(from))
    return fail(`org inbox: invalid sender "${from}" — use "<org>:<role>" or "<role>"`);

  const { lookupOrg, normalizeCredential, readOperatorCredential } = await import(
    '../orgrt/broker.js'
  );
  const remote = lookupOrg(name);
  const defPath = join(ctx.cwd, ORG_DIR, `${name}.json`);
  if (!remote && !existsSync(defPath)) return fail(`Org not found: ${name}`);

  // Target role: explicit --to, else the org's coordinator (reports_to == null),
  // else the first role — matching where a role-less cross-org message should land.
  let toRole = typeof ctx.flags.to === 'string' ? ctx.flags.to : '';
  if (toRole && !/^[a-z0-9][a-z0-9_-]*$/i.test(toRole)) return fail(`Invalid role id: ${toRole}`);
  if (!toRole) {
    if (!existsSync(defPath))
      return fail(`Org "${name}" config is not in this project — pass --to <role>.`);
    try {
      const def = JSON.parse(readFileSync(defPath, 'utf8')) as {
        roles?: { id?: string; reports_to?: string | null }[];
      };
      const roles = Array.isArray(def.roles) ? def.roles : [];
      toRole = roles.find((r) => r.reports_to == null)?.id ?? roles[0]?.id ?? '';
    } catch (err) {
      return fail(
        `Could not read org config for ${name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!toRole) return fail(`Org "${name}" has no roles to deliver to — pass --to <role>.`);
  }

  const { newMessageId, queueMessage } = await import('../orgrt/inbox.js');
  const messageId = newMessageId();
  const to = `${name}:${toRole}`;
  const done = (delivery: 'live' | 'queued', receipt: string): CommandResult => {
    if (json) return printOrgJson({ v: 1, org: name, to, from, delivery, receipt, messageId });
    log(output.success(receipt));
    return { success: true, message: receipt };
  };

  // Live path: a hosting daemon registered this org with the broker.
  if (remote) {
    const [fromOrg, fromRole] = from.includes(':') ? from.split(':', 2) : ['external', from];
    const operatorCred = readOperatorCredential(name);
    const agentCred = normalizeCredential(remote.credential);
    const cred = operatorCred ?? agentCred;
    const fromCredential = operatorCred ? undefined : lookupOrg(fromOrg)?.credential;
    try {
      const res = await fetch(`${remote.url}/api/xdeliver`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(cred ? { 'x-monomind-cred': cred } : {}),
        },
        body: JSON.stringify({
          fromOrg,
          fromRole,
          ...(fromCredential ? { fromCredential } : {}),
          toOrg: name,
          toRole,
          subject,
          body,
          messageId,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        receipt?: string;
        error?: string;
      };
      if (res.ok && data.ok) {
        const receipt = data.receipt ?? `delivered to ${to}`;
        // The daemon itself may have queued it (role starting, org waking).
        return done(/^queued/.test(receipt) ? 'queued' : 'live', receipt);
      }
      note(
        output.warning(
          `Live delivery rejected (${data.error ?? res.status}) — falling back to offline queue.`,
        ),
      );
    } catch (err) {
      note(
        output.warning(
          `Hosting daemon unreachable (${err instanceof Error ? err.message : 'error'}) — falling back to offline queue.`,
        ),
      );
    }
  }

  // Offline path: spool; drained into the role's mailbox when the org next starts.
  const queued = queueMessage(ctx.cwd, name, {
    fromQualified: from,
    toRole,
    subject,
    body,
    ts: Date.now(),
    messageId,
  });
  if (!queued) {
    const message = `Could not queue the message for ${to} (disk full or permissions).`;
    if (json) process.stdout.write(`${JSON.stringify({ v: 1, org: name, error: message })}\n`);
    else log(output.error(message));
    return { success: false, message: 'queueing failed' };
  }
  return done('queued', `queued for ${to} (delivered when the org next runs)`);
};

/** `org create <name> --template <t> [--goal g] [--schedule s]` — scaffold a config from a template. */
export const createAction = async (ctx: CommandContext, name: string): Promise<CommandResult> => {
  const templateName = typeof ctx.flags.template === 'string' ? ctx.flags.template : '';
  if (!templateName) {
    log(output.info(`Available templates: ${Object.keys(ORG_TEMPLATES).join(', ')}`));
    return {
      success: false,
      message:
        'usage: monomind org create <name> --template <template> [--goal "..."] [--schedule 30m]',
    };
  }
  const def = buildFromTemplate(
    templateName,
    name,
    typeof ctx.flags.goal === 'string' ? ctx.flags.goal : undefined,
  );
  if (!def) {
    log(
      output.error(
        `Unknown template "${templateName}" — available: ${Object.keys(ORG_TEMPLATES).join(', ')}`,
      ),
    );
    return { success: false, message: 'unknown template' };
  }
  if (typeof ctx.flags.schedule === 'string') def.schedule = ctx.flags.schedule;
  const file = join(ctx.cwd, ORG_DIR, `${name}.json`);
  if (existsSync(file) && ctx.flags.force !== true) {
    log(output.error(`Org "${name}" already exists — pass --force to overwrite.`));
    return { success: false, message: 'org exists' };
  }
  OrgDefSchema.parse(def); // templates must always produce a runnable config

  // Per-role model — the single most consequential setting the template picked on
  // the user's behalf. Mirror resolveModel() (same helper `org run`'s cost estimate
  // uses) so a role relying on its runtime/vendor default isn't mislabeled here.
  const modelRows = def.roles.map((r) => {
    const explicit = r.adapter_config?.model;
    return {
      id: r.id,
      model: String(explicit ?? resolveModel(r, r.runtime ?? def.runtime, r.provider?.vendor)),
      explicit: !!explicit,
    };
  });
  const printModels = (): void => {
    log(output.bold('  Models:'));
    for (const r of modelRows) {
      log(`    ${r.id.padEnd(20)} ${r.model}${r.explicit ? '' : '  (default)'}`);
    }
  };

  if (ctx.interactive && ctx.flags.yes !== true) {
    log(
      output.bold(
        `\nAbout to create org "${name}" from template "${templateName}" (${def.roles.length} roles):`,
      ),
    );
    printModels();
    const { confirm } = await import('../prompt.js');
    const proceed = await confirm({ message: 'Create this org?', default: true });
    if (!proceed) {
      log(
        output.info(
          'Cancelled — no file written. Adjust --template/--goal, or edit the template, then retry (pass --yes to skip this prompt).',
        ),
      );
      return { success: false, message: 'cancelled by user' };
    }
  }

  const { mkdirSync } = await import('node:fs');
  mkdirSync(join(ctx.cwd, ORG_DIR), { recursive: true });
  writeFileSync(file, `${JSON.stringify(def, null, 2)}\n`, 'utf8');
  log(
    output.success(
      `Org "${name}" created from template "${templateName}" (${def.roles.length} roles).`,
    ),
  );
  log(
    output.info(
      `  Budget: ${def.run_config.budget_tokens} tokens · Turn limit: ${def.run_config.max_turns_per_message} per message (effectively unlimited by default — set run_config.max_turns_per_message, or a role's own max_turns_per_message, to cap it).`,
    ),
  );
  if (!ctx.interactive || ctx.flags.yes === true) printModels();
  log(output.info(`  Edit the goal/roles in ${file}, then: monomind org run ${name}`));
  return { success: true };
};

/** `org replay <org> <run-id>` — time-travel debugging: re-emit a past run's bus
 *  events into a fresh replay run for inspection. This is event-log replay only —
 *  it does not restart agent execution or restore live sessions. To actually
 *  resume an org's execution from where it left off, use `org run --resume`. */
export const replayAction = async (ctx: CommandContext, name: string): Promise<CommandResult> => {
  const run = ctx.args[1];
  if (!run) {
    return { success: false, message: 'usage: org replay <org> <run-id>' };
  }

  const runDir = join(ctx.cwd, ORG_DIR, name, run);
  if (!existsSync(runDir)) {
    return { success: false, message: `run ${run} not found for org ${name}` };
  }

  const busFile = join(runDir, 'bus.jsonl');
  if (!existsSync(busFile)) {
    return { success: false, message: `no bus events found for run ${run}` };
  }

  log(output.info(`Replaying org ${name} events from checkpoint ${run}...`));

  // Create daemon and replay the bus events for debugging/inspection
  const { OrgDaemon } = await import('../orgrt/daemon.js');
  const daemon = new OrgDaemon(ctx.cwd, { forward: false });

  const resumed = await daemon.replayFrom(name, run);
  if (!resumed) {
    return {
      success: false,
      message: `replay failed - check bus.jsonl and org config for ${name} are valid`,
    };
  }

  log(output.success(`Org ${name} events replayed from ${run} as run ${resumed.run}`));
  log(output.info(`Use: monomind org logs ${name} --run ${resumed.run} to inspect events.`));
  log(
    output.info(
      `This is debug replay only — it does not restart agent execution. To resume live execution, use: monomind org run ${name} --resume`,
    ),
  );

  return { success: true, message: `replayed events from checkpoint ${run} as ${resumed.run}` };
};

/** PID of a live `org serve` daemon for this project, or null. Mirrors
 *  runAction's `liveServeDaemonPid` (commands/org.ts, ~line 107) — duplicated
 *  rather than imported because that function isn't exported there and this
 *  file is scoped to not touch org.ts. Liveness is confirmed against the pid
 *  itself, not just heartbeat-file presence, since a SIGKILLed daemon leaves
 *  a stale heartbeat behind; a stamp older than a few beats (daemon beats
 *  every 30s) means it's gone or wedged. */
function liveServeDaemonPid(cwd: string): number | null {
  try {
    const hb = JSON.parse(readFileSync(join(cwd, '.monomind', 'serve-heartbeat.json'), 'utf8')) as {
      pid?: number;
      updatedAt?: string;
    };
    if (typeof hb.pid !== 'number' || hb.pid === process.pid) return null;
    const age = Date.now() - Date.parse(hb.updatedAt ?? '');
    if (!Number.isFinite(age) || age > 3 * 60_000) return null;
    process.kill(hb.pid, 0); // throws if the process is gone
    return hb.pid;
  } catch {
    return null;
  }
}

/** `org resume-from <org>` — resume live execution from the org's persisted
 *  checkpoint (runtime.json): restores mailbox queues, policy/token counters,
 *  and session state, subject to checkpoint TTL and checksum validation. Unlike
 *  `replay`, this restarts real agent execution via `startOrg(..., { resume: true })`. */
export const resumeFromAction = async (
  ctx: CommandContext,
  name: string,
): Promise<CommandResult> => {
  // A live `org serve` daemon (or another `org run`) may already own this
  // org's execution. Building a fresh in-process OrgDaemon and resuming
  // unconditionally — as this action used to — puts two processes on one
  // runtime.json/broker lease and spawns a second set of role sessions
  // against the same shared git workspace, since the fresh daemon's
  // duplicate-start guard (`this.orgs.has(name)`) is scoped to its own empty
  // in-memory map and never sees the other process. `runAction` (org.ts)
  // already guards this by handing the request to the live daemon via a
  // runfile instead of racing it — but that runfile mechanism only carries a
  // plain "start" request (pollRunfiles/org.ts calls `daemon.startOrg(name,
  // task)` with no resume option), so it can't be reused for a resume
  // request without also touching org.ts. Refuse instead of racing the live
  // daemon.
  const serveOwner = liveServeDaemonPid(ctx.cwd);
  if (serveOwner != null) {
    log(
      output.error(
        `org ${name}: a live serve daemon (pid ${serveOwner}) already owns this project's orgs — refusing to start a second execution here.`,
      ),
    );
    log(
      output.info(
        `Check it against the live daemon instead: monomind org status ${name} / org decisions ${name} / org gates ${name}. ` +
          `To resume from checkpoint yourself, stop the live daemon first (monomind org stop) or let it pick the org back up on its own schedule.`,
      ),
    );
    return {
      success: false,
      message: `org ${name}: already owned by live serve daemon (pid ${serveOwner}) — refused to avoid a duplicate execution`,
    };
  }

  log(output.info(`Resuming org ${name} from checkpoint...`));

  const { OrgDaemon } = await import('../orgrt/daemon.js');
  const daemon = new OrgDaemon(ctx.cwd, { forward: false });

  const resumed = await daemon.resumeOrg(name);
  if (!resumed) {
    return {
      success: false,
      message: `resume failed for ${name} - check runtime.json checkpoint is present, unexpired, and valid`,
    };
  }

  log(output.success(`Org ${name} resumed - ${resumed.agents.size} role(s) restored`));
  log(output.info(`Stop with: monomind org stop ${name}`));

  return { success: true, message: `resumed ${name} - ${resumed.agents.size} role(s) restored` };
};

/** `org branch <org> <run-id> <label> [--format json]` — snapshot a run's event
 *  log for replay. This is NOT an executable what-if scenario: it copies
 *  bus.jsonl into a new run directory tagged with a `.branch-source` marker so
 *  it can be inspected or replayed later; it does not fork or re-run agent
 *  execution. Delegates to the shared, atomic (tmp+rename) implementation in
 *  checkpoint-ops.ts.
 *
 *  `<label>` is a note recorded in `.branch-source`, not the new run's name —
 *  the run id is generated. `--format json` reports that generated id as a
 *  field so a scripted caller can feed it to `org replay` without scraping the
 *  human-readable line (#292). */
export const branchAction = async (ctx: CommandContext, name: string): Promise<CommandResult> => {
  const run = ctx.args[1];
  const label = ctx.args[2];
  if (!run || !label) {
    return { success: false, message: 'usage: org branch <org> <run-id> <label>' };
  }

  const result = branchCheckpoint(ctx.cwd, name, run, label);
  if (!result.ok) {
    return { success: false, message: result.error };
  }

  if (orgJson(ctx))
    return printOrgJson({ v: 1, org: name, run: result.branchRun, from: run, label });

  log(output.success(`Snapshotted ${run} as run ${result.branchRun} (label: "${label}")`));
  log(output.info(`Replay it with: monomind org replay ${name} ${result.branchRun}`));
  return { success: true, message: `snapshotted ${run} as run ${result.branchRun}` };
};

/** `org decisions <org> [--run id]` — show Rifft-style decision traces */
export const decisionsAction = async (
  ctx: CommandContext,
  name: string,
): Promise<CommandResult> => {
  const run = resolveRun(ctx.cwd, name, ctx.flags.run);
  if (!run) {
    return { success: false, message: `no runs found for org ${name}` };
  }

  const events = readRunEvents(ctx.cwd, name, run);
  if (!events.length) {
    return { success: false, message: `run ${run} has no recorded events` };
  }

  // Filter decision trace events
  const decisionEvents = events.filter(
    (e) =>
      e.type === 'audit' && e.reason === 'decision-trace' && e.data && typeof e.data === 'object',
  );

  if (orgJson(ctx)) {
    return printOrgJson({
      v: 1,
      org: name,
      run,
      items: decisionEvents.map((e) => ({
        ts: e.ts,
        role: e.from ?? 'system',
        ...(e.data as Record<string, unknown>),
      })),
    });
  }

  if (!decisionEvents.length) {
    log(output.info(`No decision traces found in ${run}`));
    return { success: true };
  }

  log(output.info(`Decision traces for ${name} / ${run} (${decisionEvents.length} decisions):`));
  log(output.info('┌──────────────────┬─────────────┬────────────────────────────────────────┐'));
  log(output.info('│ Role             │ Type        │ Context                                │'));
  log(output.info('├──────────────────┼─────────────┼────────────────────────────────────────┤'));

  for (const e of decisionEvents) {
    const role = e.from ?? 'system';
    const type = (e.data as { decisionType?: string }).decisionType ?? 'unknown';
    const context = (e.data as { context?: string }).context ?? '-';
    log(output.info(`│ ${role.padEnd(16)} │ ${type.padEnd(11)} │ ${context.padEnd(38)} │`));
  }

  log(output.info('└──────────────────┴─────────────┴────────────────────────────────────────┘'));

  return { success: true, message: `${decisionEvents.length} decision traces` };
};

// ── Decision gates ──────────────────────────────────────────────────────

function readGatesFile(cwd: string, org: string): { gates: DecisionGate[] } {
  try {
    return JSON.parse(readFileSync(join(cwd, ORG_DIR, org, 'gates.json'), 'utf8'));
  } catch {
    return { gates: [] };
  }
}

/** Read gates.json for a write path. A MISSING file legitimately means "no gates" → [].
 *  Any other failure (unreadable, malformed — e.g. a partial daemon write) THROWS:
 *  gateResolveAction rewrites this file from what this returns, so silently coercing a
 *  failed read to [] would surface a real I/O error as "gate not found" and a
 *  subsequent write would replace every recorded gate with just this one. */
function readGatesFileStrict(cwd: string, org: string): { gates: DecisionGate[] } {
  const path = join(cwd, ORG_DIR, org, 'gates.json');
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { gates: [] };
    throw new Error(`cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  let parsed: { gates?: DecisionGate[] };
  try {
    parsed = JSON.parse(raw) as { gates?: DecisionGate[] };
  } catch (err) {
    throw new Error(
      `${path} is not valid JSON (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (parsed?.gates === undefined || parsed.gates === null) return { gates: [] };
  if (!Array.isArray(parsed.gates)) throw new Error(`${path}: "gates" is not an array`);
  return { gates: parsed.gates };
}

export const gatesAction = async (ctx: CommandContext, name: string): Promise<CommandResult> => {
  const data = readGatesFile(ctx.cwd, name);
  const showAll = ctx.flags.all === true;
  const gates = showAll ? data.gates : data.gates.filter((g) => g.status === 'pending');

  if (orgJson(ctx)) return printOrgJson({ v: 1, org: name, items: gates });

  if (!gates.length) {
    log(
      output.info(
        showAll
          ? `No gates for org "${name}"`
          : `No pending gates for org "${name}" (use --all to include resolved)`,
      ),
    );
    return { success: true };
  }

  log(output.info(`${showAll ? 'All' : 'Pending'} gates for org "${name}" (${gates.length}):\n`));
  for (const g of gates) {
    const status =
      g.status === 'pending'
        ? '⏳ pending'
        : g.status === 'approved'
          ? '✅ approved'
          : '❌ rejected';
    log(output.info(`  ${g.id}  ${status}  role:${g.roleId}`));
    log(output.info(`    name: ${g.name}`));
    log(output.info(`    desc: ${g.description}`));
    if (g.resolution) log(output.info(`    resolution: ${g.resolution}`));
    log('');
  }
  return { success: true, message: `${gates.length} gate(s)` };
};

export const gateResolveAction = async (
  ctx: CommandContext,
  name: string,
  approved: boolean,
): Promise<CommandResult> => {
  const gateId = ctx.args[1];
  const resolution = ctx.args.slice(2).join(' ') || undefined;
  if (!gateId)
    return {
      success: false,
      message: `usage: monomind org gate-${approved ? 'approve' : 'reject'} ${name} <gate-id> [resolution]`,
    };

  let data: { gates: DecisionGate[] };
  try {
    data = readGatesFileStrict(ctx.cwd, name);
  } catch (err) {
    log(
      output.error(
        `Cannot read gates for org ${name}: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
    return { success: false, message: 'gates.json unreadable — gate not resolved' };
  }
  const gate = data.gates.find((g) => g.id === gateId);
  if (!gate) return { success: false, message: `gate "${gateId}" not found for org "${name}"` };
  if (gate.status !== 'pending')
    return { success: false, message: `gate "${gateId}" already resolved (${gate.status})` };
  const byFlag = await resolverFlag(ctx);
  if (!byFlag.ok) return { success: false, message: byFlag.message };
  const resolvedBy = byFlag.by;

  // SEC: gate resolution is a human decision — operator credential only.
  const { lookupOrg, readOperatorCredential } = await import('../orgrt/broker.js');
  const remote = lookupOrg(name);
  if (remote) {
    const cred = readOperatorCredential(name);
    try {
      const res = await fetch(`${remote.url}/api/resolve-gate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(cred ? { 'x-monomind-cred': cred } : {}),
        },
        body: JSON.stringify({ org: name, gateId, approved, resolution, resolvedBy }),
        signal: AbortSignal.timeout(10_000),
      });
      const d = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (res.ok && d.ok) {
        if (orgJson(ctx))
          return printOrgJson({
            v: 1,
            org: name,
            gate_id: gateId,
            status: approved ? 'approved' : 'rejected',
            delivery: 'live',
            resolvedBy,
          });
        log(output.success(`Gate ${gateId} ${approved ? 'approved' : 'rejected'} (live).`));
        return { success: true, message: `gate ${approved ? 'approved' : 'rejected'}` };
      }
      log(
        output.warning(
          `Live resolution rejected (${d.error ?? res.status}) — falling back to offline queue.`,
        ),
      );
    } catch (err) {
      log(
        output.warning(
          `Hosting daemon unreachable (${err instanceof Error ? err.message : 'error'}) — falling back to offline queue.`,
        ),
      );
    }
  }

  // Offline path: no live daemon hosts this org (or the live call failed) —
  // resolve gates.json directly, same as resolveApproval's offline branch.
  // Re-read fresh (mirrors answerAction/resolveApproval) in case a live
  // daemon resolved this gate concurrently while the live call above was
  // in flight or timing out.
  const { writeGates } = await import('../orgrt/decisions.js');
  let fresh: { gates: DecisionGate[] };
  try {
    fresh = readGatesFileStrict(ctx.cwd, name);
  } catch (err) {
    log(
      output.error(
        `Refusing to rewrite gates.json — ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
    log(
      output.warning(
        `The gate was NOT resolved. Fix or restore ${join(ctx.cwd, ORG_DIR, name, 'gates.json')}, then retry.`,
      ),
    );
    return { success: false, message: 'gates.json unreadable — gate not resolved' };
  }
  const idx = fresh.gates.findIndex((g) => g.id === gateId);
  if (idx === -1)
    return { success: false, message: `gate "${gateId}" not found for org "${name}"` };
  if (fresh.gates[idx].status !== 'pending') {
    return {
      success: false,
      message: `gate "${gateId}" already resolved (${fresh.gates[idx].status})`,
    };
  }
  fresh.gates[idx] = {
    ...fresh.gates[idx],
    status: approved ? 'approved' : 'rejected',
    resolvedAt: Date.now(),
    resolvedBy,
    resolution,
  };
  writeGates(ctx.cwd, name, fresh);

  if (orgJson(ctx))
    return printOrgJson({
      v: 1,
      org: name,
      gate_id: gateId,
      status: approved ? 'approved' : 'rejected',
      delivery: 'recorded',
      resolvedBy,
    });
  log(
    output.success(
      `Gate ${gateId} ${approved ? 'approved' : 'rejected'} — ${name} picks it up on its next cycle.`,
    ),
  );
  return { success: true, message: `gate ${approved ? 'approved' : 'rejected'} (queued)` };
};
