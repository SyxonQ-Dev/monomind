// packages/@monomind/cli/src/orgrt/access-ack.ts
/**
 * #365 (Coder mode for org roles): the `access_ack.hash` computation.
 *
 * The hash is a DRIFT DETECTOR, not an authenticator: it covers every field
 * of a role's config that is security-relevant to a `policy.access: 'full'`
 * grant (what it runs, what it can reach, who can talk to it) plus the two
 * org-level knobs that gate an unattended run and accept a taint path. Both
 * `monomind org role set-access` (the only place that WRITES an
 * `access_ack`) and the runtime (which recomputes and compares it every
 * session start, see access-grant.ts) call the exact same function on the
 * exact same (zod-parsed) shapes, so a grant survives an org file being
 * re-saved with the same content, and any change to a covered field —
 * anyone's edit, not just an attacker's — invalidates it.
 *
 * Deliberately a plain SHA-256, computed from fields an org file already
 * contains in the clear: it is public and RECOMPUTABLE by anything that can
 * write the org JSON, so it alone proves nothing about who granted access —
 * only that the config hasn't drifted since whoever set `hash` did.
 * Authentication is a SEPARATE field, `access_ack.sig`
 * (access-grant-key.ts): an HMAC-SHA256 of `{org, role, hash, at, by}` under
 * a machine-local secret key stored where no scoped/sandboxed role can read
 * it. `resolveRoleAccess` (access-grant.ts) — the ONLY code path that turns
 * `access: 'full'` into actual unrestricted behavior — verifies `sig`
 * against that key BEFORE it ever trusts `hash`, so copying an `access_ack`
 * object forward (or fabricating a new one with a correctly recomputed
 * `hash`) from any path without the key produces an unverifiable signature,
 * not a valid grant.
 */

import { createHash } from 'node:crypto';
import type { OrgDef, OrgRole } from './types.js';

/** Recursively sort object keys so the same logical config always serializes
 *  identically regardless of property insertion order. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out = Object.create(null) as Record<string, unknown>; // #502: no prototype to swallow a __proto__ key
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
