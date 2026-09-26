// packages/@monomind/cli/src/commands/org.ts

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { OrgDaemon } from '../orgrt/daemon.js';
import { readIdleStatus } from '../orgrt/idle-deadline.js';
import { migrateOrgFile } from '../orgrt/migrate.js';
import {
  describeRunOutcome,
  readHistory,
  readRunEvents,
  summarizeRun,
  utcTime,
} from '../orgrt/reporting.js';
import { startOrgServer } from '../orgrt/server.js';
import { ORG_DIR, OrgDefSchema } from '../orgrt/types.js';
import { output } from '../output.js';
import type { Command, CommandContext, CommandResult } from '../types.js';
import {
  checkServeLock,
  classifyRun,
  clearPausefile,
  clearStaleControlFiles,
  isOrgPaused,
  listOrgConfigFiles,
  ORG_ARTIFACT_SUFFIXES,
  ORG_NAME_RE,
  validateOrgName,
} from './org-control.js';
import { pollReloadfiles, pollRunfiles, pollStopfiles } from './org-poll.js';
import { runAction } from './org-run.js';

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

const stopAction = async (ctx: CommandContext): Promise<CommandResult> => {
  const validated = validateOrgName(ctx.args[0]);
  if (!validated.ok) return validated.result;
  const name = validated.name;
  if (!existsSync(join(ctx.cwd, ORG_DIR, `${name}.json`))) {
    log(output.error(`Org not found: ${name}`));
    return { success: false, message: 'org not found' };
  }
  // The stopfile is only meaningful to a process that polls it (`org run` and, since
  // this fix, `org serve`). Writing it for an org that nothing is running was a silent
  // no-op that still reported "daemon exits within 2s" — say what's actually true.
  let rt: { status?: string; run?: string; pid?: number } | undefined;
  try {
    rt = JSON.parse(readFileSync(join(ctx.cwd, ORG_DIR, name, 'runtime.json'), 'utf8'));
  } catch {
    /* never run */
  }
  if (rt?.status !== 'running') {
    log(
      output.warning(
        `Org "${name}" is not running (runtime state: ${rt?.status ?? 'never run'}) — nothing to stop.`,
      ),
    );
    return { success: false, message: 'org not running' };
  }
  if (rt.pid) {
    let alive = true;
    try {
      process.kill(rt.pid, 0);
    } catch {
      alive = false;
    }
    if (!alive) {
      log(
        output.warning(
          `Org "${name}" is not running — runtime.json says running but pid ${rt.pid} is gone (crashed daemon).`,
        ),
      );
      log(output.info(`Clear the stale record with: monomind org mark-complete ${name}`));
      return { success: false, message: 'org crashed — use mark-complete' };
    }
  }
  mkdirSync(join(ctx.cwd, ORG_DIR, name), { recursive: true });
  writeFileSync(join(ctx.cwd, ORG_DIR, name, 'stop'), new Date().toISOString());
  log(
    output.info(
      `Stop requested for "${name}" (pid ${rt.pid}) — the daemon picks it up within ~2s.`,
    ),
  );
  return { success: true, message: `stop requested for ${name} (daemon exits within 2s)` };
};

const pauseAction = async (ctx: CommandContext): Promise<CommandResult> => {
  const validated = validateOrgName(ctx.args[0]);
  if (!validated.ok) return validated.result;
  const name = validated.name;
  if (!existsSync(join(ctx.cwd, ORG_DIR, `${name}.json`))) {
    log(output.error(`Org not found: ${name}`));
    return { success: false, message: 'org not found' };
  }
  if (isOrgPaused(ctx.cwd, name)) {
    log(output.warning(`Org "${name}" is already paused.`));
    return { success: true, message: 'already paused' };
  }
  mkdirSync(join(ctx.cwd, ORG_DIR, name), { recursive: true });
  writeFileSync(join(ctx.cwd, ORG_DIR, name, 'pause'), new Date().toISOString());
  log(
    output.info(
      `Org "${name}" paused — current turns will finish, no new cycles will start. Resume with: monomind org resume ${name}`,
    ),
  );
  return { success: true, message: `org ${name} paused` };
};

