/**
 * `monomind packs list|add|remove` — the opt-in skill/command/agent packs
 * `init` does not install by default (GH #411).
 */

import * as path from 'node:path';
import { formatKeptFiles } from '../init/file-guard.js';
import { LISTING_BUDGET_CHARS, measureListing, packListingChars } from '../init/listing-size.js';
import { addPacks, installedPacks, removePacks } from '../init/pack-install.js';
import { OPTIONAL_PACKS, PACKS, parsePackList } from '../init/packs.js';
import { findSourceDir } from '../init/shared.js';
import { output } from '../output.js';
import type { Command, CommandContext, CommandResult } from '../types.js';

/** Pack names from positional args (`a b` or `a,b`); core is never a target. */
function packArgs(ctx: CommandContext): { ok: true; packs: string[] } | { ok: false } {
  const parsed = parsePackList(ctx.args.join(','));
  if (!parsed.ok) {
    output.printError(parsed.message);
    return { ok: false };
  }
  if (parsed.packs.length === 0) {
    output.printError('Name one or more packs (see `monomind packs list`).');
    return { ok: false };
  }
  return parsed;
}

async function handleList(ctx: CommandContext): Promise<CommandResult> {
  const installed = installedPacks(ctx.cwd);
  const skillsDir = findSourceDir('skills');
  const claudeDir = skillsDir ? path.dirname(skillsDir) : undefined;
  const rows = PACKS.map((pack) => {
    const chars = claudeDir ? packListingChars(claudeDir, pack) : undefined;
    return {
      name: pack.name,
      installed: pack.name === 'core' || installed.includes(pack.name),
      skills: pack.skills.length,
      commands: pack.commands.length,
      agents: pack.agents.length,
      listingChars: chars?.skillsAndCommands,
      agentChars: chars?.agents,
      description: pack.description,
    };
  });
  if (ctx.flags.json === true) {
    output.printJson({ budget: LISTING_BUDGET_CHARS, packs: rows });
    return { success: true, data: rows };
  }
  output.printTable({
    columns: [
      { key: 'pack', header: 'Pack', width: 13 },
      { key: 'on', header: 'Installed', width: 10 },
      { key: 'chars', header: 'Listing', width: 8 },
      { key: 'agents', header: 'Agents', width: 8 },
      { key: 'description', header: 'Contents', width: 74 },
    ],
    data: rows.map((r) => ({
      pack: r.name,
      on: r.installed ? 'yes' : '-',
      chars: r.listingChars === undefined ? '?' : String(r.listingChars),
      agents: r.agentChars === undefined ? '?' : String(r.agentChars),
      description: r.description,
    })),
  });
  output.writeln(
    output.dim(
      `Listing and Agents: description chars. Claude Code lists about ${LISTING_BUDGET_CHARS} of skills and commands before it drops descriptions.`,
    ),
  );
  output.writeln(output.dim('Add one with `monomind packs add <pack>`.'));
  return { success: true, data: rows };
}

async function handleAdd(ctx: CommandContext): Promise<CommandResult> {
  const parsed = packArgs(ctx);
  if (!parsed.ok) return { success: false, exitCode: 1 };
  const result = await addPacks(ctx.cwd, parsed.packs);
  for (const error of result.errors) output.printError(error);
  const kept = formatKeptFiles(result.kept);
  if (kept) output.printWarning(kept);
  if (!result.success) return { success: false, exitCode: 1, data: result };
  const { skillsCount, commandsCount, agentsCount } = result.summary;
  output.printSuccess(
    `Added ${parsed.packs.join(', ')}: ${skillsCount} skills, ${commandsCount} commands, ${agentsCount} agents`,
  );
  const listing = measureListing(path.join(ctx.cwd, '.claude')).skillsAndCommandsChars;
  if (listing > LISTING_BUDGET_CHARS) {
    output.printWarning(
      `Skills and commands now take ${listing} chars of Claude Code's listing, over the ~${LISTING_BUDGET_CHARS} it shows before dropping descriptions. \`monomind packs remove <pack>\` to trim.`,
    );
  }
  return { success: true, data: result };
}

async function handleRemove(ctx: CommandContext): Promise<CommandResult> {
  const parsed = packArgs(ctx);
  if (!parsed.ok) return { success: false, exitCode: 1 };
  const result = removePacks(ctx.cwd, parsed.packs);
  output.printSuccess(`Removed ${parsed.packs.join(', ')}: ${result.removed.length} files`);
  if (result.kept?.length) {
    output.printWarning(
      `Kept ${result.kept.length} file(s) you changed or added, or that init did not record:`,
    );
    for (const file of result.kept) output.writeln(`  ${file}`);
  }
  return { success: true, data: result };
}

export const packsCommand: Command = {
  name: 'packs',
  description: 'List, add or remove opt-in skill/command/agent packs',
  subcommands: [
    {
      name: 'list',
      description: 'Show every pack, whether it is installed and its listing size',
      options: [{ name: 'json', description: 'Print JSON', type: 'boolean', default: false }],
      action: handleList,
    },
    {
      name: 'add',
      description: `Install packs into this project (${OPTIONAL_PACKS.map((p) => p.name).join(', ')})`,
      action: handleAdd,
    },
    {
      name: 'remove',
      description: 'Remove packs, deleting only files init installed and nobody changed',
      action: handleRemove,
    },
  ],
  action: handleList,
};
