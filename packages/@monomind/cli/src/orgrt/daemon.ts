// packages/@monomind/cli/src/orgrt/daemon.ts
// monolean: single-process inter-org — upgrade path = daemon-to-daemon HTTP when multi-host is real

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { resolveOrgDefBlueprints } from '../catalog/blueprints.js';
// ── Extracted module imports ────────────────────────────────────────────
import * as approvalOps from './approvals.js';
import type { BrokerLease } from './broker.js';
import { reopenBudgetClosedRoles, rolesOnDefTokenCaps } from './budget-closure.js';
import type { OrgBus } from './bus.js';
import type { OrgCheckpoint, RoleCheckpoint } from './checkpoint.js';
import * as checkpointOps from './checkpoint-ops.js';
import type { TaskEvidence } from './completion-gate.js';
import * as crossOrg from './cross-org.js';
import type { AgentRuntime, DaemonOpts, RunningOrg } from './daemon-types.js';
import * as decisionOps from './decisions.js';
import { isEndpointRole } from './endpoint-roles.js';
import type { attachForwarder } from './forwarder.js';
import * as orgMemory from './org-memory.js';
import * as orgStart from './org-start.js';
import * as orgStateFile from './org-state-file.js';
import * as orgStop from './org-stop.js';
import { expandOrgPolicyPathVars, promptVarsFor } from './prompt-vars.js';
import * as questionOps from './questions.js';
import type { RunSummary } from './reporting.js';
import * as roleIncarnation from './role-incarnation.js';
import * as roleRespawn from './role-respawn.js';
import { computeReplacementBudget, type RespawnReceipt } from './role-slot.js';
import { currentRoleTrace, type RoleTrace } from './role-trace.js';
import { buildRuntimeOptions, type RuntimeOptionsReceipt } from './runtime-options.js';
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
    return orgStop.stopOrg(this, name, opts);
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
    orgStateFile.persistState(this, name, status, run, org, checkpointOverride, closedBy);
  }

  /** Mark every currently-running org as crashed in runtime.json.
   *  Called from process-level crash handlers — must be synchronous and best-effort.
   *  @param error the uncaught error/rejection reason, if known — without
   *  this, `runOutcomeResult` (org.ts)'s "crashed: <error>" message always
   *  read "crashed: unknown error" regardless of what actually happened. */
  persistCrashStateAll(error?: string): void {
    orgStateFile.persistCrashStateAll(this, error);
  }

  /** Write a heartbeat file so `org status` can distinguish "daemon alive" from
   *  "daemon gone" even when runtime.json still says running. */
  writeHeartbeat(): void {
    orgStateFile.writeHeartbeat(this);
  }

  clearHeartbeat(): void {
    orgStateFile.clearHeartbeat(this);
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
  /** @internal */
  async storeRunMemory(
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
