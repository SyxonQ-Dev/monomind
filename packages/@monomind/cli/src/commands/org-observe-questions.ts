// packages/@monomind/cli/src/commands/org-observe-questions.ts
//
// `monomind org questions | answer` — pending ask_human questions and
// their live-or-queued answers. `org questions dismiss` lives in
// org-observe-questions-dismiss.ts.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  closedQuestionReason,
  isOpenQuestion,
  type QuestionDismissal,
  roleRemovedFromOrgDef,
} from '../orgrt/question-state.js';
import { utcDateMinute } from '../orgrt/reporting.js';
import { ORG_DIR } from '../orgrt/types.js';
import { output } from '../output.js';
import type { CommandContext, CommandResult } from '../types.js';
import { hostingDaemonFor, orgJson, printOrgJson, resolverFlag } from './org-observe-shared.js';

const log = (text: string): void => {
  console.log(text);
};

interface OrgQuestion extends QuestionDismissal {
  questionId: string;
  role: string;
  question: string;
  ts: number;
  answer: string | null;
  answeredAt: number | null;
}

/** Read questions.json. A MISSING file legitimately means "no questions" → [].
 *  Any other failure (unreadable, malformed — e.g. a partial daemon write) THROWS:
 *  answerAction rewrites this file from what this returns, so silently coercing a
 *  failed read to [] would atomically replace every recorded question with one. */
