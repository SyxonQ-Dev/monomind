// packages/@monomind/cli/src/orgrt/daemon.ts
// monolean: single-process inter-org — upgrade path = daemon-to-daemon HTTP when multi-host is real

import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { resolveOrgDefBlueprints } from '../catalog/blueprints.js';
import { writeJsonFileAtomic } from '../utils/json-file.js';
import { reapOrphanedSdkProcesses } from '../utils/resource-governor.js';
// ── Extracted module imports ────────────────────────────────────────────
import * as approvalOps from './approvals.js';
import type { BrokerLease } from './broker.js';
import { reopenBudgetClosedRoles, rolesOnDefTokenCaps } from './budget-closure.js';
import type { OrgBus } from './bus.js';
import {
  captureCheckpoint,
  generateChecksum,
  type OrgCheckpoint,
  type RoleCheckpoint,
} from './checkpoint.js';
import * as checkpointOps from './checkpoint-ops.js';
import type { TaskEvidence } from './completion-gate.js';
import * as crossOrg from './cross-org.js';
import type { AgentRuntime, DaemonOpts, RunningOrg } from './daemon-types.js';
import * as decisionOps from './decisions.js';
import { isEndpointRole, stopEndpointRetries } from './endpoint-roles.js';
import type { attachForwarder } from './forwarder.js';
import { clearIdleRecord } from './idle-deadline.js';
import * as orgMemory from './org-memory.js';
import * as orgStart from './org-start.js';
import { expandOrgPolicyPathVars, promptVarsFor } from './prompt-vars.js';
import * as questionOps from './questions.js';
import { historyFile, type RunSummary, readRunEvents, summarizeRun } from './reporting.js';
import * as roleIncarnation from './role-incarnation.js';
import * as roleRespawn from './role-respawn.js';
import { computeReplacementBudget, type RespawnReceipt } from './role-slot.js';
import { currentRoleTrace, type RoleTrace } from './role-trace.js';
import { buildRuntimeOptions, type RuntimeOptionsReceipt } from './runtime-options.js';
import { sandboxStubs } from './sandbox-stubs.js';
import * as scheduler from './scheduler-integration.js';
import type { TaskPick } from './task-match.js';
import { ToolProviderHub } from './tool-providers.js';
import {
  type BusEvent,
  type DecisionGate,
  type DecisionKind,
  ORG_DIR,
  type OrgDef,
  OrgDefSchema,
  type OrgRole,
} from './types.js';

/** OpenTelemetry tracing helper - creates spans for major operations */
class _OtelTracer {
  private enabled = false;
  private spans = new Map<string, { start: number; metadata: Record<string, unknown> }>();

  enable(): void {
    this.enabled = true;
  }

  startSpan(name: string, metadata: Record<string, unknown> = {}): void {
    if (!this.enabled) return;
    this.spans.set(name, { start: Date.now(), metadata });
  }

  endSpan(name: string): void {
    if (!this.enabled) return;
    const span = this.spans.get(name);
    if (span) {
      const _duration = Date.now() - span.start;
      // Emit span as a bus event for export
      this.spans.delete(name);
    }
  }

  recordEvent(_name: string, _attributes: Record<string, unknown>): void {
    if (!this.enabled) return;
    // Could emit to bus for collection
  }
}

export {
  type AgentRuntime,
  activeRoleCount,
  type DaemonOpts,
  type RunningOrg,
  roleTokenBudget,
  ScrollbackBuffer,
} from './daemon-types.js';
export { resolvedIdleNudgeCount } from './idle-watchdog.js';
export { resolveOrgComplete } from './role-session-opts.js';
export {
  type ProviderKind,
  type RuntimeKind,
  resolveRoleRunner,
  resolveRunner,
} from './runner-resolve.js';
export { resolveAutoAssignee } from './task-match.js';

export class OrgDaemon {
  /** @internal */ orgs = new Map<string, RunningOrg>();
  /** @internal */ waking = new Set<string>();
  /** @internal */ globalSubscribers = new Set<(e: BusEvent) => void>();
  /** @internal */ leases = new Map<string, BrokerLease>();
  /** @internal */ forwarders = new Map<string, ReturnType<typeof attachForwarder>>();
  /** @internal */ watchdogs = new Map<string, ReturnType<typeof setInterval>>();
  /** @internal */ stopping = new Map<string, Promise<void>>();
  /** @internal Bug 2 (TOCTOU race): names currently reserved by an in-flight
   *  startOrg() call, from the synchronous existence check through
   *  registration in `orgs`. Closes the window where two concurrent
   *  startOrg(name) calls could both pass the `orgs.has(name)` check before
   *  either registered and spawn duplicate runs. */
  /** @internal */ startingOrgs = new Set<string>();
  /** @internal */ approvals = new Map<
    string,
    Array<{
      roleId: string;
      action: string;
      /** Fingerprint of the tool call's actual arguments (e.g. the Bash command,
       *  the WebFetch url) — see approvals.ts's checkApproval. Distinguishes a
       *  materially different call from one already approved/pending under the
       *  same (roleId, action), so one human approval can't silently authorize
       *  every future call to that tool. Optional only so pre-fix entries
       *  loaded from an old approvals.json don't fail to parse. */
      fingerprint?: string;
      question: string;
      ts: number;
      approved: boolean | null;
      /** M5: `apr-<ms>-<8 hex>` — addresses exactly this request. */
      requestId?: string;
      /** M5: the redacted argument summary `policy.decide` logged. */
      input?: Record<string, unknown>;
      /** M5: who resolved it (`human` by default). */
      resolvedBy?: string;
      resolvedAt?: number;
    }>
  >();
  /** @internal #345: per org, the actions `org run --auto-approve` pre-approved
   *  for the current run (approvals.ts's checkApproval). Kept across a boss
   *  auto-restart, replaced by every other start. */
  runAutoApprove = new Map<string, string[]>();
  /** @internal */ approvalLocks = new Map<string, Promise<unknown>>();
  /** @internal */ gatesLocks = new Map<string, Promise<unknown>>();
  /** @internal */ questionsLocks = new Map<string, Promise<unknown>>();
  /** @internal */ spawning = new Map<string, Set<string>>();
  static readonly MAX_BOSS_RESTARTS = 2;
  static readonly BOSS_RESTART_BACKOFF_MS = [10_000, 30_000];
  /** @internal */ bossRestartCounts = new Map<string, number>();
  /** @internal */ restarting = new Set<string>();
  // #3: recognizes provider context-window-overflow errors so the boss can be told
  // to chunk the work instead of re-dispatching the same oversized task verbatim.
  /** @internal */
  static readonly CONTEXT_LIMIT_RE =
    /context[- ]?(window|length|size|limit)|maximum context|exceeds?.{0,12}(context|token)|too many tokens|prompt is too long/i;

