// packages/@monomind/cli/src/orgrt/access-validate.ts
/**
 * #365 `org validate` findings for `policy.access: 'full'` roles — separate
 * from access-taint.ts (the untrusted-input/reachability checks) so each
 * stays under this project's file-size norms and is unit-testable on its
 * own. Called from `org-observe-config.ts`'s `validateAction` alongside
 * `gitEnforcementFindings` (role-sandbox.ts), which this deliberately
 * mirrors in shape (`{errors, warnings}`).
 */

import { isUnattendedRun, resolveRoleAccess } from './access-grant.js';
import { runnerSpec } from './runner-registry.js';
import { effectiveRoleRuntime } from './runner-specs.js';
import type { OrgDef } from './types.js';

/** `policy` fields the schema still parses (with defaults) but that a
 *  `policy.access: 'full'` role never consults — present here only so
 *  `org validate` can warn that they are misleading, per #365. */
const IGNORED_SCOPED_FIELDS = [
  'allowTools',
  'denyTools',
  'fileWrite',
  'fileRead',
  'webAllow',
  'sandbox',
] as const;

/** Minimal shape of one role's raw (pre-zod, as-authored) JSON — enough to
 *  tell "the author wrote this key" from "the schema defaulted it", which is
 *  lost the moment `OrgDefSchema.parse` fills in `policy.git`'s default. */
interface RawRole {
  id?: unknown;
  policy?: Record<string, unknown>;
}

function rawPolicyFor(
  rawRoles: RawRole[] | undefined,
  roleId: string,
): Record<string, unknown> | undefined {
  return rawRoles?.find((r) => r.id === roleId)?.policy;
}

/** `errors`/`warnings` for every `policy.access: 'full'` role in `def`.
 *  `rawRoles` is `JSON.parse(orgFileText).roles` — the UNVALIDATED author
 *  JSON, before `OrgDefSchema.parse` applies `policy.git`'s default; pass it
 *  so "git below push, left unset" (fine — full access implies push) can be
 *  told apart from "git below push, explicitly authored" (a validation
 *  error: the config is misleading about its own enforcement). Omit it (a
 *  caller that only has the parsed `OrgDef`, e.g. a live-reload path) to
 *  skip that one check. */
export function accessValidationFindings(
  def: OrgDef,
  rawRoles?: RawRole[],
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const unattended = isUnattendedRun(def);

  for (const role of def.roles) {
    const declared = role.policy?.access ?? 'scoped';
    if (declared !== 'full') continue;

    const runtimeId = effectiveRoleRuntime(role.runtime, def.runtime, role.provider?.kind);
    if (!runnerSpec(runtimeId)?.supportsFullAccess) {
      errors.push(
        `role ${role.id}: policy.access 'full' is not supported by runtime "${runtimeId}" — this role will refuse to run with full access`,
      );
    }

    const rawPolicy = rawPolicyFor(rawRoles, role.id);
    if (rawPolicy && rawPolicy.git !== undefined && rawPolicy.git !== 'push') {
      errors.push(
        `role ${role.id}: policy.access 'full' implies policy.git 'push' — remove the explicit policy.git "${String(rawPolicy.git)}" (misleading: it will not be enforced) or drop it to let it be implied`,
      );
    }

    const ignoredSet = rawPolicy
      ? IGNORED_SCOPED_FIELDS.filter((f) => rawPolicy[f] !== undefined)
      : [];
    if (ignoredSet.length) {
      warnings.push(
        `role ${role.id}: policy.access 'full' ignores policy.${ignoredSet.join(', policy.')} — remove ${ignoredSet.length > 1 ? 'them' : 'it'} or they will misleadingly suggest a restriction that does not apply`,
      );
    }

    const resolved = resolveRoleAccess(def, role, { unattended, runtimeId });
    if (resolved.state === 'suspended') {
      warnings.push(`role ${role.id}: ${resolved.reason}`);
    } else if (resolved.state === 'unattended-blocked') {
      warnings.push(`role ${role.id}: ${resolved.reason}`);
    }
  }
  return { errors, warnings };
}
