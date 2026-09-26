// packages/@monomind/cli/src/commands/org-run.ts
//
// `monomind org run` — start an org as a foreground daemon.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveOrgDefBlueprints } from '../catalog/blueprints.js';
import { approvalPendingNotice, parseAutoApproveFlag } from '../orgrt/approvals.js';
import { resolveRoleCostTier } from '../orgrt/cost-tier.js';
import { OrgDaemon } from '../orgrt/daemon.js';
import { readRunEvents } from '../orgrt/reporting.js';
import { startOrgServer } from '../orgrt/server.js';
import { resolveModel } from '../orgrt/session.js';
import { ORG_DIR, OrgDefSchema } from '../orgrt/types.js';
import { output } from '../output.js';
import { MODEL_PRICING } from '../pricing/model-pricing.js';
import type { CommandContext, CommandResult } from '../types.js';
import {
  clearReloadfile,
  clearStopfile,
  listOrgConfigFiles,
  liveServeDaemonPid,
  validateOrgName,
} from './org-control.js';
import {
  type RunTerminalState,
  runOutcomeResult,
  runtimeState,
  waitForRunEnd,
} from './org-poll.js';
import { type RunEndInput, runEndLine } from './org-run-end.js';

const log = (text: string): void => {
  console.log(text);
};

