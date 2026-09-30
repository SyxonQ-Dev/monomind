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
 *   providers/budgets/endpoint, its `instructions_file` (a path the daemon
 *   reads into the prompt) and `skills`/`skill_pool` (they decide the MCP
 *   tools the daemon grants), the role list itself, `run_config`,
 *   `schedule`, `runtime`, `fence`, `federation` and `loadouts` are all
 *   covered, and so is any field added later. A definition holding a
 *   `__proto__`, `constructor` or `prototype` key anywhere is refused.
 * - THE KEY: the same machine-local HMAC key #365 uses for `access_ack.sig`
 *   (access-grant-key.ts: owner-only, not a symlink, and a key swapped
 *   after this process loaded it is refused), in the operator-credential
 *   directory, which every role sandbox denies reading and writing.
 * - WHERE the signature lives: a sidecar in that same directory,
 *   `org-signatures/<project id>/<org>.json`, never in the org JSON — so a
 *   role can't write it, a tracked org file is not dirtied on every
 *   machine, and a signature can't be committed and replayed elsewhere. The
 *   HMAC input binds the project root and org name too. The signed
 *   projection is kept beside it, so `org sign` can show what changed.
 * - WHERE it is enforced: `assertOrgDefSigned`, called with the exact bytes
 *   about to be used by `prepareOrgStart` (org run, serve's runfile poll and
 *   schedule, resume) and `reloadOrgDef` (org reload / hot reload), plus
 *   early checks in the CLI paths for a clearer message.
 *
 * Residual (same as #365's key): a role that can already read the operator
 * directory — full access, or a role that runs with neither the SDK sandbox
 * nor the bubblewrap mask — can read the key and sign. `org sign` names
 * those roles (org-sign-review.ts).
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  ensureFullAccessGrantKey,
  loadOperatorKey,
  untrustedFileReason,
} from './access-grant-key.js';
import { defaultOperatorDir } from './broker.js';
import { instructionsDigest } from './instructions-file.js';
import { orgSignatureEnforced } from './org-signature-enforcement.js';

/** Top-level fields left out of the signature: the goal is a prompt, and
 *  `status` is informational. */
const UNSIGNED_ORG_FIELDS = new Set(['goal', 'status']);
/** Role fields left out: prompt text and dashboard layout only. */
const UNSIGNED_ROLE_FIELDS = new Set(['title', 'responsibilities', 'ui']);
/** Keys that would reach an object's prototype once parsed into one. */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const SIGNATURE_VERSION = 1;

export type OrgSignatureReason = 'unsigned' | 'changed' | 'invalid-signature' | 'forbidden-key';

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

export { orgSignatureEnforced, setOrgSignatureEnforcement } from './org-signature-enforcement.js';

/** The first `__proto__` / `constructor` / `prototype` key in `value`, as a
 *  dotted path, or undefined. JSON.parse makes such a key an own property;
 *  copied into a plain object it would set that object's prototype. */
export function forbiddenKeyPath(value: unknown, path = ''): string | undefined {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = forbiddenKeyPath(value[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  for (const key of Object.keys(value)) {
    const here = path ? `${path}.${key}` : key;
    if (FORBIDDEN_KEYS.has(key)) return here;
    const hit = forbiddenKeyPath((value as Record<string, unknown>)[key], here);
    if (hit) return hit;
  }
  return undefined;
}

/** Sorted keys, on prototype-less objects, so the same logical value always
 *  serializes the same way and no key can be swallowed by a prototype. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonical((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** The canonical, signed projection of a raw (as-authored) org JSON. */
export function orgSignatureInput(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return canonical(raw);
  const out = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (UNSIGNED_ORG_FIELDS.has(key)) continue;
    out[key] = key === 'roles' && Array.isArray(value) ? value.map(signedRole) : value;
  }
  return canonical(out);
}

function signedRole(role: unknown): unknown {
  if (!role || typeof role !== 'object' || Array.isArray(role)) return role;
  const out = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries(role as Record<string, unknown>)) {
    if (!UNSIGNED_ROLE_FIELDS.has(key)) out[key] = value;
  }
  return out;
}

/** Digests of every `instructions_file` in the definition (roles and
 *  loadouts), keyed `role:<id>` / `loadout:<name>` (instructions-file.ts). */
