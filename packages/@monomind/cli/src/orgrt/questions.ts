// packages/@monomind/cli/src/orgrt/questions.ts
// Extracted from daemon.ts — ask_human / answerQuestion flow.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OrgDaemon } from './daemon.js';
import { queueMessage } from './inbox.js';
import {
  closedQuestionReason,
  dismissalNote,
  isOpenQuestion,
  type QuestionDismissal,
  roleRemovedFromOrgDef,
  savedOrgDefHasRole,
} from './question-state.js';
import { ORG_DIR } from './types.js';

export function questionsPath(root: string, org: string): string {
  return join(root, ORG_DIR, org, 'questions.json');
}

export function readQuestions(
  root: string,
  org: string,
): {
  questions: Array<
    QuestionDismissal & {
      questionId: string;
      role: string;
      question: string;
      ts: number;
      answer: string | null;
      answeredAt: number | null;
      /** ADR-O001 D4: does the asking role actually need this answered before
       *  it can continue? Only a blocking question holds the idle watchdog or
       *  counts as an org_complete `human` blocker. Absent on pre-D4 records
       *  (and when a caller omits it), which are read as blocking. */
      blocking?: boolean;
      /** M5: who answered or dismissed it (`human` by default). */
      resolvedBy?: string;
    }
  >;
} {
  try {
    return JSON.parse(readFileSync(questionsPath(root, org), 'utf8'));
  } catch {
    return { questions: [] };
  }
}

export function writeQuestions(
  root: string,
  org: string,
  data: ReturnType<typeof readQuestions>,
): void {
  const dest = questionsPath(root, org);
  mkdirSync(join(root, ORG_DIR, org), { recursive: true });
  const tmp = `${dest}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, dest);
}

/** Discard every still-pending question left over from a previous run. Call on
 *  a fresh (non-resume) startOrg — same rule as clearApprovalsForFreshStart
 *  (#165), for the same reason (#248).
 *
 *  questions.json is keyed per-org, not per-run. A question a role asked in a
 *  PREVIOUS run that was never answered before that run ended otherwise stays
 *  `answer: null` forever: `org questions` and the dashboard list it as
 *  pending, the idle watchdog treats it as a legitimate human wait and never
 *  nudges or stops the new run, and answering it pushes context into a role
 *  that never asked. Answered entries have no effect on a new run, so they are
 *  kept as history; the dropped question's text is still in its own run's
 *  bus.jsonl ('question' event). */
export function clearQuestionsForFreshStart(daemon: OrgDaemon, org: string): void {
  if (!existsSync(questionsPath(daemon.root, org))) return;
  const data = readQuestions(daemon.root, org);
  const answered = data.questions.filter((q) => !isOpenQuestion(q));
  if (answered.length !== data.questions.length)
    writeQuestions(daemon.root, org, { ...data, questions: answered });
}

/** Pending questions that legitimately hold the run (ADR-O001 D4).
 *
 *  THE INCIDENT: a `monomind-dev` run sat wedged for 8.3 hours on
 *  `{"idle_minutes":60,"idle_stop_at":null,"hold":"pending-question"}`. The
 *  question behind that hold had been declared NON-BLOCKING by its own
 *  author, whose text opened with "no answer needed for the run to continue;
 *  I am not blocking on this" — yet every unanswered question suppressed the
 *  idle watchdog identically, so a question that said it was not blocking
 *  disabled the only mechanism that could have stopped or restarted the run.
 *
 *  A question that does not block is still recorded, listed by `org
 *  questions` and answerable; it simply does not freeze anything. An
 *  unflagged question is treated as blocking, so nothing silently stops
 *  waiting for an answer a role really is waiting on (the hold it sets still
 *  expires — see `advanceHold`). */
export function pendingBlockingQuestions(
  root: string,
  org: string,
): ReturnType<typeof readQuestions>['questions'] {
  return readQuestions(root, org).questions.filter(
    (q) => isOpenQuestion(q) && q.blocking !== false,
  );
}

/** Serialize question mutations per org (same pattern as withApprovalLock).
 *  askHuman and answerQuestion race on questions.json without this. */
function withQuestionsLock<T>(daemon: OrgDaemon, org: string, fn: () => Promise<T>): Promise<T> {
  const prev = daemon.questionsLocks.get(org) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  daemon.questionsLocks.set(
    org,
    next.catch(() => {
      /* slot stays usable for the next caller */
    }),
  );
  return next;
}

/** Agent-initiated human question (ask_human tool). Persists to questions.json (survives
 *  process/dashboard restarts) and emits a 'question' BusEvent so the dashboard's SSE
 *  stream and global inbox pick it up in real time. Returns a receipt string for the tool call.
 *  Serialized per-org via withQuestionsLock() (same TOCTOU pattern as approvals). */
export function askHuman(
  daemon: OrgDaemon,
  org: string,
  role: string,
  question: string,
  blocking = true,
): Promise<string> {
  return withQuestionsLock(daemon, org, async () => {
    const running = daemon.orgs.get(org);
    const questionId = `q-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const data = readQuestions(daemon.root, org);
    data.questions.push({
      questionId,
      role,
      question,
      ts: Date.now(),
      answer: null,
      answeredAt: null,
      blocking,
    });
    writeQuestions(daemon.root, org, data);
    running?.bus.emit({ type: 'question', from: role, data: { questionId, question, blocking } });
    return blocking
      ? `Question recorded (id ${questionId}) — a human will answer it; you'll receive the answer as a new message. It is marked BLOCKING: end your turn now and wait for the answer — do not assume or invent it, and do not call org_complete until it arrives (org_complete is refused while it is open). It pauses the org's idle watchdog for up to an hour; after that the run resumes its normal idle checks whether or not the answer has arrived.`
      : `Question recorded (id ${questionId}) — a human will answer it; you'll receive the answer as a new message. It is marked non-blocking, so it does NOT pause the run: keep working.`;
  });
}