  /** @internal */ recallUsage = new Map<string, Set<string>>();
  /** @internal */ orgLearnedRuns = new Set<string>();
  /** @internal */ abandoned = new Map<string, Set<string>>();
  /** #293: per-org reason the last run's cross-run memory was NOT stored.
   *  persistState() writes it into runtime.json so `org status` can still
   *  explain an empty org_recall long after the run. */
  /** @internal */ memoryErrors = new Map<string, string>();
  /** M1: role tool-provider tool-list cache and live provider processes. */
  /** @internal */ toolProviders = new ToolProviderHub();

  constructor(
    /** @internal */ public root: string,
    /** @internal */ public opts: DaemonOpts = {},
  ) {}

  /** Publish this daemon's inbox so orgs started AFTER this call register with the broker. */
  setInboxUrl(url: string, operatorCredential?: string): void {
    this.opts.inboxUrl = url;
    if (operatorCredential !== undefined) this.opts.operatorCredential = operatorCredential;
  }

  /** subscribe to events from ALL running orgs (dashboard server uses this) */
  subscribe(fn: (e: BusEvent) => void): () => void {
    this.globalSubscribers.add(fn);
    return () => this.globalSubscribers.delete(fn);
  }

  listOrgs(): RunningOrg[] {
    return [...this.orgs.values()];
  }
  getOrg(name: string): RunningOrg | undefined {
    return this.orgs.get(name);
  }

  /** Hot-reload an org definition from disk without stopping running sessions.
   *  Applies: goal, run_config, schedule. New roles are added as pending (lazy-spawnable).
   *  Removed roles are NOT killed — they finish their current work and won't be re-spawned.
   *  Returns a summary of what changed. */
  reloadOrgDef(name: string): { changed: string[]; newRoles: string[]; removedRoles: string[] } {
    const running = this.orgs.get(name);
    if (!running) throw new Error(`org ${name} is not running`);
    const defPath = join(this.root, ORG_DIR, `${name}.json`);
    const parsedDef = OrgDefSchema.parse(JSON.parse(readFileSync(defPath, 'utf8')));
    const bp = resolveOrgDefBlueprints(parsedDef, this.root);
    if (bp.errors.length) throw new Error(`org ${name}: ${bp.errors.join('; ')}`);
    const newDef = expandOrgPolicyPathVars(bp.def, promptVarsFor(this.root));
    const changed: string[] = [];
    const newRoles: string[] = [];
    const removedRoles: string[] = [];
    const onDefTokenCaps = rolesOnDefTokenCaps(running);

    if (newDef.goal !== running.def.goal) {
      running.def.goal = newDef.goal;
      changed.push('goal');
    }

    const oldRc = running.def.run_config as Record<string, unknown>;
    const newRc = newDef.run_config as Record<string, unknown>;
    for (const key of new Set([...Object.keys(oldRc), ...Object.keys(newRc)])) {
      if (JSON.stringify(oldRc[key]) !== JSON.stringify(newRc[key])) {
        oldRc[key] = newRc[key];
        changed.push(`run_config.${key}`);
      }
    }

    // M1 (C-37): apply changes to EXISTING roles' tool_providers, endpoint,
    // kind and policy. Fields are replaced on the live role object (sessions
    // read tool_providers at their next start, checkApproval reads policy
    // live) and a running role's PolicyEngine gets the new policy now.
    // #343: budget_usd / budget_tokens too — the live PolicyEngine gets the
    // new caps with its spend kept, and a role closed for budget reopens
    // below once it is no longer over them.
    const RELOADABLE_ROLE_FIELDS = [
      'tool_providers',
      'endpoint',
      'kind',
      'policy',
      'budget_usd',
      'budget_tokens',
    ] as const;
    for (const next of newDef.roles) {
      const live = running.def.roles.find((r) => r.id === next.id);
      if (!live) continue;
      const liveRec = live as Record<string, unknown>;
      const nextRec = next as Record<string, unknown>;
      for (const field of RELOADABLE_ROLE_FIELDS) {
        if (JSON.stringify(liveRec[field]) === JSON.stringify(nextRec[field])) continue;
        const targets = new Set<Record<string, unknown>>([liveRec]);
        const slotRole = running.roleSlots.get(next.id)?.effectiveRole as
          | Record<string, unknown>
          | undefined;
        if (slotRole) targets.add(slotRole);
        const pending = running.pendingRoles?.get(next.id) as Record<string, unknown> | undefined;
        if (pending) targets.add(pending);
        for (const t of targets) {
          if (nextRec[field] === undefined) delete t[field];
          else t[field] = nextRec[field];
        }
        if (field === 'policy') running.agents.get(next.id)?.policy.updatePolicy(next.policy ?? {});
        if (field === 'budget_usd' || field === 'budget_tokens')
          running.agents.get(next.id)?.policy.setBudgetCaps({
            maxTokens: live.policy?.maxTokens ?? computeReplacementBudget(running.def, next.id),
            maxUsd: live.policy?.maxUsd ?? live.budget_usd,
          });
        changed.push(`role:${next.id}:${field}`);
      }
    }
    const reopened = reopenBudgetClosedRoles(this, name, running, onDefTokenCaps);

    const existingRoleIds = new Set(running.def.roles.map((r) => r.id));
    const newRoleIds = new Set(newDef.roles.map((r) => r.id));
    for (const role of newDef.roles) {
      if (!existingRoleIds.has(role.id)) {
        running.def.roles.push(role);
        // M2: an endpoint role never gets a session — nothing to lazy-spawn.
        if (!isEndpointRole(role)) {
          if (!running.pendingRoles) running.pendingRoles = new Map();
          running.pendingRoles.set(role.id, role);
        }
        newRoles.push(role.id);
      }
    }
    for (const id of existingRoleIds) {
      if (!newRoleIds.has(id)) removedRoles.push(id);
    }

    running.bus.emit({
      type: 'audit',
      reason: 'hot-reload',
      msg: `org def reloaded: ${changed.length} fields changed, ${newRoles.length} new roles, ${removedRoles.length} removed roles${reopened.length ? `, reopened ${reopened.join(', ')}` : ''}`,
      data: { changed, newRoles, removedRoles },
    });

    return { changed, newRoles, removedRoles };
  }
  /** Names of the orgs this daemon currently has running. Snapshot — safe to
   *  iterate while stopOrg() mutates the underlying map. */
  listRunning(): string[] {
    return [...this.orgs.keys()];
  }