const resumeAction = async (ctx: CommandContext): Promise<CommandResult> => {
  const validated = validateOrgName(ctx.args[0]);
  if (!validated.ok) return validated.result;
  const name = validated.name;
  if (!isOrgPaused(ctx.cwd, name)) {
    log(output.warning(`Org "${name}" is not paused.`));
    return { success: true, message: 'not paused' };
  }
  clearPausefile(ctx.cwd, name);
  log(output.info(`Org "${name}" resumed — next scheduled tick will start a cycle.`));
  return { success: true, message: `org ${name} resumed` };
};

const reloadAction = async (ctx: CommandContext): Promise<CommandResult> => {
  const validated = validateOrgName(ctx.args[0]);
  if (!validated.ok) return validated.result;
  const name = validated.name;
  // The reload signal is a file the running daemon polls — same pattern as stop/pause.
  mkdirSync(join(ctx.cwd, ORG_DIR, name), { recursive: true });
  writeFileSync(join(ctx.cwd, ORG_DIR, name, 'reload'), new Date().toISOString());
  log(output.info(`Reload requested for "${name}" — the daemon picks it up within ~2s.`));
  return { success: true, message: `reload requested for ${name}` };
};

const statusAction = async (ctx: CommandContext): Promise<CommandResult> => {
  let name: string | undefined;
  if (ctx.args[0]) {
    const validated = validateOrgName(ctx.args[0]);
    if (!validated.ok) return validated.result;
    name = validated.name;
    // A named org that doesn't exist must error, not report "never run" with exit 0.
    if (!existsSync(join(ctx.cwd, ORG_DIR, `${name}.json`))) {
      log(output.error(`Org not found: ${name}`));
      return { success: false, message: 'org not found' };
    }
  }
  // Protocol JSON mode (agent-exec-protocol.md §7.2): compact runtime state
  // per org — the same liveness rule as the human path (a 'running' record
  // whose pid is gone is a crash, not a running org).
  if (ctx.flags.format === 'json') {
    const orgDir = join(ctx.cwd, ORG_DIR);
    const targets = name
      ? [name]
      : existsSync(orgDir)
        ? listOrgConfigFiles(orgDir).map((f) => f.replace(/\.json$/, ''))
        : [];
    const readState = (t: string) => {
      const rt = join(orgDir, t, 'runtime.json');
      if (!existsSync(rt)) return { name: t, status: 'never run' };
      try {
        const st = JSON.parse(readFileSync(rt, 'utf8')) as {
          status?: string;
          run?: string;
          pid?: number;
          abandonedRoles?: string[];
          closedBy?: string;
          error?: string;
          memoryError?: string;
        };
        let status = st.status ?? 'never run';
        // #274: an 'idle' run is still a running run to every protocol
        // consumer — only a genuine crash changes the reported status.
        if (status === 'running' || status === 'crashed') {
          if (classifyRun(ctx.cwd, t, st).state === 'crashed') status = 'crashed';
        }
        return {
          name: t,
          status,
          run: st.run,
          pid: st.pid,
          paused: isOrgPaused(ctx.cwd, t),
          abandoned_roles: st.abandonedRoles ?? [],
          closed_by: st.closedBy,
          error: st.error,
          // #293: present only when the run's cross-run memory was not stored.
          memory_error: st.memoryError,
          // #296: when the idle watchdog will stop a running org, or why it won't.
          ...(status === 'running' ? readIdleStatus(ctx.cwd, t, st.run) : {}),
        };
      } catch {
        return { name: t, status: 'unreadable-runtime' };
      }
    };
    const items = targets.map(readState);
    // Named org → bare singleton; no name → list envelope (protocol §7.1).
    process.stdout.write(`${JSON.stringify(name ? { v: 1, ...items[0] } : { v: 1, items })}\n`);
    return { success: true };
  }
  const orgDir = join(ctx.cwd, ORG_DIR);
  const targets = name
    ? [name]
    : existsSync(orgDir)
      ? listOrgConfigFiles(orgDir).map((f) => f.replace(/\.json$/, ''))
      : [];
  for (const t of targets) {
    const rt = join(orgDir, t, 'runtime.json');
    let state: { status: string; run?: string; pid?: number; abandonedRoles?: string[] } = {
      status: 'never run',
    };
    if (existsSync(rt)) {
      try {
        state = JSON.parse(readFileSync(rt, 'utf8'));
      } catch (err) {
        log(
          output.warning(
            `${t}: could not read runtime.json (${err instanceof Error ? err.message : 'corrupt/truncated file'})`,
          ),
        );
        continue;
      }
    }
    // A "running" record with no sign of life left means the daemon died
    // without its stopOrg cleanup — surface that instead of reporting it as
    // still running. A stale pid alone is NOT that proof (#274).
    let liveness: ReturnType<typeof classifyRun> | undefined;
    if (state.status === 'running' || state.status === 'crashed') {
      liveness = classifyRun(ctx.cwd, t, state);
      if (liveness.state === 'crashed') {
        let heartbeatHint = '';
        try {
          const hb = JSON.parse(
            readFileSync(join(ctx.cwd, '.monomind', 'serve-heartbeat.json'), 'utf8'),
          );
          heartbeatHint = ` (last heartbeat: ${hb.updatedAt})`;
        } catch {
          /* no heartbeat file — daemon predates this change or was already cleaned up */
        }
        const closedBy = (state as { closedBy?: string }).closedBy;
        const label =
          closedBy === 'crash-handler'
            ? 'crashed (caught by crash handler)'
            : `crashed (runtime.json says ${state.status} but pid ${state.pid} is gone and the run has been silent)`;
        log(
          output.warning(
            `${t}: ${label}${heartbeatHint}${state.run ? ` — run ${state.run}` : ''} — close it out with "monomind org mark-complete ${t}"`,
          ),
        );
        continue;
      }
    }
    const paused = isOrgPaused(ctx.cwd, t);
    const statusLabel =
      state.status === 'running'
        ? paused
          ? 'running (PAUSED)'
          : liveness?.state === 'idle'
            ? 'running (idle)'
            : 'running'
        : state.status;
    // Say when the recorded pid is no longer the thing proving it alive, so a
    // pid that doesn't match any process isn't a silent mystery.
    const staleHint =
      liveness?.evidence && liveness.evidence !== 'pid'
        ? ` — recorded pid ${state.pid} is stale; still live per ${liveness.evidence}`
        : '';
    const line = `${t}: ${statusLabel}${state.run ? ` (run ${state.run}, pid ${state.pid})` : ''}${staleHint}`;
    // A role that never spawned is a silent capability hole — an org with no
    // tester still reports a clean "running". Say it on the status line.
    if (state.abandonedRoles?.length) {
      log(
        output.warning(
          `${line} — DEGRADED: ${state.abandonedRoles.length} role(s) never spawned: ${state.abandonedRoles.join(', ')}`,
        ),
      );
    } else {
      log(output.info(line));
    }
    // #293: cross-run memory that was never written. Without this the only
    // symptom is org_recall coming back empty runs later, which points nowhere
    // near a memory backend that failed to load.
    const memoryError = (state as { memoryError?: string }).memoryError;
    if (memoryError) {
      log(
        output.warning(
          `  org memory: last run was NOT saved (${memoryError}) — org_recall will not find it`,
        ),
      );
    }

    // Enriched progress for running orgs
    if (state.status === 'running' && state.run) {
      // #296: when the idle watchdog will stop this org, or why it won't.
      // Say nothing for 'unknown' (no record yet) rather than a misleading zero.
      const idle = readIdleStatus(ctx.cwd, t, state.run);
      if (idle.idle_stop_at) {
        log(
          `  idle stop: in ${fmtDuration(idle.idle_stop_in_seconds! * 1000)} (at ${utcTime(Date.parse(idle.idle_stop_at))})`,
        );
      } else if (idle.idle_hold === 'disabled') {
        log(`  idle watchdog: disabled`);
      } else if (idle.idle_hold && idle.idle_hold !== 'unknown') {
        const until = idle.idle_hold_until
          ? ` until ${utcTime(Date.parse(idle.idle_hold_until))}`
          : '';
        log(`  idle stop: held — ${idle.idle_hold}${until}`);
      }

      const events = readRunEvents(ctx.cwd, t, state.run);
      if (events.length) {
        const summary = summarizeRun(events);
        const elapsed = summary.startedAt ? Date.now() - summary.startedAt : null;
        const elapsedStr = elapsed !== null ? fmtDuration(elapsed) : '?';
        const lastTs = events[events.length - 1].ts;
        const quietMs = Date.now() - lastTs;
        const quietStr = fmtDuration(quietMs);
        const toolCalls = Object.values(summary.roles).reduce(
          (a, r) => a + r.toolsAllowed + r.toolsDenied,
          0,
        );
        const rolesUp = Object.keys(summary.roles).filter((r) => r !== '(system)').length;

        log(
          `  elapsed: ${elapsedStr} | events: ${summary.events} | messages: ${summary.messages} | tools: ${toolCalls}`,
        );
        log(
          `  roles active: ${rolesUp} | tokens: ${fmtNum(summary.totalTokens)} | cost: $${summary.totalCostUsd.toFixed(2)}`,
        );
        log(`  quiet since: ${utcTime(lastTs)} (${quietStr} ago)`);
        if (summary.crashes.length) log(output.warning(`  crashes: ${summary.crashes.join(', ')}`));
      }

      // Previous cycle comparison from history
      const history = readHistory(ctx.cwd, t);
      const prev = history.filter((h) => h.run !== state.run).at(-1);
      if (prev) {
        const dur = prev.durationMs !== null ? fmtDuration(prev.durationMs) : '?';
        // #302: never blindly "completed" — describeRunOutcome only says
        // that for a genuine boss outcome, a real crash, or a bare manual
        // stop; every automated stop path (idle-stop, failed-start, a boss
        // restart giving up) reports its own real cause, with the runnable
        // task count if work was left outstanding.
        const outcome = describeRunOutcome(prev);
        log(
          `  prev cycle: ${dur}, ${outcome}, ${prev.events} events, ${fmtNum(prev.totalTokens)} tokens`,
        );
      }
    }
  }
  return { success: true };
};

