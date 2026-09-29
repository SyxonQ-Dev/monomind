// packages/@monomind/cli/src/orgrt/org-signature.ts
/**
 * #502: operator-signed org definitions.
 *
 * `org serve` treats every `.monomind/orgs/<name>.json` as an org, and a role
 * whose Bash can write there (unsandboxed, full access, or a runtime whose
 * native file tools are not policy-gated) could add `evil.json` with a
 * `policy.git: push` role plus an `evil/run` file, or widen its own org's
 * policy for the next reload. #365's `access_ack` only covered full-access
 * grants. This module extends the same idea to the whole definition:
 *
 * - WHAT is signed: every field of the org JSON (as authored, before zod
 *   defaults) EXCEPT the prompt-only and cosmetic ones listed in
 *   `UNSIGNED_ORG_FIELDS` / `UNSIGNED_ROLE_FIELDS`. Deny-by-default: each
 *   role's whole `policy`, its id/runtime/adapter_config/provider/tool
 *   providers/budgets/endpoint, the role list itself, `run_config` (sandbox,
 *   workspace, prechecks, budgets, allow_unattended_full_access, ...),
 *   `schedule`, `runtime`, `fence` and `federation` are all covered, and so
 *   is any field added later.
 * - THE KEY: the same machine-local HMAC key #365 uses for `access_ack.sig`
 *   (access-grant-key.ts), in the operator-credential directory that the
 *   authority mask denies Read/Edit on for every scoped/sandboxed role.
 * - WHERE the signature lives: a sidecar in that same directory,
 *   `org-signatures/<project id>/<org>.json`, never in the org JSON — so a
 *   role can't write it, a tracked org file is not dirtied on every
 *   machine, and a signature can't be committed and replayed elsewhere. The
 *   HMAC input binds the project root and org name too.
 * - WHERE it is enforced: `assertOrgDefSigned`, called with the exact bytes
 *   about to be used by `prepareOrgStart` (org run, serve's runfile poll and
 *   schedule, resume) and `reloadOrgDef` (org reload / hot reload), plus
 *   early checks in the CLI paths for a clearer message.
 *
 * Residual (same as #365's key): a role that can already read the operator
 * directory — full access, or a scoped role whose Bash runs without the
 * bubblewrap mask — can read the key and sign. The barrier is against
 * sandboxed roles and config-writing paths without a shell.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { canonical } from './access-ack.js';
import { ensureFullAccessGrantKey, readFullAccessGrantKey } from './access-grant-key.js';
import { defaultOperatorDir } from './broker.js';

/** Top-level fields left out of the signature: the goal is a prompt, and
 *  `status` is informational. */
const UNSIGNED_ORG_FIELDS = new Set(['goal', 'status']);
/** Role fields left out: prompt text and dashboard layout only. */
const UNSIGNED_ROLE_FIELDS = new Set([
  'title',
  'responsibilities',
  'instructions_file',
  'skills',
  'skill_pool',
  'ui',
]);

const SIGNATURE_VERSION = 1;

export type OrgSignatureReason = 'unsigned' | 'changed' | 'invalid-signature';

export type OrgSignatureCheck =
  | { ok: true }
  | { ok: false; reason: OrgSignatureReason; message: string };

export class OrgSignatureError extends Error {
  constructor(
    message: string,
    public readonly reason: OrgSignatureReason,
  ) {
    super(message);
    this.name = 'OrgSignatureError';
  }
}

let enforced = true;

/** Test-only switch: the org runtime's own suites start hundreds of fixture
 *  orgs that have nothing to do with signing, so their vitest setup file
 *  turns enforcement off; the signature tests turn it back on. Nothing in
 *  production calls this — there is deliberately no env var or flag. */
export function setOrgSignatureEnforcement(on: boolean): void {
  enforced = on;
}

export function orgSignatureEnforced(): boolean {
  return enforced;
}

/** The canonical, signed projection of a raw (as-authored) org JSON. */
export function orgSignatureInput(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return canonical(raw);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (UNSIGNED_ORG_FIELDS.has(key)) continue;
    out[key] = key === 'roles' && Array.isArray(value) ? value.map(signedRole) : value;
  }
  return canonical(out);
}

function signedRole(role: unknown): unknown {
  if (!role || typeof role !== 'object' || Array.isArray(role)) return role;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(role as Record<string, unknown>)) {
    if (!UNSIGNED_ROLE_FIELDS.has(key)) out[key] = value;
  }
  return out;
}

export function computeOrgDefHash(raw: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(orgSignatureInput(raw)))
    .digest('hex');
}

function projectRoot(root: string): string {
  try {
    return realpathSync(root);
  } catch {
    return resolve(root);
  }
}

function assertSafeOrgName(org: string): void {
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(org)) throw new Error(`invalid org name: ${org}`);
}

/** Where the signature for `org` in project `root` is kept. */
export function orgSignaturePath(root: string, org: string, dir = defaultOperatorDir()): string {
  assertSafeOrgName(org);
  const projectId = createHash('sha256').update(projectRoot(root)).digest('hex').slice(0, 24);
  return join(dir, 'org-signatures', projectId, `${org}.json`);
}

interface SignatureRecord {
  v: number;
  org: string;
  root: string;
  hash: string;
  at: string;
  sig: string;
}

function hmac(key: Buffer, rec: Omit<SignatureRecord, 'sig'>): string {
  const input = JSON.stringify({
    kind: 'org-def',
    v: rec.v,
    org: rec.org,
    root: rec.root,
    hash: rec.hash,
    at: rec.at,
  });
  return createHmac('sha256', key).update(input).digest('hex');
}

