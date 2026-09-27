// packages/@monomind/cli/src/orgrt/access-grant.ts
/**
 * #365 (Coder mode for org roles): the ONE function that turns a role's
 * declared `policy.access` into the mode the runtime actually runs it with.
 * `session-run.ts` calls this every session start (initial spawn, crash
 * restart, and the next process after a hot `org reload`) and MUST use its
 * `access` field rather than reading `role.policy?.access` directly —
 * `access_ack` can be stale (a config edit after the grant), missing (never
 * granted, or stripped by a config-writing path), or pointed at a runtime
 * that doesn't support full access, and only this function checks all three.
 */

import { computeAccessAckHash } from './access-ack.js';
import { runnerSpec } from './runner-registry.js';
import type { OrgDef, OrgRole } from './types.js';

export type AccessState = 'active' | 'suspended' | 'unattended-blocked';

export interface ResolvedAccess {
  /** What the runtime actually does this session — the only field
   *  session-run.ts should branch on. */
  access: 'scoped' | 'full';
  /** What `policy.access` says (for `org status`/`org get --json`). */
  declared: 'scoped' | 'full';
  /** Present only when `declared === 'full'`. */
  state?: AccessState;
  /** Human-readable — surfaced by `org status` and the one-time session
   *  audit event when a full-access grant does not take effect. */
  reason?: string;
}

/** #365: a scheduled org (`schedule` set) is "unattended" whether it is
 *  ticked by `org serve`'s daemon or picked up by a runfile/poll trigger —
 *  either way nobody is necessarily watching a terminal. An org with no
 *  schedule is only ever started by an explicit `org run`/`org serve` call,
 *  which this project treats as attended for this gate. */
export function isUnattendedRun(def: Pick<OrgDef, 'schedule'>): boolean {
  return def.schedule !== null && def.schedule !== undefined;
}

/** Resolve one role's effective access mode for a session about to start.
 *  Pure and synchronous — no I/O, no bus emission (callers audit the result
 *  themselves so the message lands with the right `from`/context). */
export function resolveRoleAccess(
  def: OrgDef,
  role: OrgRole,
  opts: { unattended?: boolean; runtimeId?: string } = {},
): ResolvedAccess {
  const declared = (role.policy?.access ?? 'scoped') as 'scoped' | 'full';
  if (declared !== 'full') return { access: 'scoped', declared: 'scoped' };

  const runtimeId = opts.runtimeId ?? role.runtime ?? def.runtime ?? 'claude';
  const spec = runnerSpec(runtimeId);
  if (!spec?.supportsFullAccess) {
    return {
      access: 'scoped',
      declared: 'full',
      state: 'suspended',
      reason: `runtime "${runtimeId}" does not support full access — running scoped`,
    };
  }

  const ack = role.policy?.access_ack;
  if (ack?.by !== 'human' || !ack.hash) {
    return {
      access: 'scoped',
      declared: 'full',
      state: 'suspended',
      reason:
        'no human acknowledgement on file — run `monomind org role set-access <org> <role> full`',
    };
  }
  const expected = computeAccessAckHash(def, role);
  if (ack.hash !== expected) {
    return {
      access: 'scoped',
      declared: 'full',
      state: 'suspended',
      reason:
        'role or org config changed since the access grant — re-acknowledge with `monomind org role set-access <org> <role> full`',
    };
  }

  const unattended = opts.unattended ?? isUnattendedRun(def);
  const runConfig = def.run_config as { allow_unattended_full_access?: boolean };
  if (unattended && runConfig.allow_unattended_full_access !== true) {
    return {
      access: 'scoped',
      declared: 'full',
      state: 'unattended-blocked',
      reason:
        'unattended run (schedule set) needs run_config.allow_unattended_full_access — running scoped',
    };
  }

  return { access: 'full', declared: 'full', state: 'active' };
}

/** `org status`/`org get --json` visibility (#365, capability
 *  `org-role-full-access`): every `policy.access: 'full'` role in `def`,
 *  with its resolved access/state. Empty for an org with no such role, so
 *  the common case adds nothing to existing output. */
export function rolesAccessStatus(
  def: OrgDef,
): Array<{ role: string; access: 'scoped' | 'full'; access_state: AccessState; reason?: string }> {
  const unattended = isUnattendedRun(def);
  const out: Array<{
    role: string;
    access: 'scoped' | 'full';
    access_state: AccessState;
    reason?: string;
  }> = [];
  for (const role of def.roles) {
    if ((role.policy?.access ?? 'scoped') !== 'full') continue;
    const resolved = resolveRoleAccess(def, role, { unattended });
    out.push({
      role: role.id,
      access: resolved.access,
      access_state: resolved.state ?? 'active',
      ...(resolved.reason ? { reason: resolved.reason } : {}),
    });
  }
  return out;
}