/** Delivers a human's answer to a pending ask_human question. If the org is still
 *  running, pushes straight into the role's live mailbox (picked up on its very next
 *  generator tick — see Mailbox.stream()). If the org has since stopped, queues the
 *  answer via the same offline fallback deliver()/receiveRemote() already use
 *  (inbox.ts + autoWake) and it's delivered when the org next starts.
 *
 *  PERSIST-AFTER-DELIVERY: questions.json is only marked answered once delivery has
 *  actually happened (mailbox push, or the message landing in inbox.jsonl). Marking it
 *  first meant a rejected delivery — unknown role, mailbox closed mid-shutdown, a
 *  queueMessage that threw on a full/read-only disk — left the question recorded as
 *  answered while nobody ever received the answer, and the `already answered` guard
 *  then refused every retry. The answer was simply gone. The inverse failure (crash
 *  between delivery and the write) merely re-shows the question as pending, which a
 *  human can act on; a silently swallowed answer is not recoverable. */
export function answerQuestion(
  daemon: OrgDaemon,
  org: string,
  role: string,
  questionId: string,
  answer: string,
  resolvedBy = 'human',
): Promise<{ ok: true; delivery?: 'skipped' } | { ok: false; error: string }> {
  return withQuestionsLock(daemon, org, async () => {
    const data = readQuestions(daemon.root, org);
    const idx = data.questions.findIndex((q) => q.questionId === questionId);
    if (idx === -1)
      return { ok: false, error: `question "${questionId}" not found for org "${org}"` };
    const closed = closedQuestionReason(questionId, data.questions[idx]);
    if (closed) return { ok: false, error: closed };
    const question = data.questions[idx].question;
    // #572: only the role that asked can be "removed" — a caller naming some
    // other unknown role still gets "role not found" instead of an answer
    // recorded against a question whose asker never receives it.
    const askerRemoved = (removed: boolean): boolean =>
      removed && role === data.questions[idx].role;
    // Applied to questions.json ONLY after the delivery below succeeds.
    const markAnswered = (): void => {
      // Re-read so a question the daemon appended (or answered) meanwhile isn't
      // clobbered by this stale snapshot — merge by questionId, never replace.
      const fresh = readQuestions(daemon.root, org);
      const fIdx = fresh.questions.findIndex((q) => q.questionId === questionId);
      if (fIdx === -1)
        fresh.questions.push({
          ...data.questions[idx],
          answer,
          answeredAt: Date.now(),
          resolvedBy,
        });
      else
        fresh.questions[fIdx] = {
          ...fresh.questions[fIdx],
          answer,
          answeredAt: Date.now(),
          resolvedBy,
        };
      writeQuestions(daemon.root, org, fresh);
    };

    const running = daemon.orgs.get(org);
    if (running) {
      // Org IS running — deliver or report a real error, but never fall through to the
      // offline queue+autoWake path below: autoWake() no-ops when this.orgs already has
      // the org (see its own guard), so a role-specific delivery failure here (mailbox
      // closed, role unknown) would otherwise queue the answer forever with no real error
      // and no delivery. Mirrors deliver()'s existing "shutting down" error for the same
      // mid-shutdown-mailbox-closed race.
      // Spawn a lazily-deferred role before giving up on it. Roles are no longer
      // all spawned at boot, so `agents` legitimately lacks a role that simply
      // has not been needed yet — and rejecting on that dropped the human's
      // answer with "role not found" for a role that exists and is about to
      // run. deliver() does the same lookup; a human answer must not be the one
      // delivery path that cannot wake a role.
      if (!running.agents.has(role) && running.pendingRoles?.has(role)) {
        const pending = running.pendingRoles.get(role)!;
        running.pendingRoles.delete(role);
        running.spawnRole?.(pending);
      }
      const agent = running.agents.get(role);
      if (!agent) {
        if (!askerRemoved(roleRemoved(daemon, org, role)))
          return { ok: false, error: `role "${role}" not found in org "${org}"` };
        // #572: the asking role is gone from the org definition, so nobody can
        // receive the answer — record it (the question stops being pending)
        // and say in the audit trail that it was not delivered.
        markAnswered();
        emitResolved(running, role, questionId, resolvedBy, 'answered', {
          delivery: 'skipped',
          note: removedNote(role, 'answer'),
        });
        return { ok: true, delivery: 'skipped' };
      }
      if (agent.mailbox.isClosed)
        return {
          ok: false,
          error: `role "${role}" in org "${org}" is shutting down — answer not delivered`,
        };
      try {
        agent.mailbox.push(`[answer from human] question: ${question}\n\nanswer: ${answer}`);
      } catch (err) {
        return {
          ok: false,
          error: `delivery to "${role}" in org "${org}" failed — answer not recorded (${err instanceof Error ? err.message : String(err)})`,
        };
      }
      markAnswered();
      emitResolved(running, role, questionId, resolvedBy, 'answered');
      return { ok: true };
    }
    // Org not running at all — queue for delivery on next start, matching deliver()'s
    // existing offline fallback exactly (inbox.ts + autoWake).
    if (!daemon.hasOrgDef(org))
      return { ok: false, error: `org "${org}" not found (no saved definition)` };
    // #572: a removed role never runs again — queueing for it would wake the
    // org for a message nobody drains. Record the answer only.
    if (askerRemoved(roleRemovedFromOrgDef(daemon.root, org, role))) {
      markAnswered();
      return { ok: true, delivery: 'skipped' };
    }
    const queued = queueMessage(daemon.root, org, {
      fromQualified: 'human',
      toRole: role,
      subject: `answer:${questionId}`,
      body: `question: ${question}\n\nanswer: ${answer}`,
      ts: Date.now(),
    });
    if (!queued) {
      return {
        ok: false,
        error: `could not queue answer for org "${org}" — answer not recorded (disk full or permissions)`,
      };
    }
    markAnswered();
    daemon.autoWake(org);
    return { ok: true };
  });
}

