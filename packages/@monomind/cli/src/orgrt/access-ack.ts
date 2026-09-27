// packages/@monomind/cli/src/orgrt/access-ack.ts
/**
 * #365 (Coder mode for org roles): the `access_ack.hash` computation.
 *
 * The hash is a DRIFT DETECTOR, not a secret: it covers every field of a
 * role's config that is security-relevant to a `policy.access: 'full'`
 * grant (what it runs, what it can reach, who can talk to it) plus the two
 * org-level knobs that gate an unattended run and accept a taint path. Both
 * `monomind org role set-access` (the only place that WRITES an
 * `access_ack`) and the runtime (which recomputes and compares it every
 * session start, see access-grant.ts) call the exact same function on the
 * exact same (zod-parsed) shapes, so a grant survives an org file being
 * re-saved with the same content, and any change to a covered field —
 * anyone's edit, not just an attacker's — invalidates it.
 *
 * Deliberately a plain SHA-256, not an HMAC: this project's existing
 * same-user threat model already documents comparable bypasses as accepted
 * (role-sandbox.ts's git guard, "a same-user role can bypass"). The real
 * guarantee is that `resolveRoleAccess` (access-grant.ts) is the ONLY code
 * path that turns `access: 'full'` into actual unrestricted behavior, and it
 * requires this hash to match — so no agent-reachable config-writing path
 * (MCP tools, hiring flows, import, reload) can grant anything by copying an
 * `access_ack` object forward; only re-running the human CLI command, which
 * recomputes the hash against the role's CURRENT config, produces a match.
 */

import { createHash } from 'node:crypto';
import type { OrgDef, OrgRole } from './types.js';

/** Recursively sort object keys so the same logical config always serializes
 *  identically regardless of property insertion order. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonical((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** The exact set of fields covered by a role's `access_ack.hash` — every one
 *  documented in #365's issue text as "security-relevant": what the role
 *  runs (prompt/responsibilities, runtime, model), what it can reach (tool
 *  providers, `reports_to`), who can message it (`review_input` is the only
 *  field that restricts inbound `org_send`; there is no other messaging
 *  allowlist in RoleSchema today), the coder-mode settings sources it would
 *  load, and the two org-level unattended/taint knobs a human sets alongside
 *  the grant. */
export function accessAckHashInput(def: OrgDef, role: OrgRole): unknown {
  const runConfig = def.run_config as {
    allow_unattended_full_access?: boolean;
    accept_full_access_taint?: string[];
  };
  return canonical({
    responsibilities: role.responsibilities ?? [],
    instructions_file: role.instructions_file ?? null,
    blueprint: role.blueprint ?? null,
    runtime: role.runtime ?? def.runtime ?? null,
    model: role.adapter_config?.model ?? null,
    provider: role.provider ?? null,
    tool_providers: role.tool_providers ?? [],
    reports_to: role.reports_to ?? null,
    review_input: role.review_input ?? null,
    settings: role.policy?.settings ?? [],
    allow_unattended_full_access: runConfig.allow_unattended_full_access ?? false,
    accept_full_access_taint: runConfig.accept_full_access_taint ?? [],
  });
}

/** SHA-256 hex digest of `accessAckHashInput` — what a fresh
 *  `org role set-access <org> <role> full` writes, and what the runtime
 *  recomputes every session start to decide whether the grant still holds. */
export function computeAccessAckHash(def: OrgDef, role: OrgRole): string {
  return createHash('sha256')
    .update(JSON.stringify(accessAckHashInput(def, role)))
    .digest('hex');
}