function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/**
 * Emit a supervisor unit for `org serve`.
 *
 * Why this is an EXTERNAL supervisor and not an `--supervise` flag: the daemon
 * already logs every death it can observe — signals, uncaught exceptions,
 * unhandled rejections, and the event loop draining. The one death it cannot
 * observe is SIGKILL, which is what the OOM killer sends, and which is the
 * suspected cause of the reported disappearance (its org logs showed repeated
 * low-memory warnings). No in-process handler survives SIGKILL, so a daemon
 * that restarts itself is theatre for exactly the case that matters. Only
 * something outside the process can bring it back.
 *
 * launchd and systemd both already do this well, so this generates a correct
 * unit rather than reimplementing them.
 */
const supervisorAction = async (ctx: CommandContext): Promise<CommandResult> => {
  const cwd = resolve(ctx.cwd || process.cwd());
  const requested = String(ctx.flags.format ?? '')
    .trim()
    .toLowerCase();
  const format = requested || (process.platform === 'darwin' ? 'launchd' : 'systemd');
  if (format !== 'launchd' && format !== 'systemd') {
    log(output.error(`Unknown --format "${requested}" — expected launchd or systemd.`));
    return { success: false, message: 'unknown supervisor format' };
  }

  // argv[1] is this CLI's entry point — the same resolution `init` uses when it
  // spawns a watcher. A supervisor must not depend on PATH or npx resolving to
  // the same version later.
  const cliEntry = process.argv[1] ? resolve(process.argv[1]) : 'monomind';
  const node = process.execPath;
  // Per-project identity. The unit bakes in a WorkingDirectory, so a constant
  // Label and filename meant `--install` from a second project silently
  // OVERWROTE the first project's unit — one file, the first daemon left
  // unsupervised, no warning. Verified before fixing: installing from projA
  // then projB left a single unit pointing at projB.
  //
  // The hash keeps it unique for two directories with the same basename; the
  // basename keeps it recognisable in `launchctl list` / `systemctl --user`.
  const slug = `${(cwd.split(/[\\/]/).pop() || 'org').replace(/[^A-Za-z0-9._-]/g, '-')}-${createHash('sha256').update(cwd).digest('hex').slice(0, 8)}`;
  const label = `com.monomind.org-serve.${slug}`;
  const logPath = join(cwd, '.monomind', 'org-serve.log');

  const unit =
    format === 'launchd'
      ? `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${node}</string>
    <string>${cliEntry}</string>
    <string>org</string>
    <string>serve</string>
  </array>
  <key>WorkingDirectory</key><string>${cwd}</string>
  <!-- KeepAlive restarts the daemon however it died, including SIGKILL. -->
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${logPath}</string>
  <key>StandardErrorPath</key><string>${logPath}</string>
</dict>
</plist>
`
      : `[Unit]
Description=monomind org serve (${cwd})
After=network.target

[Service]
Type=simple
WorkingDirectory=${cwd}
ExecStart=${node} ${cliEntry} org serve
# Restart however it died, including an OOM kill.
Restart=always
RestartSec=5
StandardOutput=append:${logPath}
StandardError=append:${logPath}

[Install]
WantedBy=default.target
`;

  const target =
    format === 'launchd'
      ? `~/Library/LaunchAgents/${label}.plist`
      : `~/.config/systemd/user/monomind-org-serve-${slug}.service`;

  if (ctx.flags.install === true) {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    if (!home) {
      log(
        output.error('Cannot resolve a home directory to install into — write the unit manually.'),
      );
      return { success: false, message: 'no home directory' };
    }
    const dest =
      format === 'launchd'
        ? join(home, 'Library', 'LaunchAgents', `${label}.plist`)
        : join(home, '.config', 'systemd', 'user', `monomind-org-serve-${slug}.service`);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, unit);
    log(output.success(`Wrote ${dest}`));
    log(
      output.info(
        format === 'launchd'
          ? `Load it with: launchctl load -w ${dest}`
          : `Load it with: systemctl --user daemon-reload && systemctl --user enable --now monomind-org-serve-${slug}`,
      ),
    );
    return { success: true, message: `supervisor unit written to ${dest}` };
  }

  log(unit);
  log(output.info(`Write this to ${target}, or re-run with --install to do it for you.`));
  log(
    output.info(
      'Why a supervisor: the daemon logs every death it can observe, but an OOM kill is SIGKILL — ' +
        'uncatchable by design, so nothing in-process can restart after one.',
    ),
  );
  return { success: true, message: `${format} unit emitted` };
};

