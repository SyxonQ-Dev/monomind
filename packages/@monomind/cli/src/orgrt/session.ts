import type { AgentMessage, AgentRunner } from './agent-runner.js';
import { ClaudeAgentRunner, defaultClaudeRunner } from './agent-runner.js';
import {
  CLAUDE_SANDBOX_CWD_ENV,
  claudeBashTimeoutEnv,
  claudeSandboxCwdNote,
} from './bash-timeout.js';
import type { OrgBus } from './bus.js';
import { Mailbox } from './mailbox.js';
import type { TokenUsage } from './policy.js';
import { summarizeToolOutput } from './policy.js';
import { FaultRestarts, ProcessFaultError } from './sandbox-fault.js';
import { sandboxStubPaths, sandboxStubs } from './sandbox-stubs.js';
import { StateDetector } from './state-detector.js';
import {
  linkAbort,
  queueCancelNotice,
  TaskCancelledError,
  trackTaskProcess,
} from './task-cancel.js';
import type { ToolResultEventData } from './types.js';

/** How long an SDK stream may stay open with zero messages before we say so.
 *  Comfortably longer than a slow first turn, shorter than the idle watchdog's
 *  10-minute window so the specific cause is reported before the generic
 *  "boss appears hung". */
const SILENT_SESSION_MS = 4 * 60_000;
const CONTEXT_LIMIT_RE = /context.window.limit|context.length.exceeded|maximum.context/i;

import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ensureAuthorityDirs } from './authority-mask.js';
import { resolveRoleCostTier } from './cost-tier.js';
import { CumulativeMeter } from './cumulative-meter.js';
import type { StreamOptions } from './mailbox.js';
import { buildOrgTools } from './org-tools.js';
import { resolveProviderEnv, resolveRoleProvider } from './provider.js';
import { resolveRoleGitEnforcement, roleAuthorityMask } from './role-sandbox.js';
import { gatedCanUseTool } from './session-gate.js';
import type { SessionStartReason } from './session-ledger.js';
import {
  mailRouteKey,
  ROLE_SESSION_KEY,
  resolveSessionScope,
  SessionLedger,
} from './session-ledger.js';
import { resolveModel, rolePromptFor } from './session-prompt.js';
import type { SessionOpts } from './session-types.js';

export { gatedCanUseTool } from './session-gate.js';
export {
  buildRolePrompt,
  resolveModel,
  resolveRoleExtraGuidance,
} from './session-prompt.js';
export type { DeliverFn, SessionOpts } from './session-types.js';

/**
 * Runs a role for the life of the org, transparently restarting the
 * underlying SDK session whenever it ends on its own (`maxTurns` reached)
 * while the mailbox is still open. `maxTurns` bounds a single SDK query()
 * call's TOTAL turns, not "turns per incoming message" - since one query()
 * call stays open across every mailbox message for as long as the mailbox
 * itself stays open, without a restart the role would go permanently silent
 * (no crash, no alert) once its lifetime turn count crossed the limit, while
 * deliver() kept queuing new messages into a mailbox nobody was reading.
 */
export async function runAgentSession(opts: SessionOpts): Promise<void> {
  // `emit()` intentionally does not block agents on disk I/O, but a completed
  // session is a lifecycle boundary: callers may immediately summarize a run,
  // stop its daemon, or remove an isolated workspace.  Do not let queued bus
  // writes outlive that boundary (which could otherwise lose terminal events
  // or race cleanup of the run directory).
  try {
    await runAgentSessionLoop(opts);
  } finally {
    await opts.bus.flush();
  }
}

