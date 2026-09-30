// packages/@monomind/cli/src/orgrt/question-state.ts
//
// #572: the lifecycle of an ask_human question, shared by the daemon
// (questions.ts), the CLI (org-observe-questions.ts) and the dashboard
// (ui/org-hil.mjs). A question is open until a human answers or dismisses it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ORG_DIR } from './types.js';

/** A dismissed question: closed without an answer. Recorded in questions.json
 *  next to the question itself; `answer` stays null. */
export interface QuestionDismissal {
  state?: 'dismissed';
  dismissedAt?: number;
  dismissReason?: string;
}

/** Only an open question is pending: it holds the idle watchdog and (when
 *  blocking) org_complete, and it can still be answered or dismissed. */
export function isOpenQuestion(q: { answer?: string | null; state?: string }): boolean {
  return (q.answer === null || q.answer === undefined) && q.state !== 'dismissed';
}

/** Why a question can no longer be answered or dismissed, or null if it is open. */
export function closedQuestionReason(
  questionId: string,
  q: { answer?: string | null; state?: string },
): string | null {
  if (q.state === 'dismissed') return `question "${questionId}" was already dismissed`;
  if (q.answer !== null && q.answer !== undefined)
    return `question "${questionId}" was already answered`;
  return null;
}

/** Whether the org's saved definition has a role `role`; undefined when that
 *  definition is missing or unreadable (it then says nothing about the role). */
export function savedOrgDefHasRole(root: string, org: string, role: string): boolean | undefined {
  let def: { roles?: unknown };
  try {
    def = JSON.parse(readFileSync(join(root, ORG_DIR, `${org}.json`), 'utf8'));
  } catch {
    return undefined;
  }
  if (!Array.isArray(def?.roles)) return undefined;
  return def.roles.some((r) => (r as { id?: unknown } | null)?.id === role);
}

/** True only when the org's saved definition is readable and no longer has a
 *  role `role`. A missing or unreadable definition says nothing about the
 *  role, so it is never taken as "removed". */
export function roleRemovedFromOrgDef(root: string, org: string, role: string): boolean {
  return savedOrgDefHasRole(root, org, role) === false;
}

/** The note the asking role receives when its question is dismissed, so it
 *  stops waiting for an answer that is not coming. */
export function dismissalNote(question: string, reason?: string): string {
  return (
    `question: ${question}\n\n` +
    (reason ? `reason: ${reason}\n\n` : '') +
    'A human dismissed this question — no answer is coming. Do not wait for one: carry on without it, or ask again with ask_human if you still need it.'
  );
}