export const runAction = async (ctx: CommandContext): Promise<CommandResult> => {
  // Org runs skip local embeddings entirely — on some machines
  // @huggingface/transformers' native ONNX runtime crashes the whole
  // process (a libc++abi terminate, not a catchable JS error) the moment
  // any memory/KG lookup tries to load its model. A crashed unattended org
  // run is much worse than one that falls back to keyword-only memory
  // search — see the matching guards in memory-bridge.ts/embedding-operations.ts.
  // The embedding-model crash above has a sibling: loadReranker() in
  // memory-bridge.ts loads a SEPARATE cross-encoder model
  // (cross-encoder/ettin-reranker-32m-v1, its own tokenizer architecture)
  // for search-result reranking, independent of the embedder guard above —
  // reranking runs on (query, passage) text pairs directly, so it can
  // still fire and hit the same native crash even with embeddings off.
  // disableLocalModels() turns off both, for THIS process only. It used to be
  // MONOMIND_NO_LOCAL_EMBEDDINGS=1 / MONOMIND_RERANKER=0 on process.env, which
  // every role's CLI and every command a role ran inherited — so a role's own
  // `monomind memory search` silently fell back to keyword-only (#249).
  const { disableLocalModels } = await import('../memory/memory-bridge.js');
  disableLocalModels();
  if (!ctx.args[0])
    return { success: false, message: 'org name required: monomind org run <name> [--task "..."]' };
  const validated = validateOrgName(ctx.args[0]);
  if (!validated.ok) return validated.result;
  const name = validated.name;
  // A repeated --task flag is promoted to an array by the parser (deliberate,
  // documented behavior elsewhere — repeats never silently drop a value); a
  // plain `as string` cast would let that array flow straight into the org's
  // goal and get stringified as "a,b" with no warning. Checked before any
  // side effects (starting the xdeliver listener) run.
  const taskFlag = ctx.flags.task;
  if (Array.isArray(taskFlag))
    return { success: false, message: '--task was passed more than once — pass it exactly once' };
  const autoApprove = parseAutoApproveFlag(ctx.flags.autoApprove);
  if ('error' in autoApprove) return { success: false, message: autoApprove.error };
  // Fail before any side effects (inbox server) when the org doesn't exist.
  const orgsDir = join(ctx.cwd, ORG_DIR);
  if (!existsSync(join(orgsDir, `${name}.json`))) {
    const known = existsSync(orgsDir)
      ? listOrgConfigFiles(orgsDir).map((f) => f.replace(/\.json$/, ''))
      : [];
    log(
      output.error(
        `Org not found: ${name}${known.length ? ` — available: ${known.join(', ')}` : ' — create one with /mastermind:createorg'}`,
      ),
    );
    return { success: false, message: 'org not found' };
  }
  if (ctx.flags.dryRun === true) {
    // Validate + preview each role's actual briefing without spawning sessions.
    try {
      const parsedDef = OrgDefSchema.parse(
        JSON.parse(readFileSync(join(orgsDir, `${name}.json`), 'utf8')),
      );
      const bp = resolveOrgDefBlueprints(parsedDef, ctx.cwd);
      for (const n of bp.notes) log(output.info(n));
      if (bp.errors.length) throw new Error(bp.errors.join('; '));
      const def = bp.def;
      const { buildRolePrompt, resolveRoleExtraGuidance } = await import('../orgrt/session.js');
      const { agentRoles, endpointBriefingLines } = await import('../orgrt/endpoint-roles.js');
      const { expandRolePromptVars, promptVarsFor } = await import('../orgrt/prompt-vars.js');
      const roster = def.roles.map((r) => r.id);
      // M2: endpoint roles get no session, so no briefing and no budget share.
      const sessionRoles = agentRoles(def.roles);
      const bossId = (
        sessionRoles.find((r) => r.type === 'boss' || r.reports_to === null) ?? sessionRoles[0]
      )?.id;
      const perRole = Math.floor(
        (def.run_config.budget_tokens ?? 1_000_000) / Math.max(1, sessionRoles.length),
      );
      // Same KG entity glossary the live daemon injects — the preview must
      // match what sessions actually receive.
      const glossary = await (async () => {
        try {
          const kg = await import('../memory/memory-kg.js');
          const { orgKgScope } = await import('../orgrt/org-memory.js');
          return await kg.kgGlossary({
            dbPath: join(process.cwd(), '.monomind', 'org-memory'),
            scope: orgKgScope(name),
          });
        } catch {
          return [];
        }
      })();
      log(
        output.info(
          `DRY RUN — org ${name}: ${sessionRoles.length} roles, ${perRole} tokens each, goal: ${taskFlag ?? def.goal}`,
        ),
      );
      for (const role of sessionRoles) {
        log(
          output.info(
            `\n─── ${role.id} (${role.title || role.type})${role.adapter_config?.model ? ` [${role.adapter_config.model}]` : ''} ───`,
          ),
        );
        log(
          buildRolePrompt(
            // Same org root the live daemon uses (new OrgDaemon(ctx.cwd)).
            expandRolePromptVars(role, promptVarsFor(ctx.cwd)),
            { name: def.name, goal: (taskFlag as string | undefined) ?? def.goal },
            roster,
            glossary,
            resolveRoleExtraGuidance(role, ctx.cwd),
            role.id === bossId ? endpointBriefingLines(def) : undefined,
          ),
        );
      }
      return { success: true, message: 'dry run complete — no sessions started' };
    } catch (err) {
      log(output.error(`Config invalid: ${err instanceof Error ? err.message : String(err)}`));
      return { success: false, message: 'invalid org config' };
    }
  }
  // A live `org serve` daemon already owns this project's orgs. Starting our
  // own here would put two processes on one runtime.json and one broker lease,
  // so hand the request to the daemon via its runfile instead of racing it.
  const serveOwner = liveServeDaemonPid(ctx.cwd);
  if (serveOwner != null) {
    // The runfile carries only the task; the serve daemon would drop the list.
    if (autoApprove.tools.length)
      return {
        success: false,
        message: `--auto-approve cannot be handed to the running "org serve" daemon (pid ${serveOwner}) — set the roles' policy.autoApproveTools instead`,
      };
    mkdirSync(join(orgsDir, name), { recursive: true });
    // The task rides along in the runfile. Dropping it here would have made
    // `org run <name> --task "..."` silently start a generic cycle — the flag
    // accepted, the instruction discarded.
    const runfile = join(orgsDir, name, 'run');
    writeFileSync(runfile, JSON.stringify({ ts: Date.now(), task: taskFlag ?? null }), 'utf8');
    // Ack: the serve daemon's runfile poll consumes (deletes) the file within
    // one tick (~2s). The liveness check above is racy — a pid can die or be
    // recycled between the check and the poll, leaving a runfile nobody reads
    // while we report success. Verify consumption; on timeout, retract the
    // runfile and fail loudly instead of losing the run.
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && existsSync(runfile)) {
      await new Promise((r) => setTimeout(r, 500));
    }
    if (existsSync(runfile)) {
      rmSync(runfile, { force: true });
      log(
        output.error(
          `org ${name}: serve daemon (pid ${serveOwner}) did not pick up the run within 15s — it is dead or wedged.`,
        ),
      );
      log(
        output.info(
          `Remove the stale heartbeat (.monomind/serve-heartbeat.json) and retry, or start a fresh daemon with: monomind org serve`,
        ),
      );
      return { success: false, message: 'serve daemon did not acknowledge the run request' };
    }
    log(
      output.info(
        `org ${name}: start requested from the serve daemon (pid ${serveOwner}) — acknowledged`,
      ),
    );
    log(output.dim(`  watch it with: monomind org logs ${name} --follow`));
    return { success: true, message: 'start requested' };
  }

  const crossProcess = ctx.flags.crossProcess !== false;

  // P1-1: v1 deprecation warning. Detect v1-shaped configs and warn.
  // Gate on MONOMIND_V1_LEGACY=off to refuse v1 orgs entirely (patch-versioning-
  // compliant mechanism — no minor bump needed).
  const V1_ORG_KEYS = [
    'topology',
    'consensus',
    'strategy',
    'board_id',
    'todo_col_id',
    'doing_col_id',
    'done_col_id',
    'loop',
  ];
  try {
    const rawCfg = JSON.parse(readFileSync(join(orgsDir, `${name}.json`), 'utf8')) as Record<
      string,
      unknown
    >;
    const isV1 = V1_ORG_KEYS.some((k) => k in rawCfg);
    if (isV1) {
      const v1Legacy = process.env.MONOMIND_V1_LEGACY;
      if (v1Legacy === 'off') {
        log(output.error(`Org "${name}" uses the v1 config format, but MONOMIND_V1_LEGACY=off.`));
        log(
          output.info(
            `Run "monomind org migrate ${name}" to upgrade to v2, or unset MONOMIND_V1_LEGACY to proceed anyway.`,
          ),
        );
        return { success: false, message: 'v1 org blocked by MONOMIND_V1_LEGACY=off' };
      }
      log(
        output.warning(
          `Org "${name}" uses the v1 config format (deprecated). It will be auto-migrated in-memory.`,
        ),
      );
      log(
        output.dim(
          `  To silence: run "monomind org migrate ${name}". To block v1 orgs: set MONOMIND_V1_LEGACY=off.`,
        ),
      );
    }
  } catch {
    /* config parse errors surface below in cost estimate or daemon.startOrg */
  }

  // P0-17: Upfront cost estimate. `org run` and `/mastermind:autodev` spend real
  // provider tokens. Print an estimate before sessions start; honor --budget-usd
  // as a hard stop and --yes to skip the confirmation prompt. Rates are defaults
  // (per 1M tokens, blended estimate, Aug 2026); override via the model id.
  //
  // No provider Usage API is queried (that needs Admin/Org API credentials most
  // users won't have configured) — rates are derived from the canonical
  // MODEL_PRICING table (src/pricing/model-pricing.ts), using each model's
  // output-token price as the blended per-1M estimate (output tokens dominate
  // role-turn cost). Models not yet tracked in that table (third-party/non-
  // Anthropic providers) fall back to the manually maintained EXTRA table
  // below. A user-editable ~/.monomind/rates.json override, when present,
  // takes precedence over both. Either way this is static data, not a live
  // query, so a "stale rates" warning is always shown to make that
  // limitation visible rather than implying live pricing.
  const DERIVED_RATE_PER_1M: Record<string, number> = Object.fromEntries(
    Object.entries(MODEL_PRICING).map(([model, price]) => [model, price.out * 1_000_000]),
  );
  // Models absent from MODEL_PRICING (not yet in the canonical pricing table).
  const EXTRA_MODEL_RATE_PER_1M: Record<string, number> = {
    'gpt-4': 10,
    'glm-5.2': 2,
    'glm-4': 2,
    'kimi-latest': 3,
    'kimi-k2': 3,
    'kimi-code/k3': 3,
    'kimi-code/k3-256k': 3,
    'gemini-3.1-pro': 8,
    'gemini-3.6-flash-high': 1,
    'gpt-5.6-terra': 10,
    'gpt-5.5': 10,
  };
  const MODEL_RATE_PER_1M: Record<string, number> = {
    ...EXTRA_MODEL_RATE_PER_1M,
    ...DERIVED_RATE_PER_1M,
  };
  const DEFAULT_RATE_PER_1M = 10;
  const AVG_TOKENS_PER_TURN = 2000;
  const budgetUsd = ctx.flags.budgetUsd as number | undefined;
  const skipConfirm = ctx.flags.yes === true;

  // User-editable rate overrides: ~/.monomind/rates.json, e.g.
  //   { "claude-opus-5": 90, "my-custom-model": 5 }
  const ratesPath = join(homedir(), '.monomind', 'rates.json');
  const userRates: Record<string, number> = {};
  let ratesFileUsed = false;
  try {
    const parsed = JSON.parse(readFileSync(ratesPath, 'utf8'));
    if (parsed && typeof parsed === 'object') {
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'number') userRates[k] = v;
      }
      ratesFileUsed = Object.keys(userRates).length > 0;
    }
  } catch {
    /* no rates.json (or invalid) — hardcoded defaults only */
  }

  try {
    const def = OrgDefSchema.parse(JSON.parse(readFileSync(join(orgsDir, `${name}.json`), 'utf8')));
    const defaultMaxTurns = def.run_config.max_turns_per_message ?? 30;
    // Estimate against a realistic planning ceiling, NOT the runtime limit —
    // the schema default is effectively unlimited (DEFAULT_MAX_TURNS_PER_MESSAGE),
    // which would balloon the upfront figure into meaninglessness.
    const ESTIMATE_TURNS_CAP = 30;
    let _totalTokens = 0;
    const perRoleRows = def.roles.map((r) => {
      // Mirror the actual runtime's model resolution (session.ts resolveModel)
      // instead of a hardcoded 'claude-sonnet-5' fallback — otherwise every
      // role without an explicit adapter_config.model (kimicode, antigravity,
      // vercel roles relying on their runtime default) is mislabeled here.
      // ADR-O001 D8: fold the role's cost tier in, at the same precedence the
      // runtime uses (explicit model > tier > runtime/vendor default) — an
      // estimate that ignored the tier would quote the untiered price of a run
      // that is about to cost ~3x less.
      const model = String(
        r.adapter_config?.model ??
          resolveRoleCostTier({ role: r, def })?.model ??
          resolveModel(r, r.runtime ?? def.runtime, r.provider?.vendor),
      );
      const rate = userRates[model] ?? MODEL_RATE_PER_1M[model] ?? DEFAULT_RATE_PER_1M;
      const roleTurns = Math.min(r.max_turns_per_message ?? defaultMaxTurns, ESTIMATE_TURNS_CAP);
      const tokens = roleTurns * AVG_TOKENS_PER_TURN;
      _totalTokens += tokens;
      return { id: r.id, model, tokens, cost: (tokens * rate) / 1_000_000 };
    });
    const estimate = perRoleRows.reduce((s, r) => s + r.cost, 0);
    log(output.bold('\nCost estimate'));
    log(
      output.dim(
        `  (roles × max_turns × ~${AVG_TOKENS_PER_TURN} tokens/turn × model rate; estimated at ≤${ESTIMATE_TURNS_CAP} turns/message — the runtime default is effectively unlimited; ${ratesFileUsed ? `rates.json overrides + ` : ''}static defaults, will vary with real usage)`,
      ),
    );
    log(
      output.warning(
        `  ⚠ stale rates: no live provider pricing lookup — ${ratesFileUsed ? `using ~/.monomind/rates.json + ` : ''}hardcoded table (edit ~/.monomind/rates.json to override)`,
      ),
    );
    for (const r of perRoleRows) {
      log(`    ${r.id.padEnd(20)} ${r.model.padEnd(22)} ~$${r.cost.toFixed(2)}`);
    }
    log(`  ${output.bold('Total estimate:'.padEnd(28))} ~$${estimate.toFixed(2)}`);
    if (budgetUsd != null && estimate > budgetUsd) {
      log(
        output.error(
          `Estimate $${estimate.toFixed(2)} exceeds --budget-usd $${budgetUsd}. Aborting before any tokens are spent.`,
        ),
      );
      return { success: false, message: 'cost estimate exceeded --budget-usd' };
    }
    if (!skipConfirm && process.stdin.isTTY) {
      const { confirm } = await import('../prompt.js');
      const ok = await confirm({
        message: `Start ${def.roles.length}-role org? This will spend real provider tokens.`,
        default: true,
      });
      if (!ok) {
        log(output.dim('Aborted — no tokens spent.'));
        return { success: false, message: 'user declined cost-estimate prompt' };
      }
    }
  } catch (err) {
    // If the config can't be parsed here, daemon.startOrg below will surface a
    // proper error. Don't double-report — just skip the estimate.
    if (process.env.DEBUG || process.env.MONOMIND_DEBUG) {
      log(
        output.dim(`(cost estimate skipped: ${err instanceof Error ? err.message : String(err)})`),
      );
    }
  }

  const resumeFlag = ctx.flags.resume === true;
  const daemon = new OrgDaemon(ctx.cwd, { crossProcess });
  let srv: Awaited<ReturnType<typeof startOrgServer>> | undefined;
  if (crossProcess) {
    srv = await startOrgServer(daemon, 0);
    daemon.setInboxUrl(`http://127.0.0.1:${srv.port}`, srv.operatorCredential);
  }
  let running: Awaited<ReturnType<typeof daemon.startOrg>>;
  try {
    running = await daemon.startOrg(name, taskFlag as string | undefined, {
      resume: resumeFlag,
      autoApprove: autoApprove.tools,
    });
  } catch (err) {
    // Don't leave the inbox server holding the event loop open on a failed start.
    srv?.close();
    await daemon.stopAll().catch(() => {
      /* nothing started */
    });
    const detail = err instanceof Error ? err.message : String(err);
    const hint =
      err instanceof Error && err.name === 'ZodError'
        ? ` — run "monomind org validate ${name}" for details`
        : '';
    log(output.error(`Could not start org ${name}: ${detail}${hint}`));
    return { success: false, message: 'org start failed' };
  }
  log(
    output.info(
      `org ${name} running (${running.def.roles.length} agents, run ${running.run}) — Ctrl-C or "monomind org stop ${name}" to stop`,
    ),
  );
  // #345: a role waiting on a tool approval is otherwise silent in this log.
  running.bus.subscribe((e) => {
    const notice = approvalPendingNotice(name, e);
    if (notice) log(output.warning(notice));
  });
  // The run log's last line: outcome, wall time, total cost (every exit path
  // below, crash handlers included), so a detached run's log has an ending.
  const startedAt = Date.now();
  const printRunEnd = (final: RunTerminalState, how: Omit<RunEndInput, 'final' | 'events'>) => {
    try {
      const events = readRunEvents(ctx.cwd, name, running.run);
      const wallMs = Date.now() - startedAt;
      log(output.info(runEndLine({ name, run: running.run, wallMs, final, events, ...how })));
    } catch {
      /* best-effort — never mask the run's real exit */
    }
  };

  // #206 follow-up: without this, an uncaught error in this process left
  // runtime.json's status stuck at 'running' (finishStop never runs), and
  // runOutcomeResult's status === 'crashed' branch — the one meant to
  // surface *why* the run failed — could never actually fire for `org run`,
  // since nothing here ever wrote 'crashed'. Mirrors serveAction's
  // crashExit, but deliberately does NOT touch SIGINT/SIGTERM — those are
  // already handled by the wait loop below as a graceful stop, and
  // registering a second, competing handler here would race it.
  process.on('uncaughtException', (err) => {
    try {
      console.error('[org run] uncaughtException:', err);
    } catch {
      /* stderr gone */
    }
    const error = `uncaughtException: ${err instanceof Error ? err.message : String(err)}`;
    daemon.persistCrashStateAll(error);
    printRunEnd({ status: 'crashed', error }, {});
    process.exit(1);
  });
  process.on('unhandledRejection', (err) => {
    try {
      console.error('[org run] unhandledRejection:', err);
    } catch {
      /* stderr gone */
    }
    const error = `unhandledRejection: ${err instanceof Error ? err.message : String(err)}`;
    daemon.persistCrashStateAll(error);
    printRunEnd({ status: 'crashed', error }, {});
    process.exit(1);
  });

  // P1-12: Print the dashboard URL so CLI users know where to look.
  // The dashboard is normally spawned by a Claude Code SessionStart hook
  // (.claude/helpers/control-start.cjs) — but `org run` doesn't require
  // Claude Code, and even when the hook exists it only fires once at
  // session start, not per org run. If control.json is stale (points at a
  // dead pid, a server rooted in a different project, or one that no longer
  // accepts our dashboard-token — the exact case control-start.cjs's own
  // "already running" check now self-heals, see its staleAuth handling),
  // `org run` used to just print whatever URL was on file with zero
  // verification. Actively (re)run the same control-start.cjs the hook
  // uses, from this project's own .claude/helpers/ if it's been set up
  // (monomind init), so a stale/dead/mismatched dashboard gets healed on
  // every org run instead of silently trusting old state.
  const controlPath = join(ctx.cwd, '.monomind', 'control.json');
  const controlStartPath = join(ctx.cwd, '.claude', 'helpers', 'control-start.cjs');
  if (existsSync(controlStartPath)) {
    try {
      const { spawnSync } = await import('node:child_process');
      spawnSync(process.execPath, [controlStartPath], {
        cwd: ctx.cwd,
        env: { ...process.env, CLAUDE_PROJECT_DIR: ctx.cwd, MONOMIND_HOOK_QUIET: '1' },
        timeout: 5000,
        stdio: 'ignore',
      });
    } catch {
      /* best-effort — fall through to whatever control.json already has */
    }
  }
  if (existsSync(controlPath)) {
    try {
      const ctl = JSON.parse(readFileSync(controlPath, 'utf8')) as { port?: number; url?: string };
      const dashUrl =
        ctl.url || (ctl.port ? `http://localhost:${ctl.port}` : 'http://localhost:4242');
      log(output.dim(`  Dashboard: ${dashUrl}`));
    } catch {
      /* non-critical */
    }
  } else if (existsSync(controlStartPath)) {
    // control-start.cjs ran above (spawnSync'd synchronously with a 5s cap)
    // but control.json still doesn't exist — its own confirm-mode child is
    // still working in the background (npx cold-resolve etc., #142/#144)
    // rather than having failed outright. Point at the default port; the
    // confirm process will correct control.json once it lands.
    log(
      output.dim(
        '  Dashboard: http://localhost:4242 (starting — check back in a few seconds if unreachable)',
      ),
    );
  } else {
    log(
      output.dim(
        '  Dashboard: run `monomind init` to set up .claude/helpers/, then re-run to launch it automatically',
      ),
    );
  }

  // stopfile poll lets `org stop` work from another terminal; the daemon can
  // also stop the org itself (boss called org_complete, or the idle watchdog
  // fired) — detect that via getOrg() so the CLI exits instead of polling a
  // stopfile forever after a finished run. Clear any stale stop or reload
  // request from a previous run before polling.
  clearStopfile(ctx.cwd, name);
  clearReloadfile(ctx.cwd, name);
  // #206: a human explicitly running `monomind org stop` is a deliberate,
  // successful action regardless of how the run itself ended — capture that
  // BEFORE clearStopfile() below wipes the file, so it isn't lost.
  const { stoppedManually, signal } = await waitForRunEnd(ctx.cwd, name, daemon);
  clearStopfile(ctx.cwd, name);
  await daemon.stopAll();
  srv?.close();
  printRunEnd(runtimeState(ctx.cwd, name), { stoppedManually, signal });

  if (stoppedManually) return { success: true, message: `org ${name} stopped` };

  // #206: 'org run' used to exit 0 unconditionally here — a crashed or
  // watchdog-stopped run was indistinguishable from a completed one to any
  // script or supervisor (launchd/systemd) driving off the exit code. Re-read
  // the daemon's final record (same runtime.json pattern isOrgRunning/
  // statusAction already use below) and only report success for a run that
  // actually finished its goal via org_complete.
  return runOutcomeResult(name, runtimeState(ctx.cwd, name));
};