export function instructionsDigests(raw: unknown, root: string): Record<string, string> {
  const out = Object.create(null) as Record<string, string>;
  const def = (raw && typeof raw === 'object' ? raw : {}) as {
    roles?: unknown;
    loadouts?: unknown;
  };
  for (const r of Array.isArray(def.roles) ? def.roles : []) {
    const role = (r ?? {}) as { id?: unknown; instructions_file?: unknown };
    if (typeof role.instructions_file === 'string')
      out[`role:${String(role.id)}`] = instructionsDigest(role.instructions_file, root);
  }
  const loadouts = (def.loadouts && typeof def.loadouts === 'object' ? def.loadouts : {}) as Record<
    string,
    { instructions_file?: unknown }
  >;
  for (const name of Object.keys(loadouts)) {
    const file = loadouts[name]?.instructions_file;
    if (typeof file === 'string') out[`loadout:${name}`] = instructionsDigest(file, root);
  }
  return out;
}

/** Pin each role's and loadout's verified instructions digest on the
 *  parsed definition (`instructions_sha256`), so every later session reads
 *  the file only while its content still matches (session-prompt.ts). */
export function pinInstructionDigests(
  def: { roles: Array<{ id: string }>; loadouts?: Record<string, unknown> },
  digests: Record<string, string>,
): void {
  for (const role of def.roles) {
    const d = digests[`role:${role.id}`];
    if (d) (role as { instructions_sha256?: string }).instructions_sha256 = d;
  }
  for (const [name, l] of Object.entries(def.loadouts ?? {})) {
    const d = digests[`loadout:${name}`];
    if (d && l && typeof l === 'object')
      (l as { instructions_sha256?: string }).instructions_sha256 = d;
  }
}

/** What is signed: the projection, plus — with the project root — the
 *  digests of the instructions files it names. */
export function signedProjection(
  raw: unknown,
  root?: string,
  digests?: Record<string, string>,
): unknown {
  const projection = orgSignatureInput(raw);
  if (root === undefined) return projection;
  const d = digests ?? instructionsDigests(raw, root);
  if (!Object.keys(d).length) return projection;
  return canonical({ definition: projection, instructions: d });
}

