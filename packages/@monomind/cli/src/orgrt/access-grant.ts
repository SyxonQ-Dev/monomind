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
import { readFullAccessGrantKey, verifyAccessAckSignature } from './access-grant-key.js';
import { fullAccessTaintFindings } from './access-taint.js';
import { runnerSpec } from './runner-registry.js';
import { effectiveRoleRuntime } from './runner-specs.js';
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
  opts: {
    unattended?: boolean;
    runtimeId?: string;
    grantKeyDir?: string;
    getuid?: () => number;
  } = {},
): ResolvedAccess {
  const declared = (role.policy?.access ?? 'scoped') as 'scoped' | 'full';
  if (declared !== 'full') return { access: 'scoped', declared: 'scoped' };

  // #567: the runner that hosts the role, provider.kind included.
  const runtimeId =
    opts.runtimeId ?? effectiveRoleRuntime(role.runtime, def.runtime, role.provider?.kind);
  const spec = runnerSpec(runtimeId);
  if (!spec?.supportsFullAccess) {
    return {
      access: 'scoped',
      declared: 'full',
      state: 'suspended',
      reason: `runtime "${runtimeId}" does not support full access — running scoped`,
    };
  }

  // Same refusal as `agent exec --access full` (agent-exec-access.ts): no
  // CLI's no-approval mode as root, whichever runtime the role uses.
  const getuid = opts.getuid ?? process.getuid?.bind(process);
  if (getuid && getuid() === 0) {
    return {
      access: 'scoped',
      declared: 'full',
      state: 'suspended',
      reason: 'the org runs as root (uid 0) — full access refuses root on every runtime',
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
  // #365 (integrator review): `hash` alone is a PUBLIC drift check — anyone
  // who can write the org JSON could recompute it. Verify the HMAC `sig`
  // against the machine-local grant key (access-grant-key.ts, stored where
  // no scoped/sandboxed role can read it) BEFORE trusting `hash` at all, so
  // a forged ack (correct hash, no/invalid sig) is refused the same way a
  // missing one is — distinguished only for a human reading `org status`.
  if (!ack.sig) {
    return {
      access: 'scoped',
      declared: 'full',
      state: 'suspended',
      reason:
        'access_ack has no signature (unsigned) — re-run `monomind org role set-access <org> <role> full`',
    };
  }
  const key = readFullAccessGrantKey(opts.grantKeyDir);
  const sigOk = verifyAccessAckSignature({
    org: def.name,
    role: role.id,
    hash: ack.hash,
    at: ack.at,
    by: ack.by,
    sig: ack.sig,
    key,
  });
  if (!sigOk) {
    return {
      access: 'scoped',
      declared: 'full',
      state: 'suspended',
      reason:
        'access_ack signature is invalid (invalid-signature) — the grant key may be missing on this host; re-run `monomind org role set-access <org> <role> full`',
    };
  }
  const expected = computeAccessAckHash(def, role);
  if (ack.hash !== expected) {
    return {
      access: 'scoped',
      declared: 'full',
      state: 'suspended',
      reason:
        'role or org config changed since the access grant (config-changed) — re-acknowledge with `monomind org role set-access <org> <role> full`',
    };
  }

  // #365 "enforced by org validate / at start": a taint error (this role
  // reads untrusted input, or is reachable from a role that does without an
  // accepted path) also blocks it at runtime — another role's config can
  // change after the grant without touching this role's ack hash.
  const taint = fullAccessTaintFindings(def).errors.find((e) => e.startsWith(`role ${role.id}:`));
  if (taint) {
    return {
      access: 'scoped',
      declared: 'full',
      state: 'suspended',
      reason: `untrusted-input path into this role (tainted) — ${taint.slice(`role ${role.id}: `.length)}`,
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
