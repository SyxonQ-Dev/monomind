// packages/@monomind/cli/src/commands/org-subcommands-role.ts
//
// `monomind org role set-access <org> <role> <full|scoped>` (#365) — the
// ONLY write path allowed to set `policy.access: 'full'` with a matching
// `access_ack`. Every other config-writing path (org MCP tools, hiring
// flows, import, hot reload) either never touches this field or is a plain
// file edit a human already had to make by hand; the runtime's own
// `resolveRoleAccess` (access-grant.ts) is the actual backstop — it accepts
// an `access_ack` only when its hash matches the role's CURRENT
// security-relevant config, which is exactly what this command computes and
// writes.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeAccessAckHash } from '../orgrt/access-ack.js';
import { runnerSpec } from '../orgrt/runner-registry.js';
import { ORG_DIR, OrgDefSchema } from '../orgrt/types.js';
import { output } from '../output.js';
import type { Command, CommandContext, CommandResult } from '../types.js';
import { validateOrgName } from './org-control.js';

const log = (text: string): void => {
  console.log(text);
};

interface RawRole {
  id?: unknown;
  runtime?: unknown;
  policy?: Record<string, unknown>;
}
interface RawOrgDef {
  runtime?: unknown;
  roles?: RawRole[];
  [k: string]: unknown;
}

function loadRaw(path: string): RawOrgDef {
  return JSON.parse(readFileSync(path, 'utf8')) as RawOrgDef;
}

export const setAccessAction = async (ctx: CommandContext): Promise<CommandResult> => {
  const validated = validateOrgName(ctx.args[0]);
  if (!validated.ok) return validated.result;
  const name = validated.name;
  const roleId = ctx.args[1];
  const mode = ctx.args[2];
  if (!roleId || (mode !== 'full' && mode !== 'scoped')) {
    return {
      success: false,
      message:
        'usage: monomind org role set-access <org> <role> <full|scoped> [--yes-i-understand]',
    };
  }
  const path = join(ctx.cwd, ORG_DIR, `${name}.json`);
  if (!existsSync(path)) {
    log(output.error(`Org not found: ${name}`));
    return { success: false, message: 'org not found' };
  }
  const raw = loadRaw(path);
  const rawRole = raw.roles?.find((r) => r.id === roleId);
  if (!rawRole) {
    log(output.error(`Role "${roleId}" not found in org "${name}"`));
    return { success: false, message: 'role not found' };
  }

  if (mode === 'scoped') {
    if (rawRole.policy) {
      delete rawRole.policy.access;
      delete rawRole.policy.access_ack;
    }
    writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
    log(output.success(`Role "${roleId}" in org "${name}" is now scoped (default policy).`));
    log(output.info(`Run \`monomind org reload ${name}\` for a live org to pick this up.`));
    return { success: true, message: 'role downgraded to scoped' };
  }

  // mode === 'full': the human-only grant path.
  const def = OrgDefSchema.parse(raw);
  const role = def.roles.find((r) => r.id === roleId);
  if (!role) {
    log(output.error(`Role "${roleId}" not found in org "${name}"`));
    return { success: false, message: 'role not found' };
  }
  const runtimeId = role.runtime ?? def.runtime ?? 'claude';
  if (!runnerSpec(runtimeId)?.supportsFullAccess) {
    log(
      output.error(
        `Runtime "${runtimeId}" does not support full access — refusing to grant it to role "${roleId}".`,
      ),
    );
    return { success: false, message: 'runtime does not support full access' };
  }

  if (ctx.interactive && ctx.flags['yes-i-understand'] !== true) {
    log(output.bold(`\nGrant FULL ACCESS to role "${roleId}" in org "${name}"?`));
    log(
      output.warning(
        '  This role will run with NO tool allow-list, NO file-write/read restriction, NO OS sandbox,\n' +
          '  and NO per-tool approval gate — the same as running `claude` interactively with\n' +
          '  bypassPermissions. Budgets (maxTokens/maxUsd) still apply. Every tool call is still\n' +
          '  logged (org bus + ~/.monomind/logs/agent-exec-full-access.log).',
      ),
    );
    const { confirm } = await import('../prompt.js');
    const proceed = await confirm({ message: 'Grant full access?', default: false });
    if (!proceed) {
      log(output.info('Cancelled — no file written.'));
      return { success: false, message: 'cancelled by user' };
    }
  } else if (!ctx.interactive && ctx.flags['yes-i-understand'] !== true) {
    log(output.error('Non-interactive: pass --yes-i-understand to grant full access.'));
    return { success: false, message: 'confirmation required (--yes-i-understand)' };
  }

  rawRole.policy = rawRole.policy ?? {};
  rawRole.policy.access = 'full';
  rawRole.policy.access_ack = {
    by: 'human',
    at: new Date().toISOString(),
    hash: computeAccessAckHash(def, role),
  };
  writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  log(output.success(`Role "${roleId}" in org "${name}" granted full access.`));
  log(
    output.info(
      `  Run \`monomind org validate ${name}\` to check for taint/scoped-field warnings, then ` +
        `\`monomind org reload ${name}\` for a live org (or start/restart it).`,
    ),
  );
  log(
    output.info(
      "  Editing this role's prompt/runtime/model/tools/reports_to, or the org's " +
        'allow_unattended_full_access/accept_full_access_taint, suspends this grant until re-run.',
    ),
  );
  return { success: true, message: 'role granted full access' };
};

export const roleSubcommand: Command = {
  name: 'role',
  description: 'Per-role config: human-only access grants',
  subcommands: [
    {
      name: 'set-access',
      description: 'Grant or revoke policy.access: full for one role (human-only)',
      options: [
        {
          name: 'yes-i-understand',
          description: 'Skip the interactive confirmation for a full-access grant',
          type: 'boolean',
        },
      ],
      examples: [
        {
          command: 'monomind org role set-access growth builder full',
          description: 'Grant role "builder" full access (interactive confirm)',
        },
        {
          command: 'monomind org role set-access growth builder scoped',
          description: 'Revoke a full-access grant',
        },
      ],
      action: setAccessAction,
    },
  ],
  action: async (): Promise<CommandResult> => {
    const message = 'usage: monomind org role set-access <org> <role> <full|scoped>';
    log(output.error(message));
    return { success: false, message };
  },
};

export default roleSubcommand;
