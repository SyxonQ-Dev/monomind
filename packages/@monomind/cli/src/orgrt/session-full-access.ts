// packages/@monomind/cli/src/orgrt/session-full-access.ts
// Extracted from session-run.ts (#365, kept out to stay under this project's
// 500-line file cap): the per-session setup/teardown for a role whose
// access resolved to 'full' — the one-time audit events, the
// ToolActivityTracker wiring (#357's tool_activity shape, reused per the
// issue), and the `~/.monomind/logs/agent-exec-full-access.log` line.

import { isUnattendedRun, type ResolvedAccess, resolveRoleAccess } from './access-grant.js';
import type { OrgBus } from './bus.js';
import { appendFullAccessAudit } from './full-access-audit.js';
import { ToolActivityTracker } from './tool-activity.js';
import type { OrgDef, OrgRole } from './types.js';

export interface FullAccessSession {
  resolvedAccess: ResolvedAccess;
  /** Set only when resolvedAccess.access === 'full'. */
  tracker?: ToolActivityTracker;
}

/** Resolve this session's access mode and, when active, set up its
 *  tool_activity tracker and audit events. Called once per `runOneSession`
 *  attempt, before the role's git enforcement is built. */
export function beginFullAccessSession(
  bus: OrgBus,
  role: OrgRole,
  def: OrgDef | undefined,
  runtimeKey: string,
): FullAccessSession {
  const resolvedAccess = def
    ? resolveRoleAccess(def, role, { unattended: isUnattendedRun(def), runtimeId: runtimeKey })
    : ({ access: 'scoped', declared: 'scoped' } as const);

  if (resolvedAccess.declared === 'full' && resolvedAccess.access !== 'full') {
    bus.emit({
      type: 'audit',
      from: role.id,
      reason: 'full-access-not-active',
      msg: `role "${role.id}" declares policy.access 'full' but is running scoped this session (${resolvedAccess.state}): ${resolvedAccess.reason}`,
      data: { state: resolvedAccess.state },
    });
    return { resolvedAccess };
  }
  if (resolvedAccess.access !== 'full') return { resolvedAccess };

  bus.emit({
    type: 'audit',
    from: role.id,
    reason: 'full-access-active',
    msg: `role "${role.id}" running with full access this session — no allow-list, no OS sandbox, no per-tool approval gate; budgets still enforced`,
  });
  const tracker = new ToolActivityTracker((ev) =>
    bus.emit({ type: 'tool_activity', from: role.id, data: ev }),
  );
  return { resolvedAccess, tracker };
}

/** Close any tool_activity call left open by an aborted/erroring stream and
 *  append the one audit-log line for this attempt. No-op when this session
 *  was not running with active full access. */
export function endFullAccessSession(
  session: FullAccessSession,
  args: {
    org: string;
    role: string;
    cwd: string;
    runtime: string;
    sessionId: string | undefined;
    exitCode: number;
    toolCalls: number;
  },
): void {
  if (!session.tracker) return;
  session.tracker.closeInFlight();
  appendFullAccessAudit({
    ts: new Date().toISOString(),
    cwd: args.cwd,
    runtime: args.runtime,
    sessionId: args.sessionId,
    exitCode: args.exitCode,
    toolCalls: args.toolCalls,
    org: args.org,
    role: args.role,
  });
}
