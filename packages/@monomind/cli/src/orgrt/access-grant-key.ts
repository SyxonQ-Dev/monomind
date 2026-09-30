// packages/@monomind/cli/src/orgrt/access-grant-key.ts
/**
 * #365 (integrator review): `access_ack.hash` alone is a PUBLIC drift check
 * — anything that can write an org's JSON (a mono-agent chat org-design
 * tool, an agent with file access to `.monomind/orgs`, a hand-crafted
 * import) could recompute the same SHA-256 and forge a "human" grant.
 * This module adds the missing authentication: a machine-local secret key,
 * created only by the operator's own commands (`org role set-access <org>
 * <role> full`, and since #502 `org sign` / `org create`, which sign org
 * definitions with it — org-signature.ts), stored in the operator-credential directory
 * (`broker.ts`'s `defaultOperatorDir()`, the same directory
 * `authority-mask.ts`'s `authorityDirs()` denies Read/Edit on for every
 * scoped/sandboxed role — see `role-sandbox-restrictions.ts`'s
 * `disallowedTools`/`denyRead`). `access-grant.ts`'s `resolveRoleAccess`
 * verifies the HMAC signature before it ever trusts `hash`.
 *
 * Residual risk, same as every other authority-dir guarantee in this
 * codebase (role-sandbox.ts's git guard, the dashboard auth secret): an
 * ACTIVE full-access role runs with no sandbox and no authority mask, so it
 * CAN read this file, same as it can read any other credential on the
 * machine as the same OS user. The barrier this key adds is against a
 * SCOPED role, or an agent-reachable config-writing path with no shell
 * access at all, forging a NEW grant — not against a role that already has
 * one steering itself further (that role can already do anything).
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  type Stats,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { defaultOperatorDir } from './broker.js';

const KEY_FILE = 'full-access-grant.key';
const KEY_BYTES = 32;

export function fullAccessGrantKeyPath(dir: string = defaultOperatorDir()): string {
  return join(dir, KEY_FILE);
}

const currentUid = (getuid?: () => number): number | undefined =>
  (getuid ?? process.getuid?.bind(process))?.();

/** #502 review: why a file holding operator authority (the key, a signature)
 *  must not be trusted, or undefined when it may be: a symlink, not a plain
 *  file (or dir), another user's, or with group/other permission bits. */
export function untrustedFileReason(
  st: Stats,
  what: string,
  opts: { dir?: boolean; getuid?: () => number } = {},
): string | undefined {
  const uid = currentUid(opts.getuid);
  if (st.isSymbolicLink()) return `${what} is a symlink`;
  if (opts.dir ? !st.isDirectory() : !st.isFile())
    return `${what} is not a ${opts.dir ? 'directory' : 'regular file'}`;
  if (uid !== undefined && st.uid !== uid) return `${what} is owned by uid ${st.uid}, not ${uid}`;
  if (process.platform !== 'win32' && st.mode & 0o077)
    return `${what} has mode ${(st.mode & 0o777).toString(8)} (must be ${opts.dir ? '700' : '600'})`;
  return undefined;
}

/** The operator dir's problem, if any. A dir of ours with looser bits is
 *  tightened to 0700 first: broker.ts creates it with the default umask. */
export function checkOperatorDir(dir: string, getuid?: () => number): string | undefined {
  let st: Stats;
  try {
    st = lstatSync(dir);
  } catch {
    return undefined; // nothing there yet
  }
  const uid = currentUid(getuid);
  const ours = st.isDirectory() && !st.isSymbolicLink() && (uid === undefined || st.uid === uid);
  if (ours && st.mode & 0o077) {
    try {
      chmodSync(dir, 0o700);
      st = lstatSync(dir);
    } catch {
      /* reported below */
    }
  }
  return untrustedFileReason(st, `operator dir ${dir}`, { dir: true, getuid });
}

interface LoadedKey {
  key: Buffer;
  dev: number;
  ino: number;
  mtimeMs: number;
  size: number;
}
/** #502 review: the key each operator dir held when this process first
 *  loaded (or created) it. A key file replaced or rewritten afterwards is
 *  refused, not picked up: a role that swaps the key under a running daemon
 *  gains nothing, and the operator is told. */
const loadedKeys = new Map<string, LoadedKey>();

const sameFile = (a: LoadedKey, st: Stats): boolean =>
  a.dev === st.dev && a.ino === st.ino && a.mtimeMs === st.mtimeMs && a.size === st.size;