const serveAction = async (ctx: CommandContext): Promise<CommandResult> => {
  // Mutual exclusion: refuse to start a second `org serve` for this project
  // root. Checked before anything else so a refusal never opens a port,
  // registers a broker lease, or starts a scheduled org that a live daemon
  // is already running — see checkServeLock's header for the failure mode
  // this prevents.
  const lock = checkServeLock(ctx.cwd);
  if (!lock.ok) {
    log(
      output.error(
        `org serve: another daemon (pid ${lock.pid}) is already running for this project root.`,
      ),
    );
    log(output.info(`  Check what it's doing with: monomind org status`));
    log(
      output.info(`  Stop it first (Ctrl-C in its terminal, or "kill ${lock.pid}"), then retry.`),
    );
    return { success: false, message: `org serve already running (pid ${lock.pid})` };
  }
  if (lock.staleHeartbeatRemoved) {
    log(
      output.warning(
        'org serve: cleaned up a stale heartbeat left by a previous daemon that did not shut down cleanly.',
      ),
    );
  }
  // See the matching comment in runAction — same rationale, same guard
  // (embedder and reranker, scoped to this process, not exported to roles).
  const { disableLocalModels } = await import('../memory/memory-bridge.js');
  disableLocalModels();
  const crossProcess = ctx.flags.crossProcess !== false;
  const daemon = new OrgDaemon(ctx.cwd, { crossProcess });
  let srv: Awaited<ReturnType<typeof startOrgServer>> | undefined;
  if (crossProcess) {
    srv = await startOrgServer(daemon, 0);
    daemon.setInboxUrl(`http://127.0.0.1:${srv.port}`, srv.operatorCredential);
  }

  // Crash handlers: log the reason and persist crashed state so `org status`
  // shows what happened instead of a silent "pid is gone". A truly unknown
  // uncaught exception's blast radius can't always be attributed to one org,
  // so the whole process still exits (the safety-first default) — but naming
  // which orgs were in flight at the moment it fired at least tells the
  // operator the blast radius they actually hit, instead of leaving them to
  // guess from an error with no org context.
  const crashExit = (label: string, err: unknown): void => {
    try {
      const running = daemon.listRunning();
      console.error(
        `[org serve] ${label}:`,
        err,
        running.length ? `— orgs in flight: ${running.join(', ')}` : '— no orgs were running',
      );
    } catch {
      try {
        console.error(`[org serve] ${label}:`, err);
      } catch {
        /* stderr gone */
      }
    }
    daemon.persistCrashStateAll(`${label}: ${err instanceof Error ? err.message : String(err)}`);
    daemon.clearHeartbeat();
    process.exitCode = 1;
  };
  process.on('uncaughtException', (err) => {
    crashExit('uncaughtException', err);
    process.exit(1);
  });
  process.on('unhandledRejection', (err) => {
    crashExit('unhandledRejection', err);
    process.exit(1);
  });

  // Termination diagnostics (#45). The two handlers above only cover errors
  // raised *inside* the daemon. A report of the daemon vanishing after hours
  // had a log holding nothing but its startup lines, because the ways a daemon
  // usually dies were all unhandled:
  //
  //   - a signal (SIGTERM from a supervisor/OS, SIGHUP when a terminal closes)
  //   - the event loop simply draining, which exits 0 and says nothing at all
  //
  // Both now announce themselves. Note what this deliberately cannot cover:
  // SIGKILL, which is what the OOM killer sends, is uncatchable by design — no
  // in-process handler can ever log it. That case is instead made *inferable*:
  // every shutdown path below prints a terminal line, so a log that starts and
  // then stops with no such line means the process was killed from outside
  // (OOM being the usual culprit, and the reporter's org logs did show memory
  // pressure). Absence of a shutdown line is now evidence, not ambiguity.
  let shuttingDown = false;
  const announceExit = (reason: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      console.error(`[org serve] shutting down: ${reason}`);
    } catch {
      /* stderr gone */
    }
  };
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    process.on(sig, () => {
      announceExit(`received ${sig}`);
      try {
        daemon.persistCrashStateAll();
        daemon.clearHeartbeat();
      } catch {
        /* best effort */
      }
      // A daemon holds ref'd timers, so it will not drain on its own; an
      // explicit exit is required here and is the intended signal semantics.
      process.exit(sig === 'SIGTERM' || sig === 'SIGINT' ? 0 : 1);
    });
  }
  process.on('exit', (code) => {
    // Last word on the way out. Reached for the "event loop drained" case,
    // which previously produced a completely silent disappearance.
    announceExit(`process exiting with code ${code}`);
  });

  // Heartbeat: write every 30s so `org status` can tell "alive but busy" from
  // "daemon gone" without relying on pid liveness alone.
  daemon.writeHeartbeat();
  const heartbeatInterval = setInterval(() => {
    daemon.writeHeartbeat();
  }, 30_000);
  heartbeatInterval.unref?.();

  log(output.info('org daemon serving — Ctrl-C to stop'));

  // schedule orgs whose definition declares an interval (e.g. "15m", "2h")
  const { OrgScheduler, parseSchedule } = await import('../orgrt/scheduler.js');
  const sched = new OrgScheduler(async (name, intervalMs) => {
    if (isOrgPaused(ctx.cwd, name)) return;
    // Run precondition checks before starting a scheduled run
    try {
      const defPath = join(ctx.cwd, ORG_DIR, `${name}.json`);
      if (existsSync(defPath)) {
        const rawDef = JSON.parse(readFileSync(defPath, 'utf8'));
        const checks = rawDef?.run_config?.prechecks;
        if (Array.isArray(checks) && checks.length > 0) {
          const { runPrechecks } = await import('../orgrt/prechecks.js');
          const { ok, results } = await runPrechecks(checks, ctx.cwd);
          if (!ok) {
            const failed = results.find((r) => !r.passed);
            log(
              output.warning(
                `org ${name}: precheck "${failed?.name}" failed — skipping scheduled run`,
              ),
            );
            if (failed?.output) log(output.warning(`  ${failed.output.slice(0, 200)}`));
            return;
          }
        }
      }
    } catch (err) {
      log(
        output.warning(
          `org ${name}: precheck evaluation error — ${err instanceof Error ? err.message : 'unknown'}`,
        ),
      );
    }
    // Only ever stop a run THIS tick started. The runfile poll can start an org
    // out-of-band, and the scheduler has no visibility into that — so a tick
    // landing on an already-running org threw "already running", fell into the
    // finally, and stopped a healthy run that had nothing to do with it. The
    // tick's job in that case is simply to yield.
    let startedHere = false;
    try {
      await daemon.startOrg(name);
      startedHere = true;
      // Scheduled iterations are time-bounded: agents' `done` promises only
      // resolve after stopOrg closes the mailboxes, so waiting on them alone
      // deadlocks. Race against a max-run timeout, then ALWAYS stopOrg
      // (idempotent — it resolves `done` and flushes).
      const org = daemon.getOrg(name);
      const allDone = org
        ? Promise.allSettled([...org.agents.values()].map((a) => a.done))
        : Promise.resolve([]);
      const maxRun = (org?.def as { run_config?: { max_run?: string | number } } | undefined)
        ?.run_config?.max_run;
      // Default to the full interval. The old `min(interval, 10min)` clamp
      // silently guillotined every org that didn't set max_run: real cycles
      // here run 75-93 minutes, so a 2h-scheduled org was being force-stopped
      // a twelfth of the way in, every time, with nothing saying so. Ten
      // minutes was never a considered bound for agent work — it only looked
      // safe because overrunning the interval used to cost a whole idle
      // period. Now that a missed tick catches up the moment a run ends
      // (OrgScheduler.pending), a run may safely use its whole interval.
      // Set run_config.max_run to bound it tighter — or looser.
      const maxMs = parseSchedule(maxRun) ?? intervalMs;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        allDone,
        new Promise<void>((r) => {
          timer = setTimeout(r, maxMs);
          timer.unref?.();
        }),
      ]);
      if (timer) clearTimeout(timer);
    } catch (err) {
      console.error(`org ${name}: scheduled run failed:`, err);
    } finally {
      // A deadline stop still lands on agents mid-tool-call. The 15s abort
      // bound threw that work away; a minute is enough to finish an edit or a
      // test run and flush, and still well inside any sane interval.
      if (startedHere) {
        // #302: tag the real cause — a scheduled run hitting its own
        // deadline is the same shape as an idle-stop (a timeout ending the
        // run with possible backlog, not boss consent) and must not be
        // rendered as a clean, boss-attributed outcome.
        await daemon
          .stopOrg(name, { drainMs: 60_000, closedBy: 'scheduled-deadline' })
          .catch((err) => console.error(`org ${name}: stop failed:`, err));
      }
    }
  });
  // #264: before anything here can start an org — and so before the stop and
  // reload polls below get their first pass — drop control files a previous
  // daemon left behind, which this one would otherwise act on immediately.
  clearStaleControlFiles(ctx.cwd);
  const orgDir = join(ctx.cwd, ORG_DIR);
  if (existsSync(orgDir)) {
    for (const f of listOrgConfigFiles(orgDir)) {
      try {
        const def = JSON.parse(readFileSync(join(orgDir, f), 'utf8'));
        const ms = parseSchedule(def.schedule);
        if (ms) {
          // register by filename stem — that's what startOrg loads
          const stem = f.replace(/\.json$/, '');
          if (def.name && def.name !== stem)
            log(
              output.warning(
                `org file ${f}: def.name "${def.name}" differs from filename — scheduling as "${stem}"`,
              ),
            );
          // Due = never run, or last run ended longer ago than the interval.
          // Without this, starting the daemon meant waiting a full period
          // before anything happened at all; gating on due-ness means a
          // restart doesn't stampede every scheduled org back into a run.
          const lastEnded = readHistory(ctx.cwd, stem).at(-1)?.endedAt ?? 0;
          const since = lastEnded ? Date.now() - lastEnded : undefined;
          const due = (since ?? Infinity) >= ms;
          sched.add(stem, ms, due, since);
          const waitMin = due ? 0 : Math.round((ms - (since ?? 0)) / 60_000);
          log(
            output.info(
              `scheduled org ${stem} every ${Math.round(ms / 60_000)}m${due ? ' — due now, starting first run' : ` — next run in ~${waitMin}m`}`,
            ),
          );
        }
      } catch (err) {
        log(
          output.warning(
            `org file ${f}: could not parse — skipping (${err instanceof Error ? err.message : 'invalid JSON'})`,
          ),
        );
      }
    }
  }

  // Each poll pass already wraps its own per-org daemon calls in try/catch,
  // but a synchronous throw from something ahead of those (e.g.
  // daemon.listRunning(), listOrgConfigFiles()) still rejects the async
  // function itself. `void`-ing that call, as before, discards the promise
  // without observing a rejection — which becomes an unhandled rejection at
  // the process level and takes down every other org's in-flight run via
  // crashExit, even though the failure was local to one poll pass. .catch()
  // keeps it a per-pass, logged failure instead.
  const stopPoll = setInterval(() => {
    pollStopfiles(ctx.cwd, daemon).catch((err) => {
      console.error('[org serve] stopfile poll failed:', err);
    });
  }, 2000);
  stopPoll.unref?.();
  const runPoll = setInterval(() => {
    pollRunfiles(ctx.cwd, daemon).catch((err) => {
      console.error('[org serve] runfile poll failed:', err);
    });
  }, 2000);
  runPoll.unref?.();
  const reloadPoll = setInterval(() => {
    pollReloadfiles(ctx.cwd, daemon).catch((err) => {
      console.error('[org serve] reloadfile poll failed:', err);
    });
  }, 2000);
  reloadPoll.unref?.();

  await new Promise<void>((r) => {
    process.once('SIGINT', () => r());
    process.once('SIGTERM', () => r());
  });
  clearInterval(stopPoll);
  clearInterval(runPoll);
  clearInterval(reloadPoll);
  clearInterval(heartbeatInterval);
  sched.stop();
  await daemon.stopAll();
  daemon.clearHeartbeat();
  srv?.close();
  return { success: true };
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
