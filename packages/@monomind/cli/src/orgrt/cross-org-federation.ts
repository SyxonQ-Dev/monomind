// packages/@monomind/cli/src/orgrt/cross-org-federation.ts
// Split out of cross-org.ts (file-size sweep) — M4 federation checks.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OrgDaemon, RunningOrg } from './daemon.js';
import { ORG_DIR, type OrgDef } from './types.js';

// ── M4 federation ───────────────────────────────────────────────────────

/** `federation.allow_*` membership: absent list = unrestricted, '*' = any. */
export function federationAllows(list: string[] | undefined, org: string): boolean {
  if (list === undefined) return true;
  return list.includes('*') || list.includes(org);
}

/** The org def for federation checks: the running def, else the one on disk. */
export function federationDef(
  daemon: OrgDaemon,
  org: string,
): Pick<OrgDef, 'federation'> | undefined {
  const running = daemon.orgs.get(org);
  if (running) return running.def;
  if (!daemon.hasOrgDef(org)) return undefined;
  const path = join(daemon.root, ORG_DIR, `${org}.json`);
  try {
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, 'utf8')) as Pick<OrgDef, 'federation'>;
  } catch {
    return undefined;
  }
}

/** M4: the sender's allow_to check for a cross-root delivery. Returns the
 *  ERROR receipt when denied (and emits the audit event), else undefined. */
export function federationDenied(
  daemon: OrgDaemon,
  fromOrg: string,
  fromRole: string,
  targetOrgName: string,
  to: string,
  subject: string,
  src: RunningOrg | undefined,
): string | undefined {
  const allowTo = (src?.def ?? federationDef(daemon, fromOrg))?.federation?.allow_to;
  if (federationAllows(allowTo, targetOrgName)) return undefined;
  const from = `${fromOrg}:${fromRole}`;
  src?.bus.emit({
    type: 'audit',
    from: fromRole,
    to,
    reason: 'federation-denied',
    msg: `federation: ${from} may not send to ${to} (${subject})`,
    data: { direction: 'to', from, to },
  });
  return `ERROR: federation: ${from} may not send to ${to}`;
}