async function runAgentSessionLoop(opts: SessionOpts): Promise<void> {
  const { mailbox } = opts;
  // Carries the SDK's own session_id across a maxTurns restart so the next
  // query() call resumes the prior conversation instead of starting cold -
  // without this, a restart silently discarded all in-progress reasoning.
  // Seeded from opts.resumeSessionId (a checkpoint's persisted sessionId) when
  // this is a checkpoint resume, not a fresh run — P2-13.
  let resumeSessionId: string | undefined = opts.resumeSessionId;
  // #149: a resumeSessionId seeded from a persisted checkpoint (org run
  // --resume) points at an SDK session that may no longer exist on the
  // provider's side by the time resume happens — hours can pass between
  // `org stop` and `org run --resume`. Track whether we've already tried
  // falling back to a fresh session for THIS specific session id, so a
  // stale checkpoint session gets one recovery attempt instead of crashing
  // the whole role outright, but a second failure (a real, non-staleness
  // error) still crashes normally rather than looping forever.
  const initialResumeSessionId = opts.resumeSessionId;
  let triedFreshAfterResumeFailure = false;
  // #1: when a session ends on the turn limit mid-work, push a continuation so
  // the restarted query() has input to act on instead of blocking on an empty
  // mailbox until the 10-minute idle watchdog. Bounded: if the role consumed no
  // real message since the last restart (it is spinning on its own
  // continuations), stop auto-pushing after MAX_CONTINUATIONS and let the
  // watchdog re-engage — so a stuck role can't burn tokens forever.
  const MAX_CONTINUATIONS = 3;
  let consecutiveSpin = 0;
  // The SDK's result message reports total_cost_usd CUMULATIVELY for the whole
  // SDK session: one query() call stays open across every mailbox message
  // (streaming-input mode) and emits one result per message, and the running
  // total can survive a resume after a restart. daemon.ts and
  // reporting.ts both SUM the cost_usd of usage events, so forwarding the raw
  // value charged every previous turn again on each new message - observed as
  // ~10-20x cost inflation on long org runs. The meter outlives individual
  // runOneSession calls and emits only deltas; see cumulative-meter.ts for why
  // it is also told when a new process starts.
  const sessionCostTotals = new CumulativeMeter<{ usd: number }>();
  // ADR-O001 D1: modelUsage is cumulative per session exactly like
  // total_cost_usd, so it needs the same meter to become a delta.
  const sessionTokenTotals = new CumulativeMeter<TokenUsage>();
  // bwrap errors and a closed tool permission channel restart the process, bounded (sandbox-fault.ts).
  const faultRestarts = new FaultRestarts({
    bus: opts.bus,
    roleId: opts.role.id,
    coordinator: opts.role.reports_to ?? undefined,
    deliver: (from, to, subject, body) => sessionOpts.deliver(from, to, subject, body),
  });
  // ADR-O001 D3. 'role' scope (the default) keeps the pre-D3 loop exactly: one
  // model session for the role's life, resumed across maxTurns restarts via
  // resumeSessionId. 'task' scope keys model sessions by the task a message
  // belongs to: the process exits at a task boundary (or on idle) and the next
  // one resumes that task's session from the ledger. Either way every session
  // run is recorded with its session id before and after.
  const scope = resolveSessionScope(opts.role, opts.def);
  const idleExitMs = (opts.def?.run_config as { session_idle_exit_ms?: number } | undefined)
    ?.session_idle_exit_ms;
  const ledger = opts.sessionLedger ?? new SessionLedger();
  const runtimeKey = opts.role.runtime ?? opts.def?.runtime ?? 'claude';
  let taskKey = ROLE_SESSION_KEY;
  // Why the next fresh session for a key is fresh, when the loop itself threw
  // the record away (stale resume, turn-limit error) — recorded, not guessed.
  const droppedBecause = new Map<string, SessionStartReason>();
  const staleTried = new Set<string>();
  // The options THIS session is built from — the role's own, except that a
  // task-scoped session carries its task's loadout (D7).
  let sessionOpts: SessionOpts = opts;
  let promptHash = '*';
  // Task scope: which task last wrote to each correspondent, so their
  // untagged reply goes back to that task's session (see mailRouteKey).
  const correspondents = new Map<string, string>();
  // Always run at least once: a mailbox can be closed with queued items still
  // pending (stream() drains the queue before honoring `closed`), which is a
  // normal, valid starting state - checking isClosed before the first run
  // would skip that drain entirely.
  while (true) {
    // Opt-in only: keep the process DOWN until there is mail, instead of
    // starting a query() that parks on an empty mailbox. waitForMessage()
    // still returns true for a closed mailbox with queued items.
    if (scope !== 'role' || idleExitMs !== undefined) {
      if (!(await mailbox.waitForMessage())) return;
    }
    let startReason: SessionStartReason;
    if (scope === 'cold') {
      // D6: nothing carries over — not a checkpointed session, not the last
      // message's. Paying the cache miss here is the point.
      resumeSessionId = undefined;
      startReason = 'fresh-cold';
    } else if (scope === 'task') {
      // An untagged message (mail, an answer, a continuation) belongs to the
      // session the role is already in.
      taskKey = mailRouteKey(mailbox.peek() ?? '', correspondents) ?? taskKey;
      const key = taskKey;
      sessionOpts = {
        ...opts,
        // D7: this task's session is built with this task's loadout.
        ...(key !== ROLE_SESSION_KEY && opts.loadoutFor ? { loadout: opts.loadoutFor(key) } : {}),
        // Mail sent from a task's session names the task in its subject, so
        // the reader knows what it is about and a reply can find its way back.
        deliver: (from, to, subject, body) => {
          if (key === ROLE_SESSION_KEY) return opts.deliver(from, to, subject, body);
          correspondents.set(to, key);
          const tagged = subject.includes('[task:') ? subject : `[task:${key}] ${subject}`;
          return opts.deliver(from, to, tagged, body);
        },
      };
      promptHash = createHash('sha256')
        .update(rolePromptFor(sessionOpts))
        .digest('hex')
        .slice(0, 16);
      const pick = ledger.resumeFor({
        role: opts.role.id,
        runtime: runtimeKey,
        taskKey,
        cwd: opts.cwd,
        promptHash,
      });
      resumeSessionId = pick.sessionId;
      startReason =
        pick.reason === 'fresh-no-record'
          ? (droppedBecause.get(taskKey) ?? pick.reason)
          : pick.reason;
    } else {
      startReason = resumeSessionId ? 'resumed' : 'fresh-no-record';
    }
    const sessionKey = taskKey;
    const streamOpts: StreamOptions | undefined =
      scope === 'cold'
        ? { stopBefore: () => true, idleExitMs }
        : scope === 'task'
          ? {
              stopBefore: (next) => {
                const k = mailRouteKey(next, correspondents);
                return k !== undefined && k !== sessionKey;
              },
              idleExitMs,
            }
          : idleExitMs !== undefined
            ? { idleExitMs }
            : undefined;
    const sessionIdBefore = resumeSessionId;
    const startedAt = Date.now();
    const recordRun = (after: string | undefined, error?: string): void => {
      const run = ledger.recordRun({
        role: opts.role.id,
        runtime: runtimeKey,
        taskKey: sessionKey,
        sessionIdBefore,
        sessionIdAfter: after,
        reason: startReason,
        startedAt,
        endedAt: Date.now(),
        ...(error ? { error } : {}),
      });
      opts.bus.emit({
        type: 'audit',
        from: opts.role.id,
        reason: 'session-run',
        msg: `session ${run.resumed ? 'resumed' : 'started fresh'} (${startReason}) for ${sessionKey}`,
        data: run as unknown as Record<string, unknown>,
      });
    };
    const realBefore = mailbox.consumedRealCount;
    let sessionId: string | undefined;
    let hitTurnLimit: boolean | undefined = false;
    const attempt = { replied: false };
    // Task scope: this process works on one task, so cancelling it ends it.
    const tracked = trackTaskProcess(opts.taskProcesses, scope, sessionKey);
    try {
      const res = await runOneSession(
        sessionOpts,
        resumeSessionId,
        sessionCostTotals,
        attempt,
        sessionTokenTotals,
        streamOpts,
        faultRestarts.watch(sessionKey),
        tracked?.signal,
      );
      // Cancelled as the process was ending on its own: still owed the notice.
      if (tracked?.signal.aborted) throw tracked.signal.reason;
      sessionId = res.sessionId;
      hitTurnLimit = res.hitTurnLimit;
      resumeSessionId = sessionId;
      recordRun(sessionId);
      if (scope === 'task' && sessionId) {
        droppedBecause.delete(sessionKey);
        ledger.set({
          role: opts.role.id,
          runtime: runtimeKey,
          taskKey: sessionKey,
          cwd: opts.cwd,
          promptHash,
          sessionId,
        });
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      recordRun(undefined, errMsg);
      // #304 (review round 3): an org's own stop aborts whatever this attempt
      // was doing — max-turns and stale-resume below are diagnoses for a
      // genuinely failed attempt, not for one the org itself just cut off.
      // Both branches SWALLOW (the loop continues or returns normally instead
      // of rethrowing), so if either fired during a stop the daemon's role
      // loop never runs its catch at all: no agent-stopped, no crash audit —
      // runAgentSession simply resolves. Excluding a stop/external-abort from
      // both conditions lets the error fall through to `else { throw err; }`
      // instead, so the daemon classifies it the same way it classifies every
      // other abort during a stop. Neither branch's own "retry"/"continue"
      // promise is worth anything once the mailbox is closed anyway — the
      // very next check below (`mailbox.isClosed || mailbox.isDraining`)
      // returns immediately — so rethrowing here costs nothing.
      const stopping = mailbox.isClosed || (opts.externalAbort?.signal.aborted ?? false);
      if (!stopping && err instanceof TaskCancelledError) {
        // Its work is abandoned: the notice starts a fresh, small session.
        sessionId = undefined;
        resumeSessionId = undefined;
        ledger.drop({ role: opts.role.id, runtime: runtimeKey, taskKey: sessionKey });
        queueCancelNotice(err, mailbox, opts.bus, opts.role.id, sessionKey);
      } else if (!stopping && err instanceof ProcessFaultError) {
        // Same session, new process: resume it and tell the role why.
        resumeSessionId = err.sessionId ?? resumeSessionId;
        if (scope === 'task' && err.sessionId) {
          ledger.set({
            role: opts.role.id,
            runtime: runtimeKey,
            taskKey: sessionKey,
            cwd: opts.cwd,
            promptHash,
            sessionId: err.sessionId,
          });
        }
        mailbox.push(faultRestarts.restarted(sessionKey, err.kind));
      } else if (!stopping && /Reached maximum number of turns|error_max_turns/i.test(errMsg)) {
        // Runner/SDK threw an error on max turns or exhausted turns on resume.
        // Drop the dead resumeSessionId and grant continuation turn with fresh session.
        sessionId = undefined;
        resumeSessionId = undefined;
        hitTurnLimit = true;
        if (scope === 'task') {
          ledger.drop({ role: opts.role.id, runtime: runtimeKey, taskKey: sessionKey });
          droppedBecause.set(sessionKey, 'fresh-after-turn-limit');
        }
      } else if (
        !stopping &&
        scope === 'task' &&
        sessionIdBefore !== undefined &&
        !staleTried.has(sessionKey) &&
        !attempt.replied
      ) {
        // D3's per-key form of #149 below: a recorded session that fails
        // before replying is treated as expired — forget it and retry that
        // task fresh once. Anything it had already pulled goes back first.
        staleTried.add(sessionKey);
        ledger.drop({ role: opts.role.id, runtime: runtimeKey, taskKey: sessionKey });
        droppedBecause.set(sessionKey, 'fresh-after-stale-resume');
        mailbox.reclaimInFlight();
        sessionId = undefined;
        resumeSessionId = undefined;
        hitTurnLimit = false;
        opts.bus.emit({
          type: 'status',
          from: opts.role.id,
          reason: 'resume-session-stale',
          msg: `agent "${opts.role.id}" could not resume its session for ${sessionKey} — retrying with a fresh session`,
          data: { error: errMsg },
        });
      } else if (
        !stopping &&
        scope === 'role' &&
        resumeSessionId &&
        resumeSessionId === initialResumeSessionId &&
        !triedFreshAfterResumeFailure &&
        // #247: a resumed session that already replied was resumable — a
        // later failure is a real crash. Let it reach the daemon's
        // crash-restart (which resumes again) instead of silently
        // continuing in a fresh, context-less session.
        !attempt.replied
      ) {
        // #149: first failure on a checkpoint-provided session id — treat as
        // a stale/expired resume, not a genuine crash. Retry once with a
        // fresh session before falling into the crash/backoff path below;
        // a second failure with no resumeSessionId in play is a real error.
        triedFreshAfterResumeFailure = true;
        sessionId = undefined;
        resumeSessionId = undefined;
        hitTurnLimit = false;
        // #304: no raw SDK text here either, same reason as runOneSession's
        // breadcrumb — this describes what session.ts itself did (retried),
        // not a characterisation of the underlying error. Kept in `data` for
        // debugging.
        opts.bus.emit({
          type: 'status',
          from: opts.role.id,
          reason: 'resume-session-stale',
          msg: `agent "${opts.role.id}" could not resume its prior session — retrying with a fresh session`,
          data: { error: errMsg },
        });
      } else {
        throw err;
      }
    } finally {
      tracked?.release();
    }
    // The dead session's generator may still hold the waker - drop it so a
    // push() before the next stream() starts only queues instead of being
    // consumed by the abandoned generator (silent message loss).
    mailbox.detach();
    // A draining mailbox (mid-run role replacement's graceful quiesce, see
    // Mailbox.beginDrain) is the same terminal condition as closed for THIS
    // loop's purposes: stream() already returned cleanly instead of throwing,
    // so without this check the loop would just keep calling runOneSession
    // forever, since isClosed alone stays false for a deliberate drain.
    if (mailbox.isClosed || mailbox.isDraining) return;
    const madeProgress = mailbox.consumedRealCount > realBefore;
    if (hitTurnLimit && madeProgress) consecutiveSpin = 0;
    if (hitTurnLimit) {
      if (!madeProgress) consecutiveSpin++;
      if (consecutiveSpin < MAX_CONTINUATIONS) {
        mailbox.push(
          `${Mailbox.CONTINUE_PREFIX} You reached the per-session turn limit while still working. Continue your in-progress task from where you left off; if nothing remains, end your turn.`,
        );
        opts.bus.emit({
          type: 'status',
          from: opts.role.id,
          reason: 'turn-limit-resume',
          msg: 'session restarting (turn limit reached, mailbox still open)',
        });
      } else {
        // Spinning on continuations alone — park for the watchdog instead of
        // looping forever. Reset so the watchdog's nudge buys a fresh budget.
        consecutiveSpin = 0;
        opts.bus.emit({
          type: 'status',
          from: opts.role.id,
          reason: 'turn-limit-park',
          msg: 'turn limit hit repeatedly with no new input — parking for idle watchdog',
        });
      }
    } else if (mailbox.lastStreamEnd) {
      // D3: the process ended on purpose — a task boundary or idle — and the
      // model session is kept for the next wake.
      opts.bus.emit({
        type: 'status',
        from: opts.role.id,
        reason: 'session-cycled',
        msg: `process cycled (${mailbox.lastStreamEnd}); model session kept for ${sessionKey}`,
        data: { taskKey: sessionKey, end: mailbox.lastStreamEnd, sessionId },
      });
    } else {
      opts.bus.emit({
        type: 'status',
        from: opts.role.id,
        msg: 'session restarting (turn limit reached, mailbox still open)',
      });
    }
  }
}

/** ADR-O001 D1 — token-metering helpers.
 *
 *  `cache_read_input_tokens` and `cache_creation_input_tokens` are siblings
 *  of `input_tokens` in the Anthropic API, not subsets of it, and both are
 *  billable. Everything below therefore sums all four. */
function totalTokens(u: TokenUsage): number {
  return u.input + u.output + u.cacheRead + u.cacheCreation;
}

function addTo(target: TokenUsage, add: TokenUsage): void {
  target.input += add.input;
  target.output += add.output;
  target.cacheRead += add.cacheRead;
  target.cacheCreation += add.cacheCreation;
}

/** One model turn's own usage, off an 'assistant' (or per-turn 'result')
 *  message. */
function turnBreakdown(m: AgentMessage): TokenUsage {
  return {
    input: m.input_tokens ?? 0,
    output: m.output_tokens ?? 0,
    cacheRead: m.cache_read_input_tokens ?? 0,
    cacheCreation: m.cache_creation_input_tokens ?? 0,
  };
}

/** What a 'result' message says this mailbox message consumed.
 *
 *  When the runner reports `cumulative_tokens` (the Claude SDK's whole-pipeline
 *  `modelUsage`, which unlike `usage` includes Task subagents and sidechains),
 *  that value is CUMULATIVE per session — the same lifecycle as
 *  `total_cost_usd` — so it is converted to a delta by the meter (see
 *  cumulative-meter.ts). Without `cumulative_tokens` the per-turn fields are
 *  used as before. */
function resultBreakdown(
  m: AgentMessage,
  tokenTotals: CumulativeMeter<TokenUsage> | undefined,
  sid: string,
): TokenUsage {
  const cum = m.cumulative_tokens;
  if (!cum) return turnBreakdown(m);
  const now: TokenUsage = {
    input: cum.input,
    output: cum.output,
    cacheRead: cum.cache_read,
    cacheCreation: cum.cache_creation,
  };
  return tokenTotals ? tokenTotals.delta(sid, now) : now;
}

/** ADR-O001 D1: the four quantities travel separately so every downstream
 *  consumer (forwarder → dashboard state.json, reporting, `org costs`) can
 *  record real values instead of the 0s they used to persist. `tokens` stays
 *  the single billable total. */
function emitUsage(
  bus: OrgBus,
  from: string,
  t: TokenUsage,
  costUsd: number | undefined,
  subtype: string | undefined,
): void {
  bus.emit({
    type: 'usage',
    from,
    data: {
      tokens: totalTokens(t),
      cost_usd: costUsd,
      subtype,
      tokens_in: t.input,
      tokens_out: t.output,
      cache_read: t.cacheRead,
      cache_creation: t.cacheCreation,
    },
  });
}

/** One bounded SDK session for a role; resolves with the SDK's session_id (for
 *  resuming on restart) and whether it ended by hitting the turn limit (so the
 *  caller can push a continuation) when the stream ends (mailbox closed or
 *  maxTurns reached). */
async function runOneSession(
  opts: SessionOpts,
  resume?: string,
  costTotals?: CumulativeMeter<{ usd: number }>,
  progress?: { replied: boolean },
  tokenTotals?: CumulativeMeter<TokenUsage>,
  streamOpts?: StreamOptions,
  faultWatch?: ReturnType<FaultRestarts['watch']>,
  cancelled?: AbortSignal,
): Promise<{ sessionId?: string; hitTurnLimit?: boolean }> {
  const { org, role, bus, policy, mailbox, cwd } = opts;
  // Each call starts a new runner process, whose cumulative totals may or may
  // not continue the previous one's (cumulative-meter.ts).
  costTotals?.newProcess();
  tokenTotals?.newProcess();
  // Read lastMessageId live from opts instead of capturing at session start
  // This ensures chat responses link to the most recent message delivered
  const getLastMessageId = () => (opts.lastMessageId ? opts.lastMessageId() : undefined);

  // Resolve runner. Precedence: explicit runner > queryFn-wrapped > default.
  // queryFn stays supported so daemon.ts / test-loop.ts need no changes.
  const runner: AgentRunner =
    opts.runner ?? (opts.queryFn ? new ClaudeAgentRunner(opts.queryFn) : defaultClaudeRunner);

  const tools = buildOrgTools(opts);
  // M1: provider tools are listed per session start, so a hot-reloaded
  // tool_providers block takes effect at the role's next session.
  const providerSet = opts.buildProviderTools ? await opts.buildProviderTools() : undefined;
  if (providerSet) tools.push(...providerSet.tools);

  // Named-provider resolution (`adapter_config.provider`): explicit role
  // provider wins, else the named entry from `monomind providers configure`.
  // The named provider's default model fills in adapter_config.model when the
  // role didn't pin one.
  const prov = resolveRoleProvider(role, opts.orgRoot ?? opts.cwd);
  // ADR-O001 D8: the role's cost tier, when the org declares one. Resolved
  // here — the single choke point where a role's model is decided — so the
  // documented precedence holds in exactly one place:
  //   explicit adapter_config.model > tier > named-provider default > runtime
  // The tier's EFFORT is applied even when the model came from an explicit
  // pin: which model to run and how hard to think are separate axes, and
  // silently dropping the effort because a model was pinned would be the
  // "silent downgrade" this decision exists to prevent.
  // Throws (fails the session) rather than guessing when the tier has no
  // entry for this role's provider — daemon.ts validates the whole roster
  // up front so that is normally caught before any token is spent.
  const tier = resolveRoleCostTier({
    role,
    def: opts.def,
    vendor: role.provider?.vendor ?? prov.cfg?.vendor,
  });
  const model =
    role.adapter_config?.model ??
    tier?.model ??
    prov.defaultModel ??
    resolveModel(role, role.runtime, role.provider?.vendor ?? prov.cfg?.vendor);

  bus.emit({ type: 'status', from: role.id, msg: 'session starting' });

  let sessionId: string | undefined = resume;
  let hitTurnLimit = false;
  let contextLimitFired = false;
  // #budget-realtime: real tokens already accounted for the message CURRENTLY
  // in flight, via the per-assistant-turn accounting below — reset to 0 each
  // time a 'result' message ends one mailbox message and the next one starts.
  // Exists purely so the 'result' branch never re-adds what this branch
  // already added (see there for why it can't just always add).
  let messageTurnTokens: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  // Abort hook for the runner (AgentRunArgs.signal): the silent-stream
  // abort below used to call iterator.return() only, which queues behind a
  // subprocess runner blocked in `for await (child.stdout)` — the child was
  // never killed, so every supervisor retry stacked another live CLI.
  //
  // Per attempt, linked one way to the caller's externalAbort (#256): the
  // silent-stream abort used to fire the daemon's slot controller itself,
  // permanently. Every retry then started on an already-aborted signal (a
  // runner honoring it kills its child at once) and the daemon's crash
  // backoff, which races that controller to notice an org stop, resolved
  // immediately - the role burned its retries and crashed. An org stop still
  // aborts the attempt; the attempt's own abort stays its own.
  const abort = new AbortController();
  const external = opts.externalAbort?.signal;
  const onExternalAbort = (): void => abort.abort(external?.reason);
  if (external?.aborted) onExternalAbort();
  else external?.addEventListener('abort', onExternalAbort, { once: true });
  // org_task_cancel for this process's task: end it the same way (task-cancel.ts).
  // Already aborted when it landed during the setup awaits above.
  const unlinkCancelled = linkAbort(cancelled, abort);
  try {
    // #258: policy.git enforced where git runs, not only by Bash text
    // classification — guard env for every runtime, OS sandbox + file-tool
    // deny rules for Claude. Throws (session fails) when the role requires
    // the sandbox and it can't start.
    // Before the sandbox is built: it can only mask directories that exist.
    ensureAuthorityDirs(homedir(), process.env);
    const gitEnforcement = resolveRoleGitEnforcement({
      org,
      role,
      cwd,
      orgRoot: opts.orgRoot,
      orgDir: opts.orgDir,
      bus,
      claudeRuntime: runner instanceof ClaudeAgentRunner,
      runtime: role.runtime ?? opts.def?.runtime,
      // The sandbox's mount-point stubs, created once and kept until the run
      // ends, so no other role's process deletes one mid-bind (sandbox-stubs.ts).
      // Held before the deny list is built, which keeps a denied cwd read-only
      // when all of them are in place (sandbox-deny-write.ts).
      holdStubs: (writableRoots) => {
        const paths = sandboxStubPaths({ cwd, home: homedir(), writableRoots, env: process.env });
        sandboxStubs.hold(`${org}:${opts.run ?? ''}`, paths);
        return sandboxStubs.missing(paths);
      },
    });
    // What this session really got, not what the config asked for (policy-git.ts).
    policy.setOsSandboxed(!!gitEnforcement.claudeRestrictions?.sandbox);
    const authorityMask = roleAuthorityMask({
      bus,
      roleId: role.id,
      inSdkSandbox: !!gitEnforcement.claudeRestrictions?.sandbox,
      // vercel runs in-process with no shell; its file tools go through the policy engine.
      inProcess: (role.runtime ?? opts.def?.runtime) === 'vercel',
      cwd,
      orgRoot: opts.orgRoot,
    });
    const stream = runner.run({
      tools,
      // No options = the pre-D3 stream, exactly.
      prompt: streamOpts ? mailbox.stream('', streamOpts) : mailbox.stream(),
      systemPrompt: gitEnforcement.claudeRestrictions?.sandbox
        ? `${rolePromptFor(opts)}\n\n${claudeSandboxCwdNote(cwd)}`
        : rolePromptFor(opts),
      model,
      cwd,
      effort: tier?.effort,
      env: {
        ...resolveProviderEnv(prov.cfg),
        // D8: how a NON-Claude provider expresses the tier's effort level.
        // Empty for Claude (handled natively by ClaudeAgentRunner) and for a
        // provider that declares no mechanism — which simply ignores effort.
        ...(tier?.env ?? {}),
        // Claude Code's 2-minute Bash default is too short for org work.
        ...(runner instanceof ClaudeAgentRunner
          ? claudeBashTimeoutEnv(opts.def?.run_config?.bash_timeout_ms)
          : {}),
        // Custom-endpoint providers (named-provider path): pin the engine's
        // model env so background/haiku tasks also route to the endpoint's
        // model instead of erroring on an Anthropic-only default.
        ...(prov.cfg?.authToken
          ? { ANTHROPIC_MODEL: model, ANTHROPIC_SMALL_FAST_MODEL: model }
          : {}),
        ...gitEnforcement.env,
        ...(gitEnforcement.claudeRestrictions?.sandbox ? CLAUDE_SANDBOX_CWD_ENV : {}),
        // No MONOMIND_HOOK_QUIET / MONOMIND_GRAPH_GATE / MONOMIND_SDK_AGENT
        // here (#249): every CLI hands this env to its shell tool, so they
        // reached every command the role ran and silently muted monomind's
        // own hooks, graph gate and tests inside the role. ClaudeAgentRunner
        // loads no filesystem hooks (settingSources: []). The codex/kimi/
        // opencode hook bridges generated by `monomind init` read the
        // MONOMIND_ORG_ROLE marker below and set the quieting vars on the
        // hook-handler process they spawn — hooks stay quiet, commands don't.
        //
        // Per-role scoping for runners that persist state under the org dir
        // (VercelAgentRunner session files). Without these, session files would
        // land in args.cwd (project root for workspace:'repo') under the literal
        // 'default' roleId, polluting the repo and making files unattributable.
        MONOMIND_ORG_DIR: opts.orgDir ?? opts.cwd,
        MONOMIND_ROLE_ID: role.id,
        // M1: attribution for anything the role runs (C-16).
        MONOMIND_ORG_NAME: org,
        MONOMIND_ORG_ROLE: role.id,
        ...(opts.run ? { MONOMIND_ORG_RUN: opts.run } : {}),
        ...(opts.orgRoot ? { MONOMIND_ORG_ROOT: opts.orgRoot } : {}),
      },
      maxTurns: opts.maxTurns ?? 30,
      maxToolRounds: role.max_tool_rounds ?? opts.def?.run_config?.max_tool_rounds,
      resume,
      claudeRestrictions: gitEnforcement.claudeRestrictions,
      authorityMask,
      // ADR-O001 D2: tool results are 76% of a role's context mass and nothing
      // bounded them. Under the ORG STATE dir (never the workspace cwd, which
      // may be the repo), and under orgRoot — which file-roots.ts already
      // makes readable to the role's file tools and role-sandbox.ts already
      // makes readable to Bash — so the path in the digest actually resolves
      // when the role decides it needs the full text.
      toolSpillDir: join(
        opts.orgDir ?? opts.cwd,
        'tool-results',
        role.id.replace(/[^a-zA-Z0-9_.-]/g, '_'),
      ),
      canUseTool: gatedCanUseTool(
        policy,
        opts.beforeTool,
        role.id,
        opts.fence,
        opts.onDecision
          ? (toolName, _input, decision, kind) =>
              opts.onDecision?.(role.id, toolName, decision.message ?? 'denied', kind)
          : undefined,
        opts.hasPendingGate,
      ),
      // test seam forwarded through extras: lets the scripted fake SDK
      // (test-loop.ts) drive org_send and tool calls through the real
      // deliver/policy paths; the real SDK ignores it.
      extras: opts.runner
        ? undefined
        : {
            _orgTest: {
              deliver: (to: string, subject: string, body: string) =>
                opts.deliver(role.id, to, subject, body),
              callTool: (name: string, input: Record<string, unknown>) =>
                policy.decide(name, input),
            },
          },
      signal: abort.signal,
      // VercelAgentRunner-only fields — ignored by other runners.
      vendor: role.provider?.vendor,
      providerConfig: role.provider,
    } as any);

    // A silent session is its own failure mode, and until now an unnameable
    // one: nine consecutive cycles of a scheduled org opened all seven streams
    // and yielded NOTHING - no assistant message, no result, no error, and no
    // stream end. The only symptom was the idle watchdog reporting the boss
    // "appears hung" twenty minutes later, which described neither the scope
    // (every role) nor the cause.
    //
    // Naming it used to be all this did: log an audit event at 4 minutes and
    // then keep waiting on the same stuck `for await`, so recovery still
    // depended on the org-wide idle watchdog (10m nudge + 10m stop = 20m of
    // dead time per cycle - and it kills the WHOLE run, not just the stuck
    // session). Only the FIRST pull from the stream is raced against the
    // timeout: once any message has arrived the session is demonstrably
    // alive, so a slow-but-working tool call is never mistaken for a stall.
    // On silence, abandon this attempt (best-effort iterator.return() to
    // signal the SDK) and throw - the caller's crash-retry-with-backoff loop
    // (daemon.ts's `runtime.done`) already knows how to retry a failed
    // session with a fresh query() call and, for the boss, escalate to a
    // whole-org restart if it keeps failing. That gives the SDK several
    // fresh attempts within a single cycle instead of one silent attempt
    // followed by twenty minutes of nothing.
    const openedAt = Date.now();
    const detector = new StateDetector();
    const iterator = stream[Symbol.asyncIterator]();
    const SILENT = Symbol('silent');
    let silentTimer: ReturnType<typeof setTimeout> | undefined;
    const silentMs = opts.silentSessionMs ?? SILENT_SESSION_MS;
    const firstPull = await Promise.race([
      iterator.next(),
      new Promise<typeof SILENT>((resolve) => {
        silentTimer = setTimeout(() => resolve(SILENT), silentMs);
        (silentTimer as { unref?: () => void }).unref?.();
      }),
    ]);
    clearTimeout(silentTimer);
    if (firstPull === SILENT) {
      bus.emit({
        type: 'audit',
        from: role.id,
        reason: 'session-silent',
        msg: `SDK stream open ${Math.round((Date.now() - openedAt) / 1000)}s with zero messages - aborting this attempt and retrying. Set MONOMIND_DEBUG=1 to log raw message types.`,
      });
      // Kill the runner's subprocess FIRST: iterator.return() below cannot
      // reach a runner blocked in its stdout loop, and the retry would
      // otherwise spawn a second CLI next to the still-running first one.
      abort.abort();
      try {
        await Promise.race([
          iterator.return?.(undefined) ?? Promise.resolve(),
          new Promise<void>((r) => {
            const t = setTimeout(() => r(), 2_000);
            (t as { unref?: () => void }).unref?.();
          }),
        ]);
      } catch {
        /* best-effort */
      }
      throw new Error(
        `org "${org}" role "${role.id}": SDK stream silent for ${Math.round(silentMs / 1000)}s with zero messages`,
      );
    }
    const first: IteratorResult<AgentMessage> = firstPull;

    // Replay the first pulled message, then continue draining normally.
    async function* rest(): AsyncGenerator<AgentMessage> {
      if (!first.done) yield first.value;
      while (true) {
        const r = await iterator.next();
        if (r.done) return;
        yield r.value;
      }
    }

    for await (const m of rest()) {
      if (process.env.MONOMIND_DEBUG) {
        console.error(
          `[orgrt:${org}/${role.id}] runner message type=${m.type} subtype=${String(m.subtype ?? '-')}`,
        );
      }
      if (cancelled?.aborted) throw cancelled.reason;
      mailbox.observeTurn(m.type); // the prompt stream outlives a live turn (#331)
      if (m.session_id) {
        sessionId = m.session_id;
        // P2-13: propagate the session ID back to the daemon so checkpoints
        // can resume the SDK session after a crash/restart.
        opts.onSessionId?.(sessionId);
      }
      const prevState = detector.current();
      const textForDetect = m.type === 'assistant' ? m.text || '' : undefined;
      const newState = detector.onMessage(m.type, m.subtype, textForDetect);
      if (newState !== prevState) {
        bus.emit({
          type: 'status',
          from: role.id,
          reason: 'state-change',
          msg: `${prevState} → ${newState}`,
          data: { from: prevState, to: newState },
        });
      }
      if (m.type === 'assistant') {
        if (progress) progress.replied = true;
        const text = m.text || '';
        if (text.trim()) {
          opts.onOutput?.(text);
          bus.emit({ type: 'chat', from: role.id, msg: text, parentId: getLastMessageId() });
          if (opts.onContextLimit && !contextLimitFired && CONTEXT_LIMIT_RE.test(text)) {
            contextLimitFired = true;
            bus.emit({
              type: 'audit',
              from: role.id,
              reason: 'boss-context-limit',
              msg: 'coordinator context window exhausted — requesting whole-org restart with fresh sessions',
            });
            opts.onContextLimit();
          }
        }
        // #budget-realtime (HIGH): the SDK's 'result' message arrives once per
        // WHOLE mailbox message in streaming-input mode — with
        // max_turns_per_message defaulting to 100,000, a single message can
        // internally loop through hundreds/thousands of tool-use turns before
        // that 'result' ever arrives, during which policy.used never moved and
        // policy.decide() allowed every one of those turns' tool calls
        // regardless of real spend (the overspend was already done by the time
        // overBudget could ever trip). Each 'assistant' SDK message DOES carry
        // that ONE model turn's real usage (agent-runner.ts reads it off
        // BetaMessage.usage) — accumulate it as turns actually happen and
        // enforce the budget immediately, so overBudget can close the mailbox
        // DURING a runaway message instead of only once it finally completes.
        // (USD budget can't get the same real-time treatment: the SDK only
        // exposes cost as a cumulative total on 'result', not per-turn on
        // 'assistant' — verified against this project's Claude Agent SDK
        // .d.ts, which puts `usage`/token counts on BetaMessage but cost only
        // on SDKResultSuccess.total_cost_usd/modelUsage. overBudgetUsd is
        // still checked below, once per message, same as before this fix.)
        //
        // ADR-O001 D1: the sum must include BOTH cache fields. They are
        // siblings of input_tokens in the Anthropic API, not subsets of it —
        // `input_tokens` is the uncached remainder — and both are billable
        // (~0.1x and ~1.25x input). Omitting them meant the better the cache
        // worked the less the meter saw: on one measured run, 2,765M tokens
        // billed against 8.1M recorded, with input_tokens at 0.0M.
        const turn = turnBreakdown(m);
        const turnTokens = totalTokens(turn);
        if (turnTokens > 0) {
          addTo(messageTurnTokens, turn);
          policy.addTokenUsage(turn);
          if (policy.overBudget) {
            bus.emit({
              type: 'status',
              from: role.id,
              reason: 'budget-exhausted',
              msg: 'token budget exhausted - closing session',
            });
            mailbox.close('token-budget');
          }
        }
      } else if (m.type === 'tool_result') {
        // #289: the tool call's outcome. Until this event existed, a Bash
        // running a test suite looked identical on the bus whether the suite
        // passed, failed, or the binary was missing — one 'allow' at the moment
        // it started — so every consumer inferred success from the agent's own
        // narration. `call_id` joins this back to that invocation event; the
        // body is redacted and capped (policy.ts) so a megabyte of output, or a
        // credential echoed by a command, never lands in bus.jsonl.
        const body = summarizeToolOutput(m.text ?? '');
        const data: ToolResultEventData = {
          ...(m.tool_use_id ? { call_id: m.tool_use_id } : {}),
          ok: m.is_error !== true,
          ...(typeof m.duration_ms === 'number' ? { duration_ms: m.duration_ms } : {}),
          output: body.output,
          ...(body.truncated ? { truncated: true } : {}),
          output_chars: body.output_chars,
        };
        bus.emit({
          type: 'tool_result',
          from: role.id,
          ...(m.tool ? { tool: m.tool } : {}),
          data: data as unknown as Record<string, unknown>,
        });
        faultWatch?.observe(m, sessionId);
      } else if (m.type === 'result') {
        // ADR-O001 D1: prefer the SDK's `modelUsage` over `usage`. The SDK
        // documents `usage` as "MAIN AGENT LOOP ONLY — excludes Task
        // subagent, sidechain, and auxiliary model calls ... Prefer
        // modelUsage for token/cost accounting"; the measured run made 46
        // subagent calls this counter never saw. modelUsage is CUMULATIVE per
        // session (same lifecycle as total_cost_usd, per its own type doc),
        // so it is converted to a delta here rather than added, exactly as
        // cost is below. A runner that reports no modelUsage falls back to
        // the per-turn `usage` fields, which keep their old semantics.
        const resultTokens = resultBreakdown(m, tokenTotals, m.session_id ?? sessionId ?? '');
        // Per the SDK's own type docs, a 'result' message's usage is that
        // message's own (effectively last-turn) usage in streaming-input mode,
        // NOT a cumulative total across every turn of the mailbox message —
        // and that last turn was already counted above via its own 'assistant'
        // message, specifically so overBudget could trip mid-message. Adding
        // the result's own usage again unconditionally would double-count it.
        // (A modelUsage-derived delta is per-session-cumulative, so the same
        // subtraction is exactly right there too: it removes what the
        // assistant turns of THIS message already contributed and leaves the
        // subagent/auxiliary volume the main loop never reported.) Only make
        // up the shortfall (never negative) so a turn whose usage somehow
        // never reached the 'assistant' branch (e.g. a runner/test double that
        // doesn't emit per-turn usage) still gets counted at least once.
        const shortfall: TokenUsage = {
          input: Math.max(0, resultTokens.input - messageTurnTokens.input),
          output: Math.max(0, resultTokens.output - messageTurnTokens.output),
          cacheRead: Math.max(0, resultTokens.cacheRead - messageTurnTokens.cacheRead),
          cacheCreation: Math.max(0, resultTokens.cacheCreation - messageTurnTokens.cacheCreation),
        };
        if (totalTokens(shortfall) > 0) policy.addTokenUsage(shortfall);
        // What this whole mailbox message actually added to the meter: the
        // per-turn accounting above plus whatever the result topped up. This
        // is what the 'usage' event reports, so a consumer summing events
        // lands on the same number as policy.usage.
        const messageTokens: TokenUsage = {
          input: messageTurnTokens.input + shortfall.input,
          output: messageTurnTokens.output + shortfall.output,
          cacheRead: messageTurnTokens.cacheRead + shortfall.cacheRead,
          cacheCreation: messageTurnTokens.cacheCreation + shortfall.cacheCreation,
        };
        messageTurnTokens = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
        // Convert the SDK's cumulative total_cost_usd into a per-result
        // delta before emitting - downstream sums usage events. A new session
        // id counts in full; a same-process dip (rounding, a provider-side
        // correction) floors at 0 rather than re-adding the cumulative cost,
        // which feeds USD budget enforcement (ORG-7). A resume in a new
        // process is judged by the meter (cumulative-meter.ts).
        let costDelta = m.cost_usd;
        if (costTotals && typeof m.cost_usd === 'number' && Number.isFinite(m.cost_usd)) {
          const sid = m.session_id ?? sessionId ?? '';
          costDelta = costTotals.delta(sid, { usd: m.cost_usd }).usd;
        }
        // ORG-7: accumulate real USD cost so policy.overBudgetUsd (role.budget_usd) is enforceable.
        if (typeof costDelta === 'number' && Number.isFinite(costDelta))
          policy.addUsageUsd(costDelta);
        emitUsage(bus, role.id, messageTokens, costDelta, m.subtype);
        if (m.subtype && m.subtype !== 'success') {
          if (m.subtype === 'error_max_turns') hitTurnLimit = true;
          bus.emit({
            type: 'audit',
            from: role.id,
            reason: 'session-result-error',
            msg: `turn ended with subtype "${m.subtype}"${m.is_error ? ' (is_error)' : ''} - the role produced no usable output`,
          });
          if (opts.circuitBreaker && m.subtype !== 'error_max_turns') {
            const cb = opts.circuitBreaker;
            cb.state.failures++;
            if (cb.state.failures >= cb.threshold) {
              cb.state.tripped = true;
              bus.emit({
                type: 'audit',
                from: role.id,
                reason: 'circuit-breaker-tripped',
                msg: `circuit breaker tripped after ${cb.state.failures} consecutive failures — closing role`,
                data: { failures: cb.state.failures, threshold: cb.threshold },
              });
              mailbox.close();
            }
          }
        } else if (m.subtype === 'success' && opts.circuitBreaker) {
          opts.circuitBreaker.state.failures = 0;
        }
        if (policy.overBudget) {
          bus.emit({
            type: 'status',
            from: role.id,
            reason: 'budget-exhausted',
            msg: 'token budget exhausted - closing session',
          });
          // #205: tag WHY the mailbox closed. A budget-exhausted boss is
          // recoverable (raise the budget, resume) — the idle watchdog reads
          // this to stop reporting it as generic "unreachable" (crash-like).
          mailbox.close('token-budget');
        }
        // ORG-7: parallel USD-budget enforcement, same pattern as the token check above.
        if (policy.overBudgetUsd) {
          bus.emit({
            type: 'status',
            from: role.id,
            reason: 'budget-exhausted',
            msg: 'USD budget exhausted - closing session',
          });
          mailbox.close('usd-budget');
        }
        // The turn is over: whatever tool calls it was going to make, it has
        // made. What the role left open is knowable here (decisions.ts's
        // nudgeOpenTasksAtTurnEnd) instead of only to the idle watchdog.
        opts.onTurnEnd?.();
      }
    }
    if (cancelled?.aborted) throw cancelled.reason;
    bus.emit({ type: 'status', from: role.id, msg: 'session ended' });
    return { sessionId, hitTurnLimit };
  } catch (err) {
    // The turn in flight never got its 'result', so its metered turns (already
    // in policy) have no usage event yet. Cost is only on 'result': unknown.
    if (totalTokens(messageTurnTokens) > 0)
      emitUsage(bus, role.id, messageTurnTokens, undefined, 'aborted');
    // Ending the process was the point; sandbox-fault.ts already audited it.
    if (err instanceof ProcessFaultError) throw err;
    if (cancelled?.aborted) throw cancelled.reason;
    // org_complete / org stop close the mailbox and abort every session: a
    // normal stop, not a failure. The daemon still classifies it.
    const message = err instanceof Error ? err.message : String(err);
    if (
      (mailbox.isClosed || (external?.aborted ?? false)) &&
      ((err as { name?: string } | null)?.name === 'AbortError' || /\baborted\b/i.test(message))
    ) {
      bus.emit({
        type: 'status',
        from: role.id,
        reason: 'session-stopped',
        msg: 'session stopped',
      });
      throw err;
    }
    // #304: the daemon's role loop catches this same error one step later and
    // emits the authoritative CLASSIFIED status — crashed / stopped with the
    // org / terminated by stop — carrying the real error text when it is a
    // genuine crash (daemon.ts's 'agent-session-crash' audit). This
    // breadcrumb must not pre-empt that with the raw SDK string: on a
    // planned stop it announced "Claude Code process aborted by user" about
    // a stop nobody requested. It deliberately does NOT classify —
    // session.ts relays, the daemon decides — and it carries a `reason` so
    // it is filterable; its absence is why every #304/#251 test was
    // structurally unable to see this event.
    bus.emit({
      type: 'status',
      from: role.id,
      reason: 'session-error',
      msg: 'session ended with an error — see the classified status that follows',
    });
    throw err;
  } finally {
    // Unlink so a long-lived role doesn't pile a listener per attempt onto the
    // slot controller. Aborting the finished attempt keeps a runner abandoned
    // mid-stream by a throw from outliving it now that an org stop can no
    // longer reach it.
    external?.removeEventListener('abort', onExternalAbort);
    unlinkCancelled();
    abort.abort();
    providerSet?.close();
  }
}

export { buildOrgTools } from './org-tools.js';
export { AUTO_ASSIGNEE } from './task-tools.js';