type Running = NonNullable<ReturnType<OrgDaemon['orgs']['get']>>;

/** A role with no live agent is "removed" when it is not waiting to spawn and
 *  the saved definition lacks it (a reload keeps a removed role in the running
 *  definition until the next start). A role the saved definition still has
 *  runs again on the next start, so it is never "removed" even when the
 *  running definition lacks it; only without a readable saved definition does
 *  the running one decide. */
function roleRemoved(daemon: OrgDaemon, org: string, role: string): boolean {
  const running = daemon.orgs.get(org);
  if (running?.pendingRoles?.has(role) || running?.deferredSpawns?.has(role)) return false;
  const saved = savedOrgDefHasRole(daemon.root, org, role);
  if (saved !== undefined) return !saved;
  return !(running?.def.roles.some((r) => r.id === role) ?? false);
}

function removedNote(role: string, what: 'answer' | 'dismissal'): string {
  return `role "${role}" is no longer in the org definition — ${what} recorded, not delivered`;
}

/** The status + `decision-resolved` audit pair every question resolution emits. */
function emitResolved(
  running: Running,
  role: string,
  questionId: string,
  resolvedBy: string,
  verdict: 'answered' | 'dismissed',
  extra: Record<string, unknown> = {},
): void {
  running.bus.emit({
    type: 'status',
    from: role,
    msg: `question ${verdict}`,
    data: { questionId },
  });
  running.bus.emit({
    type: 'audit',
    reason: 'decision-resolved',
    from: role,
    data: { kind: 'question', ref: questionId, resolver: resolvedBy, verdict, ...extra },
  });
}

