// packages/@monomind/cli/src/orgrt/approval-decider.ts
/**
 * #553: approvals a decider owns wait inline for its verdict.
 *
 * An org's `autonomy` block (written by mono-agent, passed through
 * OrgDefSchema untouched) can hand approval requests to a decider — a model,
 * the boss, the parent org or jev — that resolves them over
 * /api/set-approval. checkApproval only ever answered "pending", so the
 * role's call was denied as "pending human approval" while the decider
 * resolved it seconds later, and the role had to notice and retry. Each
 * distinct Bash command cost a denied call plus a retry.
 *
 * awaitApproval queues the request as before and, when a decider owns it,
 * holds the tool call until the decider resolves it or the bounded wait
 * runs out. Human-owned requests return at once, as before.
 */

import { checkApprovalEntry, waitForApprovalResolution } from './approvals.js';
import type { OrgDaemon } from './daemon.js';

/** Default wait when the decider sets no timeout_seconds. */
export const DECIDER_WAIT_DEFAULT_S = 120;
/** Upper bound on the inline wait. Claude's PreToolUse hook lets a call
 *  PROCEED when the hook times out (POLICY_HOOK_TIMEOUT_S, 600s), so the
 *  wait stays well below that. */
export const DECIDER_WAIT_MAX_S = 300;

export type ApprovalOwnership =
  | { owner: 'human' }
  | { owner: 'decider'; decider: string; waitMs: number };

/** What the approval gate returns: the verdict plus who owns the request.
 *  `approved: null` means still pending (a human request, or a decider that
 *  did not decide within `waitedMs`). */
export interface ApprovalVerdict {
  approved: boolean | null;
  owner: 'human' | 'decider';
  /** Decider label (e.g. `model claude-opus`) when owner is 'decider'. */
  decider?: string;
  /** Who resolved it (resolvedBy), when resolved. */
  resolvedBy?: string;
  /** How long the call waited on the decider, when it waited. */
  waitedMs?: number;
}

const LEVELS_WITH_DECIDER = new Set(['mid', 'full']);

/** Who resolves an approval request for `action` in this org def.
 *  mono-agent's autonomy levels: manual — a person decides everything; mid —
 *  rules approve routine, the decider consequential, a person irreversible;
 *  full — the decider handles everything above routine. Anything this code
 *  does not recognise stays human-owned (the pre-#553 behaviour). */
export function approvalOwnership(def: unknown, action: string): ApprovalOwnership {
  const autonomy = (def as { autonomy?: unknown } | undefined)?.autonomy as
    | {
        level?: unknown;
        decider?: { kind?: unknown; model?: unknown; timeout_seconds?: unknown };
        tiers?: Record<string, unknown>;
      }
    | undefined;
  if (!autonomy || typeof autonomy !== 'object') return { owner: 'human' };
  const level = autonomy.level;
  const decider = autonomy.decider;
  if (typeof level !== 'string' || !LEVELS_WITH_DECIDER.has(level)) return { owner: 'human' };
  if (!decider || typeof decider.kind !== 'string' || !decider.kind || decider.kind === 'human')
    return { owner: 'human' };
  if (level === 'mid' && autonomy.tiers?.[action] === 'irreversible') return { owner: 'human' };
  const t = decider.timeout_seconds;
  const seconds =
    typeof t === 'number' && Number.isFinite(t) && t > 0
      ? Math.min(t, DECIDER_WAIT_MAX_S)
      : DECIDER_WAIT_DEFAULT_S;
  const label =
    typeof decider.model === 'string' && decider.model
      ? `${decider.kind} ${decider.model}`
      : decider.kind;
  return { owner: 'decider', decider: label, waitMs: Math.round(seconds * 1000) };
}

/** checkApproval, plus the #553 inline wait for a decider-owned request. */
export async function awaitApproval(
  daemon: OrgDaemon,
  org: string,
  role: string,
  action: string,
  input: Record<string, unknown> = {},
): Promise<ApprovalVerdict> {
  const { approved, entry } = await checkApprovalEntry(daemon, org, role, action, input);
  const ownership = approvalOwnership(daemon.orgs.get(org)?.def, entry?.action ?? action);
  if (ownership.owner === 'human')
    return { approved, owner: 'human', resolvedBy: entry?.resolvedBy };
  const base = { owner: 'decider' as const, decider: ownership.decider };
  if (approved !== null || !entry) return { ...base, approved, resolvedBy: entry?.resolvedBy };
  const started = Date.now();
  const verdict = await waitForApprovalResolution(entry, ownership.waitMs);
  return {
    ...base,
    approved: verdict,
    resolvedBy: entry.resolvedBy,
    waitedMs: Date.now() - started,
  };
}
