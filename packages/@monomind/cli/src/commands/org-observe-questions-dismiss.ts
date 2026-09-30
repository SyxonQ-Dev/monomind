// packages/@monomind/cli/src/commands/org-observe-questions-dismiss.ts
//
// `monomind org questions dismiss <org> <id> [--reason]` (#572) — close a
// pending ask_human question without an answer. Live through the hosting
// daemon's /api/dismiss-question when the org runs; otherwise recorded in
// questions.json with a note queued for the asking role.

import { renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  closedQuestionReason,
  dismissalNote,
  roleRemovedFromOrgDef,
} from '../orgrt/question-state.js';
import { ORG_DIR } from '../orgrt/types.js';
import { output } from '../output.js';
import type { CommandContext, CommandResult } from '../types.js';
import { readQuestions } from './org-observe-questions.js';
import { orgJson, printOrgJson, resolverFlag } from './org-observe-shared.js';

const log = (text: string): void => {
  console.log(text);
};

type Delivery = 'live' | 'queued' | 'skipped';

export const dismissAction = async (ctx: CommandContext, name: string): Promise<CommandResult> => {
  const questionId = ctx.args[1];
  if (!questionId)
    return {
      success: false,
      message: `usage: monomind org questions dismiss ${name} <question-id> [--reason "text"]`,
    };
  const rawReason = ctx.flags.reason;
  if (rawReason !== undefined && typeof rawReason !== 'string')
    return { success: false, message: '--reason needs a text value' };
  const reason = rawReason?.trim() || undefined;
  if (reason && reason.length > 4000)
    return { success: false, message: '--reason must be at most 4000 characters' };

  let questions: ReturnType<typeof readQuestions>;
  try {
    questions = readQuestions(ctx.cwd, name);
  } catch (err) {
    log(
      output.error(
        `Cannot read questions for org ${name}: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
    return { success: false, message: 'questions.json unreadable — nothing dismissed' };
  }
  const q = questions.find((x) => x.questionId === questionId);
  if (!q) {
    log(
      output.error(
        `Question "${questionId}" not found for org ${name} — list with: monomind org questions ${name}`,
      ),
    );
    return { success: false, message: 'question not found' };
  }
  const closed = closedQuestionReason(questionId, q);
  if (closed) return { success: false, message: closed };
  const byFlag = await resolverFlag(ctx);
  if (!byFlag.ok) return { success: false, message: byFlag.message };
  const resolvedBy = byFlag.by;

  const done = (delivery: Delivery): CommandResult => {
    if (orgJson(ctx))
      return printOrgJson({
        v: 1,
        org: name,
        question_id: questionId,
        role: q.role,
        delivery,
        dismissed: true,
        resolvedBy,
      });
    const told =
      delivery === 'live'
        ? `${name}:${q.role} was told (live)`
        : delivery === 'queued'
          ? `${name}:${q.role} is told when the org next runs`
          : `no note sent to ${q.role} (not in the org any more, or not reachable)`;
    log(output.success(`Question ${questionId} dismissed — ${told}.`));
    return { success: true };
  };

  // Live path: the hosting daemon records it, tells the role and emits the audit event.
  const { lookupOrg, normalizeRoot, readOperatorCredential } = await import('../orgrt/broker.js');
  const found = lookupOrg(name);
  // Only a daemon hosting THIS project's org (same rule as the dashboard's hostingDaemon).
  const remote = found && (!found.root || found.root === normalizeRoot(ctx.cwd)) ? found : null;
  if (remote) {
    const cred = readOperatorCredential(name);
    try {
      const res = await fetch(`${remote.url}/api/dismiss-question`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(cred ? { 'x-monomind-cred': cred } : {}),
        },
        body: JSON.stringify({ org: name, questionId, reason, resolvedBy }),
        signal: AbortSignal.timeout(10_000),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        delivery?: Delivery;
      };
      if (res.ok && data.ok) return done(data.delivery ?? 'live');
      // The daemon that runs this org refused (403 without the operator
      // credential, or the question is closed): writing questions.json behind
      // its back would close a blocking question — and release org_complete —
      // without the operator check, the role's note or the audit event.
      log(
        output.error(`Live dismissal rejected (${data.error ?? res.status}) — nothing dismissed.`),
      );
      return { success: false, message: `dismissal rejected: ${data.error ?? res.status}` };
    } catch (err) {
      log(
        output.warning(
          `Hosting daemon unreachable (${err instanceof Error ? err.message : 'error'}) — recording it offline.`,
        ),
      );
    }
  }

  // Offline path: re-read and merge by questionId (see answerAction for why).
  let fresh: ReturnType<typeof readQuestions>;
  try {
    fresh = readQuestions(ctx.cwd, name);
  } catch (err) {
    log(
      output.error(
        `Refusing to rewrite questions.json — ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
    return { success: false, message: 'questions.json unreadable — nothing dismissed' };
  }
  const freshQ = fresh.find((x) => x.questionId === questionId);
  const closedNow = freshQ && closedQuestionReason(questionId, freshQ);
  if (closedNow) return { success: false, message: closedNow };

  // The note is best-effort: the dismissal is recorded either way, because
  // its job is to close the question. A removed role gets no note.
  let delivery: Delivery = 'skipped';
  if (!roleRemovedFromOrgDef(ctx.cwd, name, q.role)) {
    const { queueMessage } = await import('../orgrt/inbox.js');
    const queued = queueMessage(ctx.cwd, name, {
      fromQualified: 'human',
      toRole: q.role,
      subject: `dismissed:${questionId}`,
      body: dismissalNote(q.question, reason),
      ts: Date.now(),
    });
    if (queued) delivery = 'queued';
  }
  const dismissal = {
    state: 'dismissed' as const,
    dismissedAt: Date.now(),
    ...(reason ? { dismissReason: reason } : {}),
    resolvedBy,
  };
  const merged = freshQ
    ? fresh.map((x) => (x.questionId === questionId ? { ...x, ...dismissal } : x))
    : [...fresh, { ...q, ...dismissal }];
  const dest = join(ctx.cwd, ORG_DIR, name, 'questions.json');
  const tmp = `${dest}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ questions: merged }, null, 2));
  renameSync(tmp, dest);
  return done(delivery);
};