  /** M1: the chain trace a role's tool calls carry — from the most recent
   *  message delivered to it with a `[trace chn_… hop=N]` line, otherwise a
   *  fresh chain (hop 0) minted once and kept for the role — plus the role's
   *  turn (#327, role-trace.ts). */
  roleTrace(org: string, role: string): RoleTrace {
    return currentRoleTrace(this.orgs.get(org), role);
  }

  /** Hook for the SSE server — registers a listener for all bus events across all orgs. */
  onBusEvent?: (fn: (e: BusEvent) => void) => void = (fn) => {
    this.subscribe(fn);
  };

  /** Snapshot of all running orgs for dashboard initial load. */
  getStatusSnapshot?: () => Record<string, unknown> = () => {
    const orgs: Record<string, unknown>[] = [];
    for (const [name, running] of this.orgs) {
      const roles: Record<string, unknown>[] = [];
      for (const [roleId, agent] of running.agents) {
        roles.push({
          id: roleId,
          status: agent.status,
          worktree: agent.worktreePath ?? null,
          metrics: agent.metrics,
        });
      }
      orgs.push({
        name,
        run: running.run,
        roles,
        pendingRoles: running.pendingRoles ? [...running.pendingRoles.keys()] : [],
        tasks: running.taskDag?.all() ?? [],
      });
    }
    return { orgs };
  };

  /** Resolve run_config.workspace to 'repo' | 'isolated' | an absolute path.
   *  A relative path is resolved against the project root rather than the
   *  daemon's cwd, which is not the same directory when `org serve` is started
   *  from a subdirectory. */
  /** @internal */
  workspaceSetting(def: OrgDef): string {
    const ws = (def.run_config as { workspace?: string }).workspace ?? 'repo';
    if (ws === 'repo' || ws === 'isolated' || ws === 'worktree' || ws === 'worktree-per-role')
      return ws;
    return isAbsolute(ws) ? ws : join(this.root, ws);
  }

  async startOrg(
    name: string,
    taskOverride?: string,
    options?: { resume?: boolean; autoApprove?: string[] },
  ): Promise<RunningOrg> {
    return orgStart.startOrg(this, name, taskOverride, options);
  }

  /** Build one role incarnation: mailbox, policy, AgentRuntime, sessionOpts,
   *  and the supervised crash-retry loop. Used by BOTH the startup lazy-spawn
   *  path (generation 0, via the `spawnRole` closure inside startOrgInner)
   *  and respawnRole() (generation N+1). Does not touch running.agents or
   *  running.roleSlots — callers publish the result themselves. */
  spawnRoleIncarnation(
    name: string,
    running: RunningOrg,
    role: OrgRole,
    generation: number,
    opts: {
      roleCheckpoint?: RoleCheckpoint;
      abort?: AbortController;
      budgetTokensOverride?: number;
    } = {},
  ): { runtime: AgentRuntime; abort: AbortController } {
    return roleIncarnation.spawnRoleIncarnation(this, name, running, role, generation, opts);
  }

  /** org_respawn_role's daemon-owned implementation. See the design doc's
   *  "Replacement algorithm" (13 steps) — this method's body follows those
   *  steps in order, numbered in comments. */
  async respawnRole(name: string, callerId: string, rawInput: unknown): Promise<RespawnReceipt> {
    return roleRespawn.respawnRole(this, name, callerId, rawInput);
  }