export const readQuestions = (cwd: string, name: string): OrgQuestion[] => {
  const path = join(cwd, ORG_DIR, name, 'questions.json');
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error(`cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  let parsed: { questions?: OrgQuestion[] };
  try {
    parsed = JSON.parse(raw) as { questions?: OrgQuestion[] };
  } catch (err) {
    throw new Error(
      `${path} is not valid JSON (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (parsed?.questions === undefined || parsed.questions === null) return [];
  if (!Array.isArray(parsed.questions)) throw new Error(`${path}: "questions" is not an array`);
  return parsed.questions;
};

/** `org questions <name> [--all]` — list pending (or all) ask_human questions. */
export const questionsAction = async (
  ctx: CommandContext,
  name: string,
): Promise<CommandResult> => {
  let all: OrgQuestion[];
  try {
    all = readQuestions(ctx.cwd, name);
  } catch (err) {
    log(
      output.error(
        `Cannot read questions for org ${name}: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
    return { success: false, message: 'questions.json unreadable' };
  }
  const shown = ctx.flags.all === true ? all : all.filter(isOpenQuestion);
  if (orgJson(ctx)) return printOrgJson({ v: 1, org: name, items: shown });
  if (!shown.length) {
    log(
      output.info(
        all.length
          ? `No pending questions for org ${name} (${all.length} answered or dismissed — use --all).`
          : `No questions recorded for org ${name}.`,
      ),
    );
    return { success: true };
  }
  for (const q of shown) {
    const when = utcDateMinute(q.ts);
    const mark = isOpenQuestion(q) ? '❓' : q.state === 'dismissed' ? '✗' : '✓';
    log(output.info(`${mark} [${q.questionId}] ${when}  ${q.role}: ${q.question}`));
    if (q.state === 'dismissed')
      log(output.info(`     ↳ dismissed${q.dismissReason ? `: ${q.dismissReason}` : ''}`));
    else if (q.answer !== null) log(output.info(`     ↳ ${q.answer}`));
  }
  if (shown.some(isOpenQuestion)) {
    log(output.info(`\nAnswer with: monomind org answer ${name} <question-id> "your answer"`));
    log(output.info(`Dismiss with: monomind org questions dismiss ${name} <question-id>`));
  }
  return { success: true };
};

/** `org answer <name> <question-id> <answer...>` — answer a pending ask_human question.
 *  Delivers live via the hosting daemon's /api/answer-question when the org is running
 *  (broker lookup); otherwise records the answer and queues it for the next run. */
export const answerAction = async (ctx: CommandContext, name: string): Promise<CommandResult> => {
  const questionId = ctx.args[1];
  const answer = ctx.args.slice(2).join(' ').trim();
  if (!questionId || !answer)
    return {
      success: false,
      message: `usage: monomind org answer ${name} <question-id> "answer text"`,
    };
  let questions: OrgQuestion[];
  try {
    questions = readQuestions(ctx.cwd, name);
  } catch (err) {
    log(
      output.error(
        `Cannot read questions for org ${name}: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
    return { success: false, message: 'questions.json unreadable — answer not recorded' };
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

  // Live path: the hosting daemon updates questions.json and pushes into the role's mailbox.
  // SEC: answering a role's question is a human decision — authenticate with
  // the operator credential, not the agent-facing one in the broker entry.
  const { readOperatorCredential } = await import('../orgrt/broker.js');
  const remote = await hostingDaemonFor(ctx.cwd, name);
  if (remote) {
    const cred = readOperatorCredential(name);
    try {
      const res = await fetch(`${remote.url}/api/answer-question`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(cred ? { 'x-monomind-cred': cred } : {}),
        },
        body: JSON.stringify({ org: name, role: q.role, questionId, answer, resolvedBy }),
        signal: AbortSignal.timeout(10_000),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        delivery?: 'skipped';
      };
      if (res.ok && data.ok) {
        const delivery = data.delivery ?? 'live';
        if (orgJson(ctx))
          return printOrgJson({
            v: 1,
            org: name,
            question_id: questionId,
            role: q.role,
            delivery,
            answered: true,
            resolvedBy,
          });
        log(
          output.success(
            delivery === 'skipped'
              ? `Answer recorded — ${q.role} is no longer in org ${name}, so it was not delivered.`
              : `Answer delivered to ${name}:${q.role} (live).`,
          ),
        );
        return { success: true };
      }
      // The daemon running this org refused (403 without the operator
      // credential, unknown or closed question): recording the answer behind
      // its back would skip the operator check, delivery and the audit event.
      log(output.error(`Live delivery rejected (${data.error ?? res.status}) — nothing recorded.`));
      return { success: false, message: `answer rejected: ${data.error ?? res.status}` };
    } catch (err) {
      log(
        output.warning(
          `Hosting daemon unreachable (${err instanceof Error ? err.message : 'error'}) — falling back to offline queue.`,
        ),
      );
    }
  }

  // Offline path: mirror daemon.answerQuestion's org-not-running branch.
  // RE-READ and merge by questionId just before writing — the pre-fetch
  // snapshot can be up to 10s stale (live-delivery timeout), and rewriting
  // from it would delete questions the daemon appended meanwhile and revert
  // answers it recorded (atomic rename prevents torn writes, not lost updates).
  // A FAILED re-read must abort the write: rewriting from [] would atomically
  // rename a single-question file over every other recorded question.
  let fresh: OrgQuestion[];
  try {
    fresh = readQuestions(ctx.cwd, name);
  } catch (err) {
    log(
      output.error(
        `Refusing to rewrite questions.json — ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
    log(
      output.warning(
        `The answer was NOT recorded. Fix or restore ${join(ctx.cwd, ORG_DIR, name, 'questions.json')}, then retry.`,
      ),
    );
    return { success: false, message: 'questions.json unreadable — answer not recorded' };
  }
  const freshQ = fresh.find((x) => x.questionId === questionId);
  if (freshQ && !isOpenQuestion(freshQ)) {
    return {
      success: false,
      message: `question "${questionId}" was answered or dismissed while this command was running`,
    };
  }
  // #572: a role removed from the org definition never runs again — record
  // the answer without queueing it for nobody.
  const skipped = roleRemovedFromOrgDef(ctx.cwd, name, q.role);
  // Queue BEFORE marking answered (same rule as daemon.answerQuestion): if the
  // append fails, the question must stay pending and answerable. Marking first meant
  // a failed queueMessage recorded the answer as delivered while nothing was queued,
  // and the `already answered` guard then rejected every retry.
  const { queueMessage } = await import('../orgrt/inbox.js');
  try {
    if (!skipped)
      queueMessage(ctx.cwd, name, {
        fromQualified: 'human',
        toRole: q.role,
        subject: `answer:${questionId}`,
        body: `question: ${q.question}\n\nanswer: ${answer}`,
        ts: Date.now(),
      });
  } catch (err) {
    log(
      output.error(
        `Could not queue the answer for ${name}:${q.role} (${err instanceof Error ? err.message : String(err)}) — answer NOT recorded, retry it.`,
      ),
    );
    return { success: false, message: 'queueing failed — answer not recorded' };
  }
  const merged = fresh.some((x) => x.questionId === questionId)
    ? fresh.map((x) =>
        x.questionId === questionId ? { ...x, answer, answeredAt: Date.now(), resolvedBy } : x,
      )
    : [...fresh, { ...q, answer, answeredAt: Date.now(), resolvedBy }];
  const dest = join(ctx.cwd, ORG_DIR, name, 'questions.json');
  const tmp = `${dest}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ questions: merged }, null, 2));
  const { renameSync } = await import('node:fs');
  renameSync(tmp, dest);
  if (orgJson(ctx))
    return printOrgJson({
      v: 1,
      org: name,
      question_id: questionId,
      role: q.role,
      delivery: skipped ? 'skipped' : 'queued',
      answered: true,
      resolvedBy,
    });
  log(
    output.success(
      skipped
        ? `Answer recorded — ${q.role} is no longer in org ${name}, so it was not queued.`
        : `Answer recorded — ${name}:${q.role} receives it when the org next runs.`,
    ),
  );
  return { success: true };
};