function readRecord(path: string): SignatureRecord | undefined {
  try {
    const rec = JSON.parse(readFileSync(path, 'utf8')) as SignatureRecord;
    return rec && typeof rec === 'object' ? rec : undefined;
  } catch {
    return undefined;
  }
}

export function orgSignatureMessage(org: string, reason: OrgSignatureReason): string {
  const detail =
    reason === 'unsigned'
      ? 'has no operator signature'
      : reason === 'changed'
        ? 'changed since the operator signed it (policy, roles, runtime, schedule or run_config)'
        : 'has an operator signature that does not verify (the signing key is missing on this host, or the signature was not made with it)';
  return `org ${org}: the definition ${detail} — run \`monomind org sign ${org}\` as the operator after reviewing the change`;
}

/** Verify `raw` (the parsed JSON of `.monomind/orgs/<org>.json`) against the
 *  operator's signature. Always checks, whatever the enforcement switch;
 *  never throws for a missing key or sidecar. */
export function verifyOrgDef(
  root: string,
  org: string,
  raw: unknown,
  opts: { dir?: string } = {},
): OrgSignatureCheck {
  const dir = opts.dir ?? defaultOperatorDir();
  const fail = (reason: OrgSignatureReason): OrgSignatureCheck => ({
    ok: false,
    reason,
    message: orgSignatureMessage(org, reason),
  });
  const rec = readRecord(orgSignaturePath(root, org, dir));
  if (!rec) return fail('unsigned');
  const key = readFullAccessGrantKey(dir);
  if (!key || typeof rec.sig !== 'string' || typeof rec.hash !== 'string') {
    return fail('invalid-signature');
  }
  const expected = Buffer.from(
    hmac(key, {
      v: rec.v,
      org,
      root: projectRoot(root),
      hash: rec.hash,
      at: String(rec.at),
    }),
    'hex',
  );
  const actual = Buffer.from(rec.sig, 'hex');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return fail('invalid-signature');
  }
  if (rec.hash !== computeOrgDefHash(raw)) return fail('changed');
  return { ok: true };
}

/** Throw `OrgSignatureError` unless `raw` verifies (or enforcement is off). */
export function assertOrgDefSigned(
  root: string,
  org: string,
  raw: unknown,
  opts: { dir?: string } = {},
): void {
  if (!enforced) return;
  const check = verifyOrgDef(root, org, raw, opts);
  if (!check.ok) throw new OrgSignatureError(check.message, check.reason);
}

/** Sign `raw` as the operator: creates the key on first use (same key and
 *  directory as #365's full-access grants) and writes the sidecar
 *  atomically. Callers are the human-only paths (`org sign`, `org create`,
 *  `org role set-access`) — never the runtime. */
export function signOrgDef(
  root: string,
  org: string,
  raw: unknown,
  opts: { dir?: string; now?: Date } = {},
): { hash: string; at: string; path: string } {
  const dir = opts.dir ?? defaultOperatorDir();
  const key = ensureFullAccessGrantKey(dir);
  const base = {
    v: SIGNATURE_VERSION,
    org,
    root: projectRoot(root),
    hash: computeOrgDefHash(raw),
    at: (opts.now ?? new Date()).toISOString(),
  };
  const rec: SignatureRecord = { ...base, sig: hmac(key, base) };
  const path = orgSignaturePath(root, org, dir);
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(rec, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    /* best effort on platforms without POSIX file modes */
  }
  renameSync(tmp, path);
  return { hash: base.hash, at: base.at, path };
}

/** Env markers monomind itself sets on a role's (or `agent exec`'s) process
 *  tree. Signing refuses under any of them. A human's own coding-agent
 *  session (Claude Code running the createorg skill) is the operator and is
 *  allowed, unlike #365's full-access grant which refuses every agent. */
const ROLE_CONTEXT_MARKERS = [
  'MONOMIND_ORG_ROLE',
  'MONOMIND_SDK_AGENT',
  'MONOMIND_AGENT_EXEC',
  'MONOMIND_CLINE_TURN',
  'MONOMIND_AIDER',
] as const;

export function roleContextMarker(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return ROLE_CONTEXT_MARKERS.find((k) => !!env[k]);
}

/** One line per role plus the org-level knobs, for `org sign`'s review. */
export function describeOrgAuthority(raw: unknown): string[] {
  const def = (raw ?? {}) as {
    runtime?: string;
    schedule?: unknown;
    run_config?: Record<string, unknown>;
    roles?: Array<{
      id?: string;
      runtime?: string;
      adapter_config?: { model?: string };
      tool_providers?: unknown[];
      policy?: Record<string, unknown>;
    }>;
  };
  const lines: string[] = [];
  for (const role of def.roles ?? []) {
    const policy = role.policy ?? {};
    const parts = [
      `runtime ${role.runtime ?? def.runtime ?? 'claude'}`,
      `git ${String(policy.git ?? 'read')}`,
      `access ${String(policy.access ?? 'scoped')}`,
    ];
    if (Array.isArray(policy.fileWrite))
      parts.push(`fileWrite ${JSON.stringify(policy.fileWrite)}`);
    if (role.tool_providers?.length) parts.push(`${role.tool_providers.length} tool provider(s)`);
    lines.push(`  ${String(role.id)}: ${parts.join(' · ')}`);
  }
  const rc = def.run_config ?? {};
  const org: string[] = [];
  if (def.schedule != null) org.push(`schedule ${String(def.schedule)}`);
  if (rc.workspace !== undefined) org.push(`workspace ${String(rc.workspace)}`);
  if (Array.isArray(rc.prechecks) && rc.prechecks.length)
    org.push(`${rc.prechecks.length} precheck command(s)`);
  if (rc.allow_unattended_full_access === true) org.push('allow_unattended_full_access');
  if (org.length) lines.push(`  org: ${org.join(' · ')}`);
  return lines;
}
