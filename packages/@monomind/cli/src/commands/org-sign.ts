// packages/@monomind/cli/src/commands/org-sign.ts
//
// `monomind org sign <org> | --all` (#502): the operator reviews an org
// definition's authority (roles, runtimes, git levels, access, schedule,
// prechecks) and signs it. The runtime refuses to start or reload a
// definition whose signature does not verify (orgrt/org-signature.ts).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  describeOrgAuthority,
  nonBundledSkillLines,
  projectionDiff,
} from '../orgrt/org-sign-review.js';
import {
  computeOrgDefHash,
  instructionsDigests,
  lastSignedProjection,
  orgHashMismatchMessage,
  orgSignatureEnforced,
  roleContextMarker,
  signedProjection,
  signOrgDef,
  verifyOrgDef,
} from '../orgrt/org-signature.js';
import { approvalCandidates, firstLookConfigs } from '../orgrt/plant-approvals.js';
import { ORG_DIR, OrgDefSchema } from '../orgrt/types.js';
import { output } from '../output.js';
import type { Command, CommandContext, CommandResult } from '../types.js';
import { listOrgConfigFiles, validateOrgName } from './org-control.js';
import { checkAction, parseExpectHashes, resolveSignRoot } from './org-sign-check.js';

const log = (text: string): void => {
  console.log(text);
};

function readRaw(cwd: string, name: string): unknown {
  return JSON.parse(readFileSync(join(cwd, ORG_DIR, `${name}.json`), 'utf8'));
}

/** The whole review: state, every authority-relevant setting, the
 *  unconfined roles, and what changed since the last signature. */
function printReview(
  cwd: string,
  name: string,
  raw: unknown,
  digests?: Record<string, string>,
): void {
  const check = verifyOrgDef(cwd, name, raw, { digests });
  const state = check.ok ? 'signed, unchanged' : check.reason;
  log(output.bold(`\norg ${name} (${state}):`));
  for (const line of describeOrgAuthority(raw)) log(line);
  const extra = nonBundledSkillLines(cwd);
  if (extra.length) {
    log(output.bold('  Org skills from the project or user library (not bundled):'));
    for (const line of extra) log(`  ${line}`);
  }
  // #502 review round 5: signing approves no path; say which are waiting.
  const pending = approvalCandidates({ root: cwd });
  if (pending.length)
    log(
      output.warning(
        `  ${pending.length} protected path(s) would be quarantined as possible plants: ${pending.join(', ')} — if they are yours, approve them with \`monomind org approve-paths <path>\``,
      ),
    );
  const firstLook = firstLookConfigs({ root: cwd });
  if (firstLook.length)
    log(output.dim(`  will be trusted at monomind's first look: ${firstLook.join(', ')}`));
  const before = lastSignedProjection(cwd, name);
  if (before === undefined) {
    log(output.dim('  (no earlier signature on this machine to compare with)'));
    return;
  }
  const diff = projectionDiff(
    before,
    JSON.parse(JSON.stringify(signedProjection(raw, cwd, digests))),
  );
  log(
    output.bold(
      diff.length ? '  Changed since the last signature:' : '  No change since the last signature.',
    ),
  );
  for (const line of diff) log(line);
}

/** An org read for signing: its definition and instructions digests, each
 *  file read once, and the hash that signing them records. */
interface LoadedOrg {
  name: string;
  raw: unknown;
  digests: Record<string, string>;
  hash: string;
}