export function computeOrgDefHash(
  raw: unknown,
  root?: string,
  digests?: Record<string, string>,
): string {
  return createHash('sha256')
    .update(JSON.stringify(signedProjection(raw, root, digests)))
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

/** A project's id under the operator dir: a hash of its real path. */
export function orgProjectId(root: string): string {
  return createHash('sha256').update(projectRoot(root)).digest('hex').slice(0, 24);
}

/** Where the signature for `org` in project `root` is kept. */
export function orgSignaturePath(root: string, org: string, dir = defaultOperatorDir()): string {
  assertSafeOrgName(org);
  return join(dir, 'org-signatures', orgProjectId(root), `${org}.json`);
}

/** The signed projection kept beside the signature, for `org sign`'s diff. */
export function orgProjectionPath(root: string, org: string, dir = defaultOperatorDir()): string {
  return orgSignaturePath(root, org, dir).replace(/\.json$/, '.projection.json');
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

/** A signature file, or why it can't be trusted (a symlink, another user's
 *  file, or readable/writable by others). Undefined when there is none. */
function readRecord(path: string): { rec?: SignatureRecord; problem?: string } | undefined {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(path);
  } catch {
    return undefined;
  }
  const bad = untrustedFileReason(st, `signature ${path}`);
  if (bad) return { problem: bad };
  try {
    const rec = JSON.parse(readFileSync(path, 'utf8')) as SignatureRecord;
    return rec && typeof rec === 'object'
      ? { rec }
      : { problem: `signature ${path} is not an object` };
  } catch (err) {
    return { problem: `signature ${path} is unreadable (${(err as Error).message})` };
  }
}

export function orgSignatureMessage(
  org: string,
  reason: OrgSignatureReason,
  problem?: string,
): string {
  const detail =
    reason === 'unsigned'
      ? 'has no operator signature'
      : reason === 'changed'
        ? 'changed since the operator signed it (policy, roles, runtime, skills, instructions_file, schedule or run_config)'
        : reason === 'forbidden-key'
          ? `holds a forbidden key (${problem}) — remove it`
          : `has an operator signature that does not verify (${problem ?? 'the signing key is missing on this host, or the signature was not made with it'})`;
  return `org ${org}: the definition ${detail} — run \`monomind org sign ${org}\` as the operator after reviewing the change`;
}

/** Verify `raw` (the parsed JSON of `.monomind/orgs/<org>.json`) against the
 *  operator's signature. Always checks, whatever the enforcement switch;
 *  never throws for a missing key or sidecar. */
export function verifyOrgDef(
  root: string,
  org: string,
  raw: unknown,
  opts: { dir?: string; digests?: Record<string, string> } = {},
): OrgSignatureCheck {
  const dir = opts.dir ?? defaultOperatorDir();
  const fail = (reason: OrgSignatureReason, problem?: string): OrgSignatureCheck => ({
    ok: false,
    reason,
    message: orgSignatureMessage(org, reason, problem),
  });
  const forbidden = forbiddenKeyPath(raw);
  if (forbidden) return fail('forbidden-key', forbidden);
  const read = readRecord(orgSignaturePath(root, org, dir));
  if (!read) return fail('unsigned');
  if (!read.rec) return fail('invalid-signature', read.problem);
  const rec = read.rec;
  const loaded = loadOperatorKey(dir);
  if (!loaded.key) return fail('invalid-signature', loaded.problem);
  if (typeof rec.sig !== 'string' || typeof rec.hash !== 'string') {
    return fail('invalid-signature', 'the signature file is malformed');
  }
  const expected = Buffer.from(
    hmac(loaded.key, {
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
    return fail('invalid-signature', 'the HMAC does not match the operator key');
  }
  if (rec.hash !== computeOrgDefHash(raw, root, opts.digests)) return fail('changed');
  return { ok: true };
}

/** Throw `OrgSignatureError` unless `raw` verifies (or enforcement is off). */
export function assertOrgDefSigned(
  root: string,
  org: string,
  raw: unknown,
  opts: { dir?: string; digests?: Record<string, string> } = {},
): void {
  if (!orgSignatureEnforced()) return;
  const check = verifyOrgDef(root, org, raw, opts);
  if (!check.ok) throw new OrgSignatureError(check.message, check.reason);
}

function writePrivate(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    /* best effort on platforms without POSIX file modes */
  }
  renameSync(tmp, path);
}

/** Sign `raw` as the operator: creates the key on first use (same key and
 *  directory as #365's full-access grants) and writes the sidecar and the
 *  signed projection atomically. Callers are the human-only paths (`org
 *  sign`, `org create`, `org role set-access`) — never the runtime. */
export function signOrgDef(
  root: string,
  org: string,
  raw: unknown,
  opts: { dir?: string; now?: Date } = {},
): { hash: string; at: string; path: string } {
  const forbidden = forbiddenKeyPath(raw);
  if (forbidden) throw new Error(orgSignatureMessage(org, 'forbidden-key', forbidden));
  const dir = opts.dir ?? defaultOperatorDir();
  const key = ensureFullAccessGrantKey(dir);
  const digests = instructionsDigests(raw, root);
  const base = {
    v: SIGNATURE_VERSION,
    org,
    root: projectRoot(root),
    hash: computeOrgDefHash(raw, root, digests),
    at: (opts.now ?? new Date()).toISOString(),
  };
  const rec: SignatureRecord = { ...base, sig: hmac(key, base) };
  const path = orgSignaturePath(root, org, dir);
  for (const d of [dirname(dirname(path)), dirname(path)]) {
    mkdirSync(d, { recursive: true, mode: 0o700 });
    chmodSync(d, 0o700);
  }
  writePrivate(
    orgProjectionPath(root, org, dir),
    `${JSON.stringify(signedProjection(raw, root, digests), null, 2)}\n`,
  );
  writePrivate(path, `${JSON.stringify(rec, null, 2)}\n`);
  return { hash: base.hash, at: base.at, path };
}

/** When `org` was last signed (the sidecar's `at`), if a trusted sidecar is
 *  there. Meaningful only once `verifyOrgDef` has checked its HMAC. */
export function orgSignedAt(
  root: string,
  org: string,
  dir = defaultOperatorDir(),
): string | undefined {
  const at = readRecord(orgSignaturePath(root, org, dir))?.rec?.at;
  return typeof at === 'string' ? at : undefined;
}

/** The projection that was last signed for `org`, if its copy is there. */
export function lastSignedProjection(
  root: string,
  org: string,
  dir = defaultOperatorDir(),
): unknown | undefined {
  const path = orgProjectionPath(root, org, dir);
  try {
    if (untrustedFileReason(lstatSync(path), path)) return undefined;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
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
