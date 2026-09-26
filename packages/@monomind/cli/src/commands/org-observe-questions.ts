// packages/@monomind/cli/src/commands/org-observe-questions.ts
//
// `monomind org questions | answer` — pending ask_human questions and
// their live-or-queued answers.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { utcDateMinute } from '../orgrt/reporting.js';
import { ORG_DIR } from '../orgrt/types.js';
import { output } from '../output.js';
import type { CommandContext, CommandResult } from '../types.js';
import { orgJson, printOrgJson, resolverFlag } from './org-observe-shared.js';

const log = (text: string): void => {
  console.log(text);
};

interface OrgQuestion {
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
const readQuestions = (cwd: string, name: string): OrgQuestion[] => {
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
  const shown = ctx.flags.all === true ? all : all.filter((q) => q.answer === null);
  if (orgJson(ctx)) return printOrgJson({ v: 1, org: name, items: shown });
  if (!shown.length) {
    log(
      output.info(
        all.length
          ? `No pending questions for org ${name} (${all.length} answered — use --all).`
          : `No questions recorded for org ${name}.`,
      ),
    );
    return { success: true };
  }
  for (const q of shown) {
    const when = utcDateMinute(q.ts);
    log(
      output.info(
        `${q.answer === null ? '❓' : '✓'} [${q.questionId}] ${when}  ${q.role}: ${q.question}`,
      ),
    );
    if (q.answer !== null) log(output.info(`     ↳ ${q.answer}`));
  }
  if (shown.some((q) => q.answer === null))
    log(output.info(`\nAnswer with: monomind org answer ${name} <question-id> "your answer"`));
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
  if (q.answer !== null)
    return { success: false, message: `question "${questionId}" was already answered` };
  const byFlag = await resolverFlag(ctx);
  if (!byFlag.ok) return { success: false, message: byFlag.message };
  const resolvedBy = byFlag.by;

  // Live path: the hosting daemon updates questions.json and pushes into the role's mailbox.
  // SEC: answering a role's question is a human decision — authenticate with
  // the operator credential, not the agent-facing one in the broker entry.
  const { lookupOrg, readOperatorCredential } = await import('../orgrt/broker.js');
  const remote = lookupOrg(name);
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
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (res.ok && data.ok) {
        if (orgJson(ctx))
          return printOrgJson({
            v: 1,
            org: name,
            question_id: questionId,
            role: q.role,
            delivery: 'live',
            answered: true,
            resolvedBy,
          });
        log(output.success(`Answer delivered to ${name}:${q.role} (live).`));
        return { success: true };
      }
      log(
        output.warning(
          `Live delivery rejected (${data.error ?? res.status}) — falling back to offline queue.`,
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
  if (freshQ && freshQ.answer !== null) {
    return {
      success: false,
      message: `question "${questionId}" was answered while this command was running`,
    };
  }
  // Queue BEFORE marking answered (same rule as daemon.answerQuestion): if the
  // append fails, the question must stay pending and answerable. Marking first meant
  // a failed queueMessage recorded the answer as delivered while nothing was queued,
  // and the `already answered` guard then rejected every retry.
  const { queueMessage } = await import('../orgrt/inbox.js');
  try {
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
      delivery: 'queued',
      answered: true,
      resolvedBy,
    });
  log(output.success(`Answer recorded — ${name}:${q.role} receives it when the org next runs.`));
  return { success: true };
};