/** Read one org to sign, or an error string. */
function loadOrg(root: string, name: string): LoadedOrg | string {
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

/** Sign one loaded org. Returns an error string, or undefined on success. */
async function signOne(
  ctx: CommandContext,
  org: LoadedOrg,
  confirmEach: boolean,
  expectHash: string | undefined,
): Promise<string | undefined> {
  const { name, raw, digests } = org;
  printReview(ctx.cwd, name, raw, digests);
  if (confirmEach) {
    const { confirm } = await import('../prompt.js');
    const ok = await confirm({ message: `Sign org "${name}" as the operator?`, default: false });
    if (!ok) return `org ${name}: not signed (declined)`;
  }
  let at: string;
  try {
    ({ at } = signOrgDef(ctx.cwd, name, raw, { digests, expectHash }));
  } catch (err) {
    return (err as Error).message;
  }
  log(output.success(`org ${name}: signed (${at})`));
  return undefined;
}

export const signAction = async (input: CommandContext): Promise<CommandResult> => {
  // Read-only (#558): runs anywhere, including inside a role.
  if (input.flags.check === true) return checkAction(input);
  // A role's own process tree must never sign — it would approve its own
  // changes. A human's own coding-agent session (the createorg skill) is the
  // operator and may; the key's location is the real barrier for roles.
  const marker = roleContextMarker();
  if (marker) {
    log(
      output.error(
        `Refusing: ${marker} is set — this is an org role or agent-exec process. ` +
          'Only the operator signs org definitions; run this yourself in a terminal.',
      ),
    );
    return { success: false, message: `refused: role context (${marker})` };
  }
  const where = resolveSignRoot(input);
  if ('error' in where) return { success: false, message: where.error, exitCode: 2 };
  const ctx: CommandContext = { ...input, cwd: where.root };
  const all = ctx.flags.all === true;
  let names: string[];
  if (all) {
    const dir = join(ctx.cwd, ORG_DIR);
    names = existsSync(dir) ? listOrgConfigFiles(dir).map((f) => f.replace(/\.json$/, '')) : [];
    if (!names.length) {
      log(output.info('No org definitions to sign.'));
      return { success: true, message: 'nothing to sign' };
    }
  } else {
    const validated = validateOrgName(ctx.args[0]);
    if (!validated.ok) return validated.result;
    names = [validated.name];
  }
  const expect = parseExpectHashes(ctx, names);
  if ('error' in expect) {
    log(output.error(expect.error));
    return { success: false, message: expect.error, exitCode: 2 };
  }
  const yes = ctx.flags.yes === true;
  if (!ctx.interactive && !yes) {
    // Show what would be signed (the createorg skill relies on this), sign nothing.
    for (const name of names) {
      try {
        printReview(ctx.cwd, name, readRaw(ctx.cwd, name));
      } catch (err) {
        log(output.error(`org ${name}: ${(err as Error).message}`));
      }
    }
    log(
      output.error(
        'Not signed. Review the above, then sign it yourself in a terminal: monomind org sign <org> (or pass --yes).',
      ),
    );
    return { success: false, message: 'confirmation required (--yes)' };
  }
  const loaded = names.map((name) => loadOrg(ctx.cwd, name));
  if (expect.hashes) {
    // Compare before signing anything: with --expect-hash, one org that is
    // not as expected signs none.
    const refusals = loaded.map((org) =>
      typeof org === 'string'
        ? org
        : org.hash === expect.hashes?.get(org.name)
          ? undefined
          : orgHashMismatchMessage(org.name, expect.hashes?.get(org.name) ?? '', org.hash),
    );
    const failed = refusals.filter((r): r is string => r !== undefined);
    if (failed.length) {
      for (const r of failed) log(output.error(r));
      return { success: false, message: failed.join('; '), exitCode: 1 };
    }
  }
  const errors: string[] = [];
  for (const org of loaded) {
    const err =
      typeof org === 'string'
        ? org
        : await signOne(ctx, org, ctx.interactive && !yes, expect.hashes?.get(org.name));
    if (err) {
      errors.push(err);
      log(output.error(err));
    }
  }
  if (errors.length) return { success: false, message: errors.join('; '), exitCode: 1 };
  log(output.info('Running orgs pick up a signed change with `monomind org reload <org>`.'));
  return { success: true, message: `signed ${names.length} org(s)` };
};

/** `org run`'s gate (#502 migration). A verified definition passes. An
 *  UNSIGNED one (every org made before signing existed) run from a human's
 *  terminal gets a one-time review-and-sign prompt; every other case —
 *  a changed or forged signature, or no TTY — is refused with the
 *  `org sign` hint. Returns a CommandResult to end `org run` with, or
 *  undefined to go on. */
export async function ensureOrgSignedForRun(
  ctx: CommandContext,
  name: string,
): Promise<CommandResult | undefined> {
  if (!orgSignatureEnforced()) return undefined;
  let raw: unknown;
  try {
    raw = readRaw(ctx.cwd, name);
  } catch {
    return undefined; // unreadable: let the start path report the real error
  }
  const check = verifyOrgDef(ctx.cwd, name, raw);
  if (check.ok) return undefined;
  if (check.reason === 'unsigned' && ctx.interactive && !roleContextMarker()) {
    log(
      output.warning(
        `org ${name} has no operator signature yet (orgs are signed since #502). Review what it may do:`,
      ),
    );
    printReview(ctx.cwd, name, raw);
    const { confirm } = await import('../prompt.js');
    const ok = await confirm({
      message: `Sign org "${name}" as the operator and run it?`,
      default: false,
    });
    if (ok) {
      signOrgDef(ctx.cwd, name, raw);
      log(output.success(`org ${name}: signed`));
      return undefined;
    }
  }
  log(output.error(check.message));
  return { success: false, message: `org ${name} is not signed (${check.reason})`, exitCode: 1 };
}

export const signSubcommand: Command = {
  name: 'sign',
  description: "Review an org definition's authority and sign it as the operator",
  options: [
    { name: 'all', description: 'Sign every org definition in the project', type: 'boolean' },
    {
      name: 'yes',
      short: 'y',
      description: 'Skip the per-org confirmation (required when not on a TTY)',
      type: 'boolean',
    },
    {
      name: 'check',
      description:
        'Only report whether each org verifies (signed, changed, unsigned, …); never prompts, signs or writes. Exit 0 all signed, 1 otherwise, 2 not found or usage error. With --format json: {"orgs":[…]}',
      type: 'boolean',
    },
    {
      name: 'project',
      description:
        'Use <dir> (its real path; must hold .monomind/orgs) as the project root instead of the current directory',
      type: 'string',
    },
    {
      name: 'expect-hash',
      description:
        'Sign only if the hash about to be signed is <hex> (the "hash" of --check --format json); otherwise exit 1 and write nothing. With --all, repeat as <org>=<hex> for every org',
      type: 'array',
    },
  ],
  examples: [
    { command: 'monomind org sign growth', description: 'Review and sign one org' },
    { command: 'monomind org sign --all', description: 'Sign every org (migration)' },
    {
      command: 'monomind org sign growth --check --format json --project ~/work/app',
      description: 'Machine-readable signature state, without signing',
    },
  ],
  action: signAction,
};
