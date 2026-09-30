// packages/@monomind/cli/src/commands/org-sign-show.ts
//
// What `org sign` shows before signing (#502), as text or — for `org sign
// <org> --format json` without --yes (#558) — as JSON carrying the hash of
// exactly the content reviewed, from the one read that signing uses.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  describeOrgAuthority,
  nonBundledSkillLines,
  projectionDiff,
  unconfinedRoles,
} from '../orgrt/org-sign-review.js';
import {
  computeOrgDefHash,
  instructionsDigests,
  lastSignedProjection,
  signedProjection,
  verifyOrgDef,
} from '../orgrt/org-signature.js';
import { approvalCandidates, firstLookConfigs } from '../orgrt/plant-approvals.js';
import { ORG_DIR, OrgDefSchema } from '../orgrt/types.js';
import { output } from '../output.js';
import type { CommandContext, CommandResult } from '../types.js';

export function readRaw(cwd: string, name: string): unknown {
  return JSON.parse(readFileSync(join(cwd, ORG_DIR, `${name}.json`), 'utf8'));
}

/** An org read for signing: its definition and instructions digests, each
 *  file read once, and the hash that signing them records. */
export interface LoadedOrg {
  name: string;
  raw: unknown;
  digests: Record<string, string>;
  hash: string;
}

/** Read one org to sign, or an error string. */
export function loadOrg(root: string, name: string): LoadedOrg | string {
  if (!existsSync(join(root, ORG_DIR, `${name}.json`))) return `org not found: ${name}`;
  let raw: unknown;
  try {
    raw = readRaw(root, name);
  } catch (err) {
    return `org ${name}: unreadable JSON (${(err as Error).message})`;
  }
  const parsed = OrgDefSchema.safeParse(raw);
  if (!parsed.success) {
    return `org ${name}: invalid definition — run \`monomind org validate ${name}\` first`;
  }
  const digests = instructionsDigests(raw, root);
  return { name, raw, digests, hash: computeOrgDefHash(raw, root, digests) };
}

type Style = 'bold' | 'warning' | 'dim';

export interface OrgReview {
  state: 'signed' | 'changed' | 'unsigned' | 'invalid-signature' | 'forbidden-key';
  review: {
    authority: string[];
    unconfinedRoles: Array<{ id: string; why: string }>;
    nonBundledSkills: string[];
    approvalCandidates: string[];
    firstLookConfigs: string[];
    /** Changed leaves since the last signature; null when there is none. */
    diff: string[] | null;
  };
  lines: Array<{ text: string; style?: Style }>;
}

/** The whole review: state, every authority-relevant setting, the
 *  unconfined roles, and what changed since the last signature. */
export function buildReview(
  cwd: string,
  name: string,
  raw: unknown,
  digests?: Record<string, string>,
): OrgReview {
  const lines: OrgReview['lines'] = [];
  const add = (text: string, style?: Style) => lines.push({ text, style });
  const check = verifyOrgDef(cwd, name, raw, { digests });
  add(`\norg ${name} (${check.ok ? 'signed, unchanged' : check.reason}):`, 'bold');
  const authority = describeOrgAuthority(raw);
  for (const line of authority) add(line);
  const extra = nonBundledSkillLines(cwd);
  if (extra.length) {
    add('  Org skills from the project or user library (not bundled):', 'bold');
    for (const line of extra) add(`  ${line}`);
  }
  // #502 review round 5: signing approves no path; say which are waiting.
  const pending = approvalCandidates({ root: cwd });
  if (pending.length)
    add(
      `  ${pending.length} protected path(s) would be quarantined as possible plants: ${pending.join(', ')} — if they are yours, approve them with \`monomind org approve-paths <path>\``,
      'warning',
    );
  const firstLook = firstLookConfigs({ root: cwd });
  if (firstLook.length)
    add(`  will be trusted at monomind's first look: ${firstLook.join(', ')}`, 'dim');
  const before = lastSignedProjection(cwd, name);
  let diff: string[] | null = null;
  if (before === undefined) {
    add('  (no earlier signature on this machine to compare with)', 'dim');
  } else {
    diff = projectionDiff(before, JSON.parse(JSON.stringify(signedProjection(raw, cwd, digests))));
    add(
      diff.length ? '  Changed since the last signature:' : '  No change since the last signature.',
      'bold',
    );
    for (const line of diff) add(line);
  }
  return {
    state: check.ok ? 'signed' : check.reason,
    review: {
      authority,
      unconfinedRoles: unconfinedRoles(raw),
      nonBundledSkills: extra.map((l) => l.trim()),
      approvalCandidates: pending,
      firstLookConfigs: firstLook,
      diff,
    },
    lines,
  };
}

export function printReview(
  cwd: string,
  name: string,
  raw: unknown,
  digests?: Record<string, string>,
): void {
  for (const { text, style } of buildReview(cwd, name, raw, digests).lines)
    console.log(style ? output[style](text) : text);
}

/** `org sign <org> --format json` without --yes: the review and the hash of
 *  the content reviewed, from one read. Never prompts, never signs. */
export function reviewJsonAction(ctx: CommandContext, names: string[]): CommandResult {
  const fail = (org: string | undefined, error: string, exitCode: number): CommandResult => {
    console.log(JSON.stringify(org === undefined ? { error } : { org, error }));
    return { success: false, message: error, exitCode };
  };
  if (ctx.flags.all === true || names.length !== 1)
    return fail(undefined, 'the JSON review takes one org (not --all)', 2);
  const org = loadOrg(ctx.cwd, names[0]);
  if (typeof org === 'string') return fail(names[0], org, org.startsWith('org not found') ? 2 : 1);
  const { state, review, lines } = buildReview(ctx.cwd, org.name, org.raw, org.digests);
  const reviewText = lines.map((l) => l.text).join('\n');
  console.log(JSON.stringify({ org: org.name, state, hash: org.hash, review, reviewText }));
  return { success: true };
}
