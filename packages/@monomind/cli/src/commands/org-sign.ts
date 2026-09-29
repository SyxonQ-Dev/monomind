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
  orgSignatureEnforced,
  roleContextMarker,
  signOrgDef,
  verifyOrgDef,
} from '../orgrt/org-signature.js';
import { ORG_DIR, OrgDefSchema } from '../orgrt/types.js';
import { output } from '../output.js';
import type { Command, CommandContext, CommandResult } from '../types.js';
import { listOrgConfigFiles, validateOrgName } from './org-control.js';

const log = (text: string): void => {
  console.log(text);
};

function readRaw(cwd: string, name: string): unknown {
  return JSON.parse(readFileSync(join(cwd, ORG_DIR, `${name}.json`), 'utf8'));
}

function printReview(cwd: string, name: string, raw: unknown): void {
  const check = verifyOrgDef(cwd, name, raw);
  const state = check.ok ? 'signed, unchanged' : check.reason;
  log(output.bold(`\norg ${name} (${state}):`));
  for (const line of describeOrgAuthority(raw)) log(line);
}

/** Sign one org. Returns an error string, or undefined on success. */
async function signOne(
  ctx: CommandContext,
  name: string,
  confirmEach: boolean,
): Promise<string | undefined> {
  if (!existsSync(join(ctx.cwd, ORG_DIR, `${name}.json`))) return `org not found: ${name}`;
  let raw: unknown;
  try {
    raw = readRaw(ctx.cwd, name);
  } catch (err) {
    return `org ${name}: unreadable JSON (${(err as Error).message})`;
  }
  const parsed = OrgDefSchema.safeParse(raw);
  if (!parsed.success) {
    return `org ${name}: invalid definition — run \`monomind org validate ${name}\` first`;
  }
  printReview(ctx.cwd, name, raw);
  if (confirmEach) {
    const { confirm } = await import('../prompt.js');
    const ok = await confirm({ message: `Sign org "${name}" as the operator?`, default: false });
    if (!ok) return `org ${name}: not signed (declined)`;
  }
  const { at } = signOrgDef(ctx.cwd, name, raw);
  log(output.success(`org ${name}: signed (${at})`));
  return undefined;
}

export const signAction = async (ctx: CommandContext): Promise<CommandResult> => {
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
  const yes = ctx.flags.yes === true;
  if (!ctx.interactive && !yes) {
    log(
      output.error(
        'Non-interactive: review the definition, then pass --yes to sign it (monomind org sign <org> --yes).',
      ),
    );
    return { success: false, message: 'confirmation required (--yes)' };
  }
  const errors: string[] = [];
  for (const name of names) {
    const err = await signOne(ctx, name, ctx.interactive && !yes);
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
  ],
  examples: [
    { command: 'monomind org sign growth', description: 'Review and sign one org' },
    { command: 'monomind org sign --all', description: 'Sign every org (migration)' },
  ],
  action: signAction,
};