/** #572: close an open question WITHOUT an answer. A blocking question holds
 *  org_complete and the idle watchdog until it is closed (#564); when no
 *  answer is coming, a human dismisses it instead of inventing one.
 *
 *  The dismissal is recorded whatever happens to the note — its job is to
 *  release the run. The asking role gets a short note so it stops waiting:
 *  pushed into its mailbox while the org runs, queued in the inbox (without
 *  waking the org) while it does not. A role that is no longer in the org
 *  definition gets nothing, and the audit event says so. */
export function dismissQuestion(
  daemon: OrgDaemon,
  org: string,
  questionId: string,
  reason?: string,
  resolvedBy = 'human',
): Promise<
  { ok: true; role: string; delivery: 'live' | 'queued' | 'skipped' } | { ok: false; error: string }
> {
  return withQuestionsLock(daemon, org, async () => {
    const data = readQuestions(daemon.root, org);
    const q = data.questions.find((x) => x.questionId === questionId);
    if (!q) return { ok: false, error: `question "${questionId}" not found for org "${org}"` };
    const closed = closedQuestionReason(questionId, q);
    if (closed) return { ok: false, error: closed };
    const { role } = q;
    const note = dismissalNote(q.question, reason);

    let delivery: 'live' | 'queued' | 'skipped' = 'skipped';
    let skipNote: string | undefined;
    const running = daemon.orgs.get(org);
    if (running) {
      // Same lazy-spawn rule as answerQuestion: a role that exists but has
      // not spawned yet still has to hear that its question was dismissed.
      if (!running.agents.has(role) && running.pendingRoles?.has(role)) {
        const pending = running.pendingRoles.get(role)!;
        running.pendingRoles.delete(role);
        running.spawnRole?.(pending);
      }
      const agent = running.agents.get(role);
      if (!agent)
        skipNote = roleRemoved(daemon, org, role)
          ? removedNote(role, 'dismissal')
          : `role "${role}" has no running session — dismissal recorded, not delivered`;
      else if (agent.mailbox.isClosed)
        skipNote = `role "${role}" is shutting down — dismissal recorded, not delivered`;
      else {
        try {
          agent.mailbox.push(`[question dismissed by human] ${note}`);
          delivery = 'live';
        } catch (err) {
          skipNote = `delivery to "${role}" failed (${err instanceof Error ? err.message : String(err)}) — dismissal recorded`;
        }
      }
    } else if (roleRemovedFromOrgDef(daemon.root, org, role)) {
      skipNote = removedNote(role, 'dismissal');
    } else if (daemon.hasOrgDef(org)) {
      const queued = queueMessage(daemon.root, org, {
        fromQualified: 'human',
        toRole: role,
        subject: `dismissed:${questionId}`,
        body: note,
        ts: Date.now(),
      });
      if (queued) delivery = 'queued';
    }

    // Re-read and merge by questionId (same rule as answerQuestion's markAnswered).
    const fresh = readQuestions(daemon.root, org);
    const dismissal = {
      state: 'dismissed' as const,
      dismissedAt: Date.now(),
      ...(reason ? { dismissReason: reason } : {}),
      resolvedBy,
    };
    const fIdx = fresh.questions.findIndex((x) => x.questionId === questionId);
    if (fIdx === -1) fresh.questions.push({ ...q, ...dismissal });
    else fresh.questions[fIdx] = { ...fresh.questions[fIdx], ...dismissal };
    writeQuestions(daemon.root, org, fresh);

    if (running)
      emitResolved(running, role, questionId, resolvedBy, 'dismissed', {
        delivery,
        ...(reason ? { reason } : {}),
        ...(skipNote ? { note: skipNote } : {}),
      });
    return { ok: true, role, delivery };
  });
}