  /** @internal */
  hasOrgDef(name: string): boolean {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(name)) return false;
    return existsSync(join(this.root, ORG_DIR, `${name}.json`));
  }

  /** @param opts.drainMs how long to let in-flight agent sessions finish before
   *  reaping. Defaults to the short abort bound; the planned-completion path
   *  passes a far longer window (see COMPLETE_DRAIN_MS).
   *  @param opts.closedBy #206: tags WHY the run ended, persisted into
   *  runtime.json so `org run` can tell a clean, goal-driven end
   *  (closedBy: 'org-complete') from every other kind of stop (idle
   *  watchdog, boss-restart-exhausted, manual `org stop`) and exit non-zero
   *  for the latter. Only the org_complete auto-stop path passes this. */
  async stopOrg(name: string, opts?: { drainMs?: number; closedBy?: string }): Promise<void> {
    // Join an in-flight stop instead of no-oping: the self-stop paths
    // (org_complete, idle watchdog) run detached, and a caller like
    // `org run`'s final stopAll() must not resolve — letting the process
    // exit — while that stop is still flushing the bus and writing
    // history/runtime.json.
    const inflight = this.stopping.get(name);
    if (inflight) return inflight;
    const org = this.orgs.get(name);
    if (!org) return; // already stopped
    org.pendingRoles?.clear(); // prevent lazy spawns after stop
    this.spawning.delete(name); // clean up spawning tracking for this org
    // #304: set before the delete below, since that delete is what makes
    // abortedByStop (role loop) true — the role loop reads it off this same
    // object reference, not a fresh lookup (the org is gone from the map by then).
    org.closedBy = opts?.closedBy;
    // Remove immediately (not at the end) so a concurrent stopOrg(name) call —
    // e.g. stopAll() racing a scheduler-triggered stop on SIGINT — joins this
    // shutdown via `stopping` instead of re-running the whole sequence and
    // double-emitting 'org stopped' (duplicate org:complete/session:complete).
    this.orgs.delete(name);
    const p = this.finishStop(name, org, opts?.drainMs, opts?.closedBy);
    this.stopping.set(name, p);
    try {
      await p;
    } finally {
      this.stopping.delete(name);
    }
  }

  private async finishStop(
    name: string,
    org: RunningOrg,
    drainMs?: number,
    closedBy?: string,
  ): Promise<void> {
    // Process- and daemon-level handles come off FIRST, before anything that
    // can throw. These used to be removed after captureCheckpoint(), so a
    // throw there — which a half-started org can provoke, since it may be
    // missing state a checkpoint expects — aborted the whole stop and left a
    // process 'exit' listener, an interval and a broker lease behind for a run
    // that no longer exists. startOrg()'s teardown-on-failure path swallows a
    // rejecting stopOrg (it has its own error to report), so the leak was
    // silent.
    const cleanup = (org as RunningOrg & { _crashCleanup?: () => void })._crashCleanup;
    if (cleanup) process.removeListener('exit', cleanup);
    const wd = this.watchdogs.get(name);
    if (wd) {
      clearInterval(wd);
      this.watchdogs.delete(name);
    }
    clearIdleRecord(this.root, name);
    // The run's gates are authoritative; put them back over whatever the file
    // holds now (a role may have rewritten it).
    if (org.gates) {
      try {
        decisionOps.writeGates(this.root, name, org.gates);
      } catch {
        /* the next start reads the last write-through */
      }
    }
    this.leases.get(name)?.stop();
    this.leases.delete(name);
    // Capture THIS run's forwarder now: an autoWake-restart of the same org
    // during the long tail below (agent wait, flush, history write) would
    // register a NEW forwarder under the same name — settling/unsubscribing
    // that one would sever the new run's dashboard stream.
    const forwarder = this.forwarders.get(name);
    // Snapshot checkpoint BEFORE closing mailboxes / draining sessions — the
    // queue is emptied during the drain, so capturing afterwards loses all
    // unconsumed messages (the whole point of checkpoint-resume). Best-effort:
    // a run that cannot be checkpointed must still be stopped and cleaned up.
    let stopCheckpoint: ReturnType<typeof captureCheckpoint> | undefined;
    try {
      stopCheckpoint = captureCheckpoint(org, 'stopped');
    } catch (err) {
      console.error(
        `org ${name}: could not capture the stop checkpoint:`,
        err instanceof Error ? err.message : err,
      );
    }
    // #275: drop task dispatches still inside their coalescing window — the
    // mailboxes they target are closed on the next line anyway.
    for (const held of org.pendingDispatch?.values() ?? []) clearTimeout(held.timer);
    org.pendingDispatch?.clear();
    for (const a of org.agents.values()) a.mailbox.close();
    // Closing the mailbox stops new work being handed to a session, but does
    // NOT cancel a turn already in flight (e.g. mid provider call) — that
    // session can keep running, and eventually crash/finish, well past this
    // function's own bounded drain below. Abort each slot's live incarnation
    // too, reusing respawnRole's existing force-stop handle, so in-flight
    // work is told to stop now instead of merely being denied new input.
    for (const slot of org.roleSlots.values()) slot.abort?.abort();
    // M1: kill every tool-provider process of this org's sessions.
    this.toolProviders.closeOrg(name);
    // M2: stop endpoint retry timers (queued entries stay queued).
    stopEndpointRetries(this, name);
    // Bounded: a genuinely hung agent session (stuck mid-tool-call, not just
    // idle) must not make stopOrg() hang forever — callers like the scheduler
    // already race their own timeout around a run, and this wait re-blocking
    // unboundedly on the same never-resolving promises defeated that bound.
    // A planned completion is not an abort. The boss declaring the cycle done
    // says nothing about its siblings: they are routinely mid-build or mid-edit
    // when it fires, and a 15s window SIGTERM'd them (exit 143, reported as
    // "crashed") and threw the work away. allSettled resolves as soon as every
    // session ends, so a long drain is a ceiling, not a delay.
    const stopWaitMs = drainMs ?? this.opts.stopWaitMs ?? 15_000;
    const allDone = Promise.allSettled([...org.agents.values()].map((a) => a.done)).then(
      () => false,
    );
    // Clear the ceiling timer once the sessions win the race: left pending, a
    // COMPLETE_DRAIN_MS stop kept `org run` (which returns without
    // process.exit on a clean completion) alive for up to five minutes after
    // every session had already ended. Deliberately NOT unref'd — on the
    // timed-out path this timer may be the only thing keeping the loop alive
    // long enough to write 'stopped' to runtime.json and flush the bus.
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await Promise.race([
      allDone,
      new Promise<boolean>((r) => {
        drainTimer = setTimeout(() => r(true), stopWaitMs);
      }),
    ]);
    clearTimeout(drainTimer);
    if (timedOut) {
      // #152: "proceeding anyway" alone didn't say WHO got cut off — a run
      // reviewer had no way to tell whether real, in-progress work (a
      // mid-build, a mid-write) was force-stopped, or the drain window
      // simply outlived a handful of already-idle sessions. status is only
      // 'ended'/'crashed' once a role's session promise has actually
      // settled; still 'running' here means it was mid-turn when the
      // ceiling hit, not merely idle-but-not-yet-reaped.
      const stillActive = [...org.agents.entries()]
        .filter(([, a]) => a.status === 'running')
        .map(([roleId]) => roleId);
      const rosterSuffix = stillActive.length ? ` — still active: ${stillActive.join(', ')}` : '';
      org.bus.emit({
        type: 'audit',
        msg: `org stop timed out after ${stopWaitMs}ms waiting for agent sessions to finish — proceeding anyway${rosterSuffix}`,
        reason: 'stop-timeout',
        data: { stillActive },
      });
      // Reap only SDK processes spawned by THIS node process — ownerPid filter
      // ensures other `monomind org run` daemons' agents are untouched.
      try {
        const reaped = reapOrphanedSdkProcesses(new Set(), process.pid);
        if (reaped > 0)
          org.bus.emit({
            type: 'audit',
            reason: 'orphan-reap',
            msg: `reaped ${reaped} orphaned SDK process(es) after stop timeout`,
          });
      } catch {
        /* best-effort */
      }
    }
    // The run's sessions are gone: take down the sandbox stubs it held.
    sandboxStubs.release(`${name}:${org.run}`);
    // #302 truth gate: every stop path funnels through here, so this is the
    // one place that can record how the run ACTUALLY ended, regardless of
    // which of the five paths triggered it. `closedBy` is undefined only for
    // a bare manual `stopOrg(name)` (CLI `org stop`, shutdown) — every
    // automated path above now tags its own real cause. reporting.ts reads
    // this event (reason: 'org-stopped') to decide whether the run's outcome
    // may be rendered as a boss-attributed 'partial'/'achieved' at all: only
    // closedBy === 'org-complete' may be.
    const runnableTasks = org.taskDag?.pendingTaskCount() ?? 0;
    // Rendered, not just recorded (#302 AC6, same reasoning as the
    // blockerSuffix above): `org logs` prints `msg` verbatim.
    const stopSuffix =
      closedBy && closedBy !== 'org-complete'
        ? ` (${closedBy}${runnableTasks > 0 ? `, ${runnableTasks} task(s) left` : ''})`
        : '';
    org.bus.emit({
      type: 'status',
      reason: 'org-stopped',
      msg: `org stopped${stopSuffix}`,
      data: { closedBy, runnableTasks },
    });
    await org.bus.flush();
    // Append this run's summary to <org>/history.jsonl — read back from the
    // flushed bus.jsonl (the full durable record) rather than the bounded
    // in-memory buffer, so long runs summarize completely.
    //
    // This block runs BEFORE the seal below (#293): storeRunMemory emits an
    // audit event when the run's memory could not be stored, and a sealed bus
    // fans out to in-memory listeners without ever reaching bus.jsonl — an
    // event the live view shows and the durable record does not, which is both
    // the divergence test-loop's `persisted` check exists to catch and useless
    // to whoever reads the run back later. Sealing after it keeps every emitted
    // event durable. The seal still closes before this function returns, which
    // is what its own contract (below) is about.
    try {
      const events = readRunEvents(this.root, name, org.run);
      if (events.length) {
        const summary = summarizeRun(events);
        const { appendFileSync } = await import('node:fs');
        appendFileSync(historyFile(this.root, name), `${JSON.stringify(summary)}\n`, 'utf8');
        // Cross-run memory: make this run's outcome recallable by meaning.
        // #293: the result is CHECKED — a store that silently did nothing used
        // to be indistinguishable from one that worked, and the symptom
        // (org_recall always empty) showed up runs later with no trail. The
        // reason is stashed for persistState() below so runtime.json — and
        // therefore `org status` — carries it after the bus event and the
        // stderr warning have scrolled away.
        const memory = await this.storeRunMemory(name, org.def, org.run, summary, org.bus);
        if (memory.stored) this.memoryErrors.delete(name);
        else this.memoryErrors.set(name, memory.reason ?? 'unknown');
      }
    } catch (err) {
      console.error(
        `org ${name}: could not write run history:`,
        err instanceof Error ? err.message : err,
      );
    } finally {
      this.recallUsage.delete(name);
      this.orgLearnedRuns.delete(`${name}:${org.run}`);
    }
    // flush() only awaits a snapshot of writes queued at call time (see its
    // own doc comment) — it has no visibility into a session that crashes
    // after the abort signal above but before this function returns. Seal
    // the bus now so any such late bus.emit() still reaches in-memory
    // listeners but can never schedule a new disk write into a run
    // directory a caller (e.g. a test's afterEach) may already be deleting.
    // seal() awaits the pending writes first, so the audit event the block
    // above may have emitted is on disk before the bus closes.
    await org.bus.seal();
    // the "org stopped" event above triggers the forwarder's final org:complete /
    // session:complete POST — without waiting for it here, the CLI process can exit
    // (and kill the in-flight fetch) before that last event reaches the dashboard,
    // leaving the run stuck showing "running" forever. Bounded: a stalled
    // dashboard must not hang org shutdown indefinitely.
    if (forwarder) {
      await Promise.race([
        forwarder.settle(),
        new Promise<void>((r) => {
          const t = setTimeout(r, 5_000);
          (t as { unref?: () => void }).unref?.();
        }),
      ]);
      forwarder.unsubscribe();
      // Only remove from the map if it's still OURS — an autoWake-restart may
      // have registered the new run's forwarder under this name meanwhile.
      if (this.forwarders.get(name) === forwarder) this.forwarders.delete(name);
    }
    // Same guard for runtime.json: if a new run started during shutdown, its
    // 'running' record must not be overwritten with this old run's 'stopped'.
    // Pass the org directly since we already removed it from the map.
    if (!this.orgs.has(name))
      this.persistState(name, 'stopped', org.run, org, stopCheckpoint, closedBy);
    // Clean up git worktrees — shared (workspace: 'worktree') and per-role.
    try {
      const { execFileSync } = await import('node:child_process');
      if (org.worktreePath) {
        try {
          execFileSync('git', ['worktree', 'remove', '--force', org.worktreePath], {
            cwd: this.root,
            stdio: 'ignore',
            timeout: 30_000,
          });
        } catch {
          /* best-effort */
        }
      }
      for (const agent of org.agents.values()) {
        if (agent.worktreePath) {
          try {
            execFileSync('git', ['worktree', 'remove', '--force', agent.worktreePath], {
              cwd: this.root,
              stdio: 'ignore',
              timeout: 30_000,
            });
          } catch {
            /* best-effort */
          }
        }
      }
      // #301: roles create their own linked worktrees with Bash (paths the
      // daemon never recorded — org.worktreePath/agent.worktreePath above are
      // only ever set for workspace: 'worktree'/'worktree-per-role', empty
      // for the common workspace: 'repo' shape), and deleting the working
      // directory from inside a role sandbox leaves .git/worktrees/<name>
      // behind — `git worktree list` then hides it, and it never gets
      // cleaned up. Unconditional on purpose: gating this on
      // org/agent.worktreePath would skip exactly the runs that hit the bug.
      // prune only drops metadata whose worktree directory is already gone,
      // so a live worktree — including the owner's — is never touched; it is
      // idempotent; and the two removals just above already run `git
      // worktree remove --force` against this same repo from this same cwd,
      // so this is strictly less invasive than what already ships. Run after
      // both removal loops so a worktree just removed is also pruned.
      //
      // Bounded race, measured rather than assumed (same treatment as the
      // SIGKILL case above): an entry whose `gitdir` file is absent is
      // pruned unconditionally, and `--expire` cannot protect it — measured
      // across every window from `--expire=now` to `--expire=3.months.ago`,
      // a fresh no-gitdir entry is removed regardless, while `--expire` also
      // makes an already-deleted worktree SURVIVE, breaking the "a run
      // always begins clean" guarantee this fix exists to provide. So a
      // concurrent `git worktree add` by another process in this repo is
      // vulnerable for the microseconds between its `mkdir` and its
      // `gitdir` write. A mid-creation state cannot persist longer than
      // that, so an entry found in that state is dead metadata, not a live
      // worktree in progress.
      try {
        execFileSync('git', ['worktree', 'prune'], {
          cwd: this.root,
          stdio: 'ignore',
          timeout: 30_000,
        });
      } catch {
        /* best-effort: not a git repo, git missing, or a wedged hook */
      }
    } catch {
      /* node:child_process unavailable — skip */
    }
  }

  async stopAll(): Promise<void> {
    await Promise.all([
      ...[...this.orgs.keys()].map((n) => this.stopOrg(n)),
      ...this.stopping.values(), // detached self-stops still flushing
    ]);
  }

  /** @internal
   *  @param closedBy #206: why the run ended — 'org-complete' for a clean,
   *  goal-driven end (the only value any caller currently passes); absent for
   *  every other stop (idle watchdog, boss-restart-exhausted, manual `org
   *  stop`). Mirrors persistCrashStateAll()'s existing closedBy: 'crash-handler'
   *  for the process-crash path, which org.ts already reads. */
  persistState(
    name: string,
    status: string,
    run: string,
    org?: RunningOrg,
    checkpointOverride?: OrgCheckpoint | null,
    closedBy?: string,
  ): void {
    const p = join(this.root, ORG_DIR, name, 'runtime.json');
    const missing = [...(this.abandoned.get(name) ?? [])];
    const memoryError = this.memoryErrors.get(name);
    const running = org ?? this.orgs.get(name);
    const validStatus = status === 'stopped' || status === 'crashed' ? status : 'running';
    // Pattern 3: Capture full checkpoint state for resume. On stop, finishStop
    // passes a snapshot captured BEFORE mailboxes close and sessions drain —
    // otherwise the queue is always empty by persist time.
    let checkpoint: OrgCheckpoint | null = checkpointOverride ?? null;
    if (!checkpoint && running) {
      // Best-effort, like the snapshot in finishStop: persisting the run's
      // state matters more than the resume checkpoint inside it, and a stop
      // must not fail because a checkpoint could not be built.
      try {
        checkpoint = captureCheckpoint(running, validStatus as 'running' | 'stopped' | 'crashed');
      } catch (err) {
        console.error(
          `org ${name}: could not capture the ${validStatus} checkpoint:`,
          err instanceof Error ? err.message : err,
        );
        checkpoint = null;
      }
    } else if (checkpoint && checkpoint.status !== validStatus) {
      const { checksum: _, ...state } = checkpoint;
      checkpoint = {
        ...state,
        status: validStatus as 'running' | 'stopped' | 'crashed',
        checksum: generateChecksum({
          ...state,
          status: validStatus as 'running' | 'stopped' | 'crashed',
        }),
      };
    }
    // C4: writeJsonFileAtomic (tmp + rename) — a direct writeFileSync here
    // could leave runtime.json truncated on Ctrl-C during `org stop`, which
    // would brick every subsequent `org status` / isOrgRunning / scheduler
    // call. The state files in 6 other daemon paths already use this helper.
    writeJsonFileAtomic(p, {
      status,
      run,
      pid: process.pid,
      updated: new Date().toISOString(),
      ...(missing.length ? { abandonedRoles: missing } : {}),
      ...(memoryError ? { memoryError } : {}),
      ...(checkpoint ? { checkpoint } : {}),
      ...(closedBy ? { closedBy } : {}),
    });
  }

  /** Mark every currently-running org as crashed in runtime.json.
   *  Called from process-level crash handlers — must be synchronous and best-effort.
   *  @param error the uncaught error/rejection reason, if known — without
   *  this, `runOutcomeResult` (org.ts)'s "crashed: <error>" message always
   *  read "crashed: unknown error" regardless of what actually happened. */
  persistCrashStateAll(error?: string): void {
    for (const [name, org] of this.orgs) {
      try {
        const p = join(this.root, ORG_DIR, name, 'runtime.json');
        // Capture separately from the write below: a throw here (e.g. a
        // cyclic structure in roleState reaching generateChecksum) must not
        // suppress the base crash record, which is the actually-important
        // best-effort write this method exists for.
        let checkpoint: ReturnType<typeof captureCheckpoint> | undefined;
        try {
          checkpoint = captureCheckpoint(org, 'crashed');
        } catch {
          /* best effort — proceed without a checkpoint */
        }
        // C4: atomic write — crash handler is the most likely place to hit
        // a partial write since the process is mid-teardown.
        writeJsonFileAtomic(p, {
          status: 'crashed',
          run: org.run,
          pid: process.pid,
          updated: new Date().toISOString(),
          closedBy: 'crash-handler',
          ...(checkpoint ? { checkpoint } : {}),
          ...(error ? { error } : {}),
        });
      } catch {
        /* best effort — filesystem may be unavailable */
      }
    }
  }

  private heartbeatPath(): string {
    return join(this.root, '.monomind', 'serve-heartbeat.json');
  }

  /** Write a heartbeat file so `org status` can distinguish "daemon alive" from
   *  "daemon gone" even when runtime.json still says running. */
  writeHeartbeat(): void {
    try {
      const p = this.heartbeatPath();
      mkdirSync(join(this.root, '.monomind'), { recursive: true });
      // C4: atomic write — heartbeat corruption is how `org status` reports
      // a phantom daemon after a crash.
      writeJsonFileAtomic(p, {
        pid: process.pid,
        updatedAt: new Date().toISOString(),
        running: this.listRunning(),
      });
    } catch {
      /* best effort */
    }
  }

  clearHeartbeat(): void {
    try {
      unlinkSync(this.heartbeatPath());
    } catch {
      /* already gone or never written */
    }
  }

  // ── Delegated methods — extracted to focused modules ──────────────────

  // approvals.ts
  /** @internal */
  checkApproval(
    org: string,
    role: string,
    action: string,
    input: Record<string, unknown>,
  ): Promise<boolean | null> {
    return approvalOps.checkApproval(this, org, role, action, input);
  }
  async setApproval(
    org: string,
    role: string,
    action: string,
    approved: boolean,
    opts?: approvalOps.ApprovalResolveOpts,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    return approvalOps.setApproval(this, org, role, action, approved, opts);
  }

  // questions.ts
  async askHuman(org: string, role: string, question: string, blocking?: boolean): Promise<string> {
    return questionOps.askHuman(this, org, role, question, blocking);
  }
  async answerQuestion(
    org: string,
    role: string,
    questionId: string,
    answer: string,
    resolvedBy?: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    return questionOps.answerQuestion(this, org, role, questionId, answer, resolvedBy);
  }

  // decisions.ts
  /** @internal */
  readGates(org: string): { gates: DecisionGate[] } {
    return decisionOps.gatesFor(this, org);
  }
  async createGate(org: string, role: string, name: string, description: string): Promise<string> {
    return decisionOps.createGate(this, org, role, name, description);
  }
  async resolveGate(
    org: string,
    gateId: string,
    approved: boolean,
    resolution?: string,
    resolvedBy?: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    return decisionOps.resolveGate(this, org, gateId, approved, resolution, resolvedBy);
  }
  listGates(org: string, status?: 'pending' | 'approved' | 'rejected'): DecisionGate[] {
    return decisionOps.listGates(this, org, status);
  }
  /** @internal */
  dagCreateTask(
    org: string,
    role: string,
    title: string,
    assignee: string,
    deps: string[],
    loadout?: string,
    brief?: string,
    pick?: TaskPick,
  ): string {
    return decisionOps.dagCreateTask(this, org, role, title, assignee, deps, loadout, brief, pick);
  }
  /** @internal */
  dagCompleteTask(
    org: string,
    role: string,
    taskId: string,
    result?: string,
    evidence?: TaskEvidence,
  ): string {
    return decisionOps.dagCompleteTask(this, org, role, taskId, result, evidence);
  }
  /** ADR-O001 D6 — see decisions.ts's dagRequestReview. */
  dagRequestReview(
    org: string,
    role: string,
    taskId: string,
    reviewer: string,
    base?: string,
  ): string {
    return decisionOps.dagRequestReview(this, org, role, taskId, reviewer, base);
  }
  /** @internal */
  dagSplitTask(
    org: string,
    role: string,
    parentId: string,
    children: { title: string; assignee: string }[],
  ): string {
    return decisionOps.dagSplitTask(this, org, role, parentId, children);
  }
  /** @internal */
  dagMergeTask(org: string, role: string, sourceId: string, targetId: string): string {
    return decisionOps.dagMergeTask(this, org, role, sourceId, targetId);
  }
  /** @internal */
  dagCancelTask(org: string, role: string, taskId: string, reason?: string): string {
    return decisionOps.dagCancelTask(this, org, role, taskId, reason);
  }
  /** @internal */
  dagBlockTask(
    org: string,
    role: string,
    taskId: string,
    untilIso: string,
    reason?: string,
    recheckAfterMinutes?: number,
  ): string {
    return decisionOps.dagBlockTask(this, org, role, taskId, untilIso, reason, recheckAfterMinutes);
  }
  /** @internal */
  dagPlanGraph(org: string, role: string, specs: decisionOps.PlanTaskSpec[]): string {
    return decisionOps.dagPlanGraph(this, org, role, specs);
  }
  recordDecision(
    org: string,
    role: string,
    decision: {
      type: 'tool' | 'handoff' | 'approval' | 'routing';
      kind: DecisionKind;
      context: string;
      reasoning: string;
      alternatives?: Array<{ choice: string; score: number; reason: string }>;
      outcome: string;
    },
  ): void {
    decisionOps.recordDecision(this, org, role, decision);
  }

  // cross-org.ts
  async deliver(
    fromOrg: string,
    fromRole: string,
    to: string,
    subject: string,
    body: string,
  ): Promise<string> {
    return crossOrg.deliver(this, fromOrg, fromRole, to, subject, body);
  }
  receiveRemote(
    toOrg: string,
    toRole: string,
    fromQualified: string,
    subject: string,
    body: string,
    fromCredential?: string,
    opts?: crossOrg.ReceiveRemoteOpts,
  ): Promise<{ ok: true; receipt: string } | { ok: false; error: string }> {
    return crossOrg.receiveRemote(
      this,
      toOrg,
      toRole,
      fromQualified,
      subject,
      body,
      fromCredential,
      opts,
    );
  }

  // runtime-options.ts
  listRuntimeOptions(): Promise<RuntimeOptionsReceipt> {
    return buildRuntimeOptions(this.root);
  }

  // scheduler-integration.ts
  /** @internal */
  autoWake(name: string): void {
    scheduler.autoWake(this, name);
  }
  /** @internal */
  scheduleBossRestart(name: string): void {
    scheduler.scheduleBossRestart(this, name);
  }
  /** @internal */
  scheduleDeferredSpawn(
    name: string,
    running: RunningOrg,
    role: OrgRole,
    spawnRole: (role: OrgRole) => void,
  ): void {
    scheduler.scheduleDeferredSpawn(this, name, running, role, spawnRole);
  }
  /** Bug 4: mirrors scheduleDeferredSpawn, but for a role deferred because the
   *  org is already at run_config.max_concurrent_agents rather than under host
   *  resource pressure — see scheduleConcurrencyDeferredSpawn's doc comment. */
  /** @internal */
  scheduleConcurrencyDeferredSpawn(
    name: string,
    running: RunningOrg,
    role: OrgRole,
    spawnRole: (role: OrgRole) => void,
  ): void {
    scheduler.scheduleConcurrencyDeferredSpawn(this, name, running, role, spawnRole);
  }

  // org-memory.ts
  private orgMemoryNamespace(name: string, def: OrgDef): string {
    return orgMemory.orgMemoryNamespace(name, def);
  }
  /** @internal */
  orgMemoryDbPath(): string {
    return orgMemory.orgMemoryDbPath(this.root);
  }
  /** @internal */
  orgMemoryUsable(): Promise<boolean> {
    return orgMemory.orgMemoryUsable(this.root);
  }
  /** @internal */
  async rememberOrgMemory(
    name: string,
    def: OrgDef,
    role: string,
    content: string,
    scope: 'org' | 'agent',
    run: string,
  ): Promise<string> {
    return orgMemory.rememberOrgMemory(this.root, name, def, role, content, scope, run);
  }
  /** @internal */
  async recallOrgMemory(
    name: string,
    def: OrgDef,
    query: string,
    role?: string,
  ): Promise<{ text: string; hits: number }> {
    return orgMemory.recallOrgMemory(this, name, def, query, role);
  }
  async searchProjectKnowledge(query: string): Promise<{ text: string; hits: number }> {
    return orgMemory.searchProjectKnowledge(this.root, query);
  }
  /** @internal */
  async learnOrgKnowledge(
    name: string,
    run: string,
    payload: { nodes?: unknown[]; edges?: unknown[]; rules?: unknown[] },
  ): Promise<string> {
    return orgMemory.learnOrgKnowledge(this, name, run, payload);
  }
  private async storeRunMemory(
    name: string,
    def: OrgDef,
    run: string,
    summary: RunSummary,
    bus?: OrgBus,
  ): Promise<orgMemory.RunMemoryResult> {
    return orgMemory.storeRunMemory(this, name, def, run, summary, bus);
  }

  // checkpoint-ops.ts
  async replayFrom(name: string, run: string): Promise<RunningOrg | null> {
    return checkpointOps.replayFrom(this, name, run);
  }
  async resumeOrg(name: string): Promise<RunningOrg | null> {
    return checkpointOps.resumeOrg(this, name);
  }
}
