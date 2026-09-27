// packages/@monomind/cli/src/orgrt/access-grant-key.ts
/**
 * #365 (integrator review): `access_ack.hash` alone is a PUBLIC drift check
 * — anything that can write an org's JSON (a mono-agent chat org-design
 * tool, an agent with file access to `.monomind/orgs`, a hand-crafted
 * import) could recompute the same SHA-256 and forge a "human" grant.
 * This module adds the missing authentication: a machine-local secret key,
 * created ONLY by `monomind org role set-access <org> <role> full`
 * (org-subcommands-role.ts — no other code path calls
 * `ensureFullAccessGrantKey`), stored in the operator-credential directory
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
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultOperatorDir } from './broker.js';

const KEY_FILE = 'full-access-grant.key';
const KEY_BYTES = 32;

export function fullAccessGrantKeyPath(dir: string = defaultOperatorDir()): string {
  return join(dir, KEY_FILE);
}

/** Read the signing key, or `undefined` when it doesn't exist / can't be
 *  read (wrong host, wrong HOME, deleted, permissions) — never throws and
 *  NEVER creates it. A role whose grant hinges on a missing key is exactly
 *  the 'invalid-signature' suspended case (access-grant.ts). */
export function readFullAccessGrantKey(dir: string = defaultOperatorDir()): Buffer | undefined {
  try {
    const raw = readFileSync(fullAccessGrantKeyPath(dir));
    return raw.length > 0 ? raw : undefined;
  } catch {
    return undefined;
  }
}

/** Create the key on first use (idempotent — returns the existing one if
 *  present). ONLY called from `org role set-access ... full`. 32 random
 *  bytes, mode 0600, written atomically (tmp file + same-directory rename)
 *  so a concurrent grant never observes a half-written key. */
export function ensureFullAccessGrantKey(dir: string = defaultOperatorDir()): Buffer {
  const existing = readFullAccessGrantKey(dir);
  if (existing) return existing;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const key = randomBytes(KEY_BYTES);
  const path = fullAccessGrantKeyPath(dir);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, key, { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    /* best effort on platforms without POSIX file modes */
  }
  renameSync(tmp, path);
  return key;
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