export type OperatorKey =
  | { key: Buffer; problem?: undefined }
  | { key?: undefined; problem: string };

/** The operator key or why it can't be used. Never throws, never creates it. */
export function loadOperatorKey(
  dir: string = defaultOperatorDir(),
  opts: { getuid?: () => number } = {},
): OperatorKey {
  const path = fullAccessGrantKeyPath(dir);
  let st: Stats;
  try {
    st = lstatSync(path);
  } catch {
    return { problem: `no operator key at ${path}` };
  }
  const bad =
    checkOperatorDir(dir, opts.getuid) ?? untrustedFileReason(st, `operator key ${path}`, opts);
  if (bad) return { problem: bad };
  const cached = loadedKeys.get(dir);
  if (cached) {
    if (sameFile(cached, st)) return { key: cached.key };
    return {
      problem: `operator key ${path} changed since this process loaded it; refusing it (if you replaced it yourself, restart the daemon)`,
    };
  }
  let key: Buffer;
  try {
    key = readFileSync(path);
  } catch (err) {
    return { problem: `operator key ${path} is unreadable (${(err as Error).message})` };
  }
  if (key.length === 0) return { problem: `operator key ${path} is empty` };
  loadedKeys.set(dir, { key, dev: st.dev, ino: st.ino, mtimeMs: st.mtimeMs, size: st.size });
  return { key };
}

/** Read the signing key, or `undefined` when it doesn't exist or can't be
 *  trusted (loadOperatorKey) — never throws and NEVER creates it. A role
 *  whose grant hinges on a missing key is exactly the 'invalid-signature'
 *  suspended case (access-grant.ts). */
export function readFullAccessGrantKey(dir: string = defaultOperatorDir()): Buffer | undefined {
  return loadOperatorKey(dir).key;
}

/** Create the key on first use (idempotent — returns the existing one if
 *  present). Called only from the operator's own commands (`org role
 *  set-access … full`, `org sign`, `org create`). 32 random bytes, mode 0600
 *  in a 0700 dir, written atomically (tmp file + same-directory rename) so a
 *  concurrent grant never observes a half-written key. Throws when a key
 *  exists but can't be trusted: overwriting it would hide that. */
export function ensureFullAccessGrantKey(dir: string = defaultOperatorDir()): Buffer {
  const loaded = loadOperatorKey(dir);
  if (loaded.key) return loaded.key;
  const path = fullAccessGrantKeyPath(dir);
  let exists = true;
  try {
    lstatSync(path);
  } catch {
    exists = false;
  }
  if (exists) throw new Error(`refusing the operator key: ${loaded.problem}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dirProblem = checkOperatorDir(dir);
  if (dirProblem) throw new Error(`refusing the operator dir: ${dirProblem}`);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, randomBytes(KEY_BYTES), { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    /* best effort on platforms without POSIX file modes */
  }
  renameSync(tmp, path);
  loadedKeys.delete(dir);
  const created = loadOperatorKey(dir);
  if (!created.key) throw new Error(`the new operator key is not usable: ${created.problem}`);
  return created.key;
}

/** The bytes signed/verified — org, role, the drift hash, and the ack's own
 *  `at`/`by`, so the signature covers the WHOLE ack object rather than only
 *  the hash (an attacker who could edit `at` alone would otherwise get a
 *  free pass). */
function signingInput(org: string, role: string, hash: string, at: string, by: string): string {
  return JSON.stringify({ org, role, hash, at, by });
}

export function signAccessAck(args: {
  org: string;
  role: string;
  hash: string;
  at: string;
  by: string;
  key: Buffer;
}): string {
  return createHmac('sha256', args.key)
    .update(signingInput(args.org, args.role, args.hash, args.at, args.by))
    .digest('hex');
}

/** Timing-safe verification. Returns `false` for ANY failure — no key, no
 *  `sig`, a malformed `sig`, or a mismatch — and never throws. */
export function verifyAccessAckSignature(args: {
  org: string;
  role: string;
  hash: string;
  at: string;
  by: string;
  sig: string | undefined;
  key: Buffer | undefined;
}): boolean {
  if (!args.key || !args.sig) return false;
  let expected: Buffer;
  let actual: Buffer;
  try {
    expected = Buffer.from(signAccessAck({ ...args, key: args.key }), 'hex');
    actual = Buffer.from(args.sig, 'hex');
  } catch {
    return false;
  }
  if (expected.length !== actual.length || expected.length === 0) return false;
  try {
    return timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}
