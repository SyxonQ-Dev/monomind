// packages/@monomind/cli/src/orgrt/session-gate.ts
// Extracted from session.ts — the canUseTool gate every role session runs behind.
import type { RoleFence } from './fence.js';
import { scanInput } from './fence.js';
import type { Decision, PolicyEngine } from './policy.js';
import type { SessionOpts } from './session-types.js';
import type { DecisionKind } from './types.js';

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
    const approved = await beforeTool(roleId, toolName, input);
    if (approved === false) {
      const denied: Decision = {
        behavior: 'deny',
        message: `Tool "${toolName}" was denied by guardrail approval`,
      };
      onDeny?.(toolName, input, denied, 'approval-denied');
      return denied;
    }
    if (approved === null) {
      const pending: Decision = {
        behavior: 'deny',
        message: `Tool "${toolName}" is pending human approval — it will be available once approved or denied via 'monomind org approve/deny'.`,
      };
      onDeny?.(toolName, input, pending, 'approval-pending');
      return pending;
    }
    return decision;
  };
}
