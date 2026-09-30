// packages/@monomind/cli/src/commands/org-sign-check.ts
//
// `monomind org sign <org> --check` and `--project <dir>` (#558). The check
// is read-only: it never prompts, never signs and writes nothing, so a tool
// such as mono-agent can ask whether an org verifies before rewriting it
// (and re-sign only its own write) without scraping the review text.

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  computeOrgDefHash,
  forbiddenKeyPath,
  instructionsDigests,
  type OrgSignatureReason,
  orgSignedAt,
  verifyOrgDef,
} from '../orgrt/org-signature.js';
import { ORG_DIR, OrgDefSchema } from '../orgrt/types.js';
import type { CommandContext, CommandResult } from '../types.js';
import { listOrgConfigFiles, ORG_NAME_RE } from './org-control.js';

export type OrgCheckState = 'signed' | OrgSignatureReason | 'not-found' | 'invalid';

export interface OrgCheckEntry {
  org: string;
  state: OrgCheckState;
  signedAt?: string;
  /** The hash `org sign --expect-hash` compares (doc/commands/org.md). */
  hash?: string;
  message?: string;
}

/** The project root `org sign` works on: `--project <dir>` (its real path,
 *  which must hold `.monomind/orgs`) or the current directory. */
export function resolveSignRoot(ctx: CommandContext): { root: string } | { error: string } {
  const flag = ctx.flags.project;
  if (flag === undefined) return { root: ctx.cwd };
  if (typeof flag !== 'string' || !flag) return { error: '--project needs a directory' };
  let root: string;
  try {
    root = realpathSync(resolve(ctx.cwd, flag));
  } catch {
    return { error: `--project: no such directory: ${flag}` };
  }
  const orgs = join(root, ORG_DIR);
  if (!existsSync(orgs) || !statSync(orgs).isDirectory())
    return { error: `--project: ${root} has no ${ORG_DIR} directory` };
  return { root };
}

const HASH_RE = /^[0-9a-f]{64}$/i;

/** `--expect-hash`, per org to sign: absent (no check), `<hex>` for one org,
 *  or with `--all` one `<org>=<hex>` for each org signed and no other. */
export function parseExpectHashes(
  ctx: CommandContext,
  names: string[],
): { hashes?: Map<string, string> } | { error: string } {
  const flag = ctx.flags['expect-hash'] ?? ctx.flags.expectHash;
  if (flag === undefined) return {};
  const values = (Array.isArray(flag) ? flag : [flag]).map(String);
  const hashes = new Map<string, string>();
  if (ctx.flags.all !== true) {
    if (values.length !== 1 || !HASH_RE.test(values[0]))
      return { error: '--expect-hash needs one 64-character hex sha256' };
    hashes.set(names[0], values[0].toLowerCase());
    return { hashes };
  }
  for (const v of values) {
    const [org, hex] = v.split('=', 2);
    if (!hex || !ORG_NAME_RE.test(org) || !HASH_RE.test(hex))
      return { error: `--all --expect-hash takes <org>=<hex sha256>, got: ${v}` };
    if (hashes.has(org)) return { error: `--expect-hash: ${org} given more than once` };
    hashes.set(org, hex.toLowerCase());
  }
  const missing = names.filter((n) => !hashes.has(n));
  if (missing.length) return { error: `--expect-hash: no hash for ${missing.join(', ')}` };
  const extra = [...hashes.keys()].filter((o) => !names.includes(o));
  if (extra.length) return { error: `--expect-hash: no org definition for ${extra.join(', ')}` };
  return { hashes };
}

/** One org's signature state. Reads only. */
export function checkOrg(root: string, org: string): OrgCheckEntry {
  const file = join(root, ORG_DIR, `${org}.json`);
  if (!existsSync(file)) return { org, state: 'not-found', message: `org not found: ${org}` };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    return {
      org,
      state: 'invalid',
      message: `org ${org}: unreadable JSON (${(err as Error).message})`,
    };
  }
  if (forbiddenKeyPath(raw) === undefined && !OrgDefSchema.safeParse(raw).success)
    return {
      org,
      state: 'invalid',
      message: `org ${org}: invalid definition — run \`monomind org validate ${org}\``,
    };
  // One read of each instructions file feeds both the check and the hash.
  const digests = instructionsDigests(raw, root);
  const check = verifyOrgDef(root, org, raw, { digests });
  if (!check.ok && check.reason === 'forbidden-key')
    return { org, state: check.reason, message: check.message };
  const hash = computeOrgDefHash(raw, root, digests);
  if (check.ok) return { org, state: 'signed', signedAt: orgSignedAt(root, org), hash };
  // The HMAC verified for 'changed', so its timestamp is the operator's.
  const signedAt = check.reason === 'changed' ? orgSignedAt(root, org) : undefined;
  return {
    org,
    state: check.reason,
    ...(signedAt ? { signedAt } : {}),
    hash,
    message: check.message,
  };
}

function usageError(json: boolean, message: string): CommandResult {
  if (json) console.log(JSON.stringify({ error: message }));
  return { success: false, message, exitCode: 2 };
}

/** `org sign --check`: 0 when every org checked is signed and unchanged,
 *  1 otherwise, 2 for an org that is not there, `--all` with no orgs, or a
 *  usage error. */
export function checkAction(ctx: CommandContext): CommandResult {
  const json = ctx.flags.format === 'json';
  const where = resolveSignRoot(ctx);
  if ('error' in where) return usageError(json, where.error);
  const { root } = where;
  let names: string[];
  if (ctx.flags.all === true) {
    const dir = join(root, ORG_DIR);
    names = existsSync(dir) ? listOrgConfigFiles(dir).map((f) => f.replace(/\.json$/, '')) : [];
    // Nothing checked is not "all signed": a caller must not read it as a pass.
    if (!names.length) {
      if (json) console.log(JSON.stringify({ orgs: [] }));
      return { success: false, message: `no org definitions in ${dir}`, exitCode: 2 };
    }
  } else {
    const name = ctx.args[0];
    if (!name) return usageError(json, 'org name required (or --all)');
    if (!ORG_NAME_RE.test(name)) return usageError(json, `invalid org name: ${name}`);
    names = [name];
  }
  const orgs = names.map((name) => checkOrg(root, name));
  if (json) console.log(JSON.stringify({ orgs }));
  else for (const o of orgs) console.log(`${o.org}: ${o.state}`);
  if (orgs.some((o) => o.state === 'not-found')) return { success: false, exitCode: 2 };
  if (orgs.some((o) => o.state !== 'signed')) return { success: false, exitCode: 1 };
  return { success: true };
}
