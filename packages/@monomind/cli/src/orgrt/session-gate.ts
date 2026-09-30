// packages/@monomind/cli/src/orgrt/session-gate.ts
// Extracted from session.ts — the canUseTool gate every role session runs behind.
import type { ApprovalVerdict } from './approval-decider.js';
import { resolverLabel } from './approval-waiters.js';
import type { RoleFence } from './fence.js';
import { scanInput } from './fence.js';
import type { Decision, PolicyEngine } from './policy.js';
import type { SessionOpts } from './session-types.js';
import type { DecisionKind } from './types.js';

/** #553: a beforeTool result as a verdict; a bare boolean/null is human-owned. */
function asVerdict(result: boolean | null | ApprovalVerdict): ApprovalVerdict {
  return typeof result === 'object' && result !== null
    ? result
    : { approved: result, owner: 'human' };
}

/** #553: what the gate does with a beforeTool result — run the call, or
 *  deny it with the message and decision kind that fit who owns it. */
export function approvalGateOutcome(
  toolName: string,
  result: boolean | null | ApprovalVerdict,
): { allow: true } | { allow: false; message: string; kind: DecisionKind } {
  const v = asVerdict(result);
  if (v.approved === true) return { allow: true };
  if (v.approved === false)
    return { allow: false, message: approvalDeniedMessage(toolName, v), kind: 'approval-denied' };
  return { allow: false, message: approvalPendingMessage(toolName, v), kind: 'approval-pending' };
}

/** #492: the tool result a role sees while ONE call waits for a human's
 *  approve/deny. Roles read the old one-liner as "the task queue is stuck";
 *  this says what is waiting and what to do meanwhile. Keeps the leading
 *  "pending human approval" phrase the old text had.
 *  #553: a request the org's autonomy routes away from a person, which the
 *  call already waited on, says so. It may still have escalated to a person
 *  (decider failure, a cap, an `escalate` verdict), so it names neither. */
export function approvalPendingMessage(toolName: string, verdict?: ApprovalVerdict): string {
  if (verdict?.owner === 'decider') {
    const why = verdict.cancelled
      ? 'the org or this role is stopping'
      : `no decision within ${Math.round((verdict.waitedMs ?? 0) / 1000)}s`;
    return (
      `Tool "${toolName}" waited for the org's autonomy (${verdict.decider ?? 'decider'}) to decide this one ${toolName} call, but ${why}. ` +
      `The request stays queued: a decider or a human will resolve it, and an [approval] message follows. ` +
      `Only this call is held; your task queue is not stuck and your other tools still work. ` +
      `Meanwhile, continue with other work that does not need this call, and do not retry this identical call while it is pending. ` +
      `If the [approval] message says it was approved, repeat the identical call and it will run; if it was denied, choose another approach.`
    );
  }
  return (
    `Tool "${toolName}" is pending human approval — this one ${toolName} call is waiting for a human to approve or deny it via 'monomind org approve/deny'. ` +
    `Only this call is held; your task queue is not stuck and your other tools still work. ` +
    `Meanwhile, continue with other work that does not need this call, and do not retry this identical call while it is pending. ` +
    `Once it is approved, repeat the identical call and it will run; if it is denied, choose another approach.`
  );
}

/** #492: the tool result after a human denied ONE call. The identical call
 *  stays denied (checkApproval keys decisions on the call's fingerprint). */
export function approvalDeniedMessage(toolName: string, verdict?: ApprovalVerdict): string {
  // #553: named from who actually resolved it (a rule, a decider, a person).
  const who = resolverLabel(verdict?.resolvedBy);
  return (
    `Tool "${toolName}" was denied by guardrail approval — ${who} refused this one ${toolName} call. ` +
    `Your task queue is not stuck and your other tools still work. ` +
    `Do not retry the identical call (it stays denied); ` +
    (toolName === 'org_send'
      ? `choose another approach, for example record what you needed to send in your task result.`
      : `choose another approach, or report the blocker via org_send.`)
  );
}

/** The SDK's `canUseTool` gate, composed from two independent layers: PolicyEngine's
 *  static config checks (deny/allow lists, path scoping, git level, web allowlist,
 *  budget), then — only for calls policy would allow — the human-approval guardrail
 *  (`beforeTool`, i.e. daemon.checkApproval) for whatever action names it treats as
 *  sensitive (Bash/WebFetch/WebSearch/org_complete). Exported standalone so this
 *  composition is unit-testable without spinning up a real SDK session: previously
 *  `beforeTool` was wired into SessionOpts but never actually called from here, so
 *  none of those sensitive actions ever paused for a human. */
export function gatedCanUseTool(
  policy: PolicyEngine,
  beforeTool: SessionOpts['beforeTool'],
  roleId: string,
  fence?: RoleFence,
  /** Optional hook invoked whenever this gate denies a tool call — wired to
   *  daemon.recordDecision() so denials show up in `org decisions` traces.
   *  #290: `kind` names WHICH of this function's four deny paths fired, so a
   *  consumer never has to tell a fence block from a routine pending approval
   *  by matching the English in the message. */
  onDeny?: (
    toolName: string,
    input: Record<string, unknown>,
    decision: Extract<Decision, { behavior: 'deny' }>,
    kind: DecisionKind,
  ) => void,
  /** ORG-9: reports whether this role has a pending (unresolved) decision gate.
   *  org_gate is documented as creating a "hard-blocking" checkpoint, but until
   *  this was wired in nothing actually stopped tool use while a gate sat
   *  pending — only approvals did that. When set and true, ALL tool calls are
   *  denied (not just the sensitive subset approvals gate) until the gate is
   *  resolved, matching the "hard-blocking" description. */
  hasPendingGate?: () => boolean,
): (
  toolName: string,
  input: Record<string, unknown>,
  /** #289: the harness's id for this call, forwarded to policy.decide so the
   *  invocation event can be joined to the later tool_result event. */
  meta?: { toolUseId?: string },
) => Promise<Decision> {
  return async (
    toolName: string,
    input: Record<string, unknown>,
    meta?: { toolUseId?: string },
  ): Promise<Decision> => {
    if (hasPendingGate?.()) {
      const decision: Decision = {
        behavior: 'deny',
        message: `Tool "${toolName}" is blocked — awaiting gate resolution. A decision gate is pending; wait for a human to approve or reject it via 'monomind org gate-approve/gate-reject'.`,
      };
      onDeny?.(toolName, input, decision, 'gate-pending');
      return decision;
    }
    if (fence) {
      const text =
        typeof input.command === 'string'
          ? input.command
          : typeof input.content === 'string'
            ? input.content
            : typeof input.url === 'string'
              ? input.url
              : JSON.stringify(input);
      const fenceDecision = await scanInput(fence.instance, text, fence.abortThreshold);
      if (fenceDecision.behavior === 'deny') {
        onDeny?.(toolName, input, fenceDecision, 'fence-block');
        return fenceDecision;
      }
    }
    const decision = await policy.decide(toolName, input, meta?.toolUseId);
    if (decision.behavior === 'deny') {
      onDeny?.(toolName, input, decision, 'policy-deny');
      return decision;
    }
    if (!beforeTool) return decision;
    // #553: for a decider-owned request beforeTool waits (bounded) for the
    // decider's verdict, so an approval there lets this call run now.
    const outcome = approvalGateOutcome(toolName, await beforeTool(roleId, toolName, input));
    if (outcome.allow) return decision;
    const denied: Decision = { behavior: 'deny', message: outcome.message };
    onDeny?.(toolName, input, denied, outcome.kind);
    return denied;
  };
}
