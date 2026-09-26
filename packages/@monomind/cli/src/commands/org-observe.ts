// packages/@monomind/cli/src/commands/org-observe.ts
// Read-side org subcommands (logs / report) + template scaffolding (create).
// Kept out of org.ts to respect the 500-line file ceiling.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { branchCheckpoint } from '../orgrt/checkpoint-ops.js';
import { readRunEvents } from '../orgrt/reporting.js';
import { type DecisionGate, ORG_DIR } from '../orgrt/types.js';
import { output } from '../output.js';
import type { CommandContext, CommandResult } from '../types.js';
import { orgJson, printOrgJson, resolveRun, resolverFlag } from './org-observe-shared.js';

export {
  approvalsAction,
  approveAction,
  denyAction,
} from './org-observe-approvals.js';
export {
  createAction,
  validateAction,
} from './org-observe-config.js';
export { inboxAction } from './org-observe-inbox.js';
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
