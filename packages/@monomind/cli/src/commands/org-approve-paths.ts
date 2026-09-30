// packages/@monomind/cli/src/commands/org-approve-paths.ts
//
// `monomind org approve-paths [<path>…]` (#502 review round 5): the operator
// approving a path that the plant watch would otherwise quarantine as a
// possible plant (orgrt/planted-paths.ts) — say a `.mcp.json` they created,
// or one they just restored from quarantine. Nothing else approves paths.

import { resolve } from 'node:path';
import { roleContextMarker } from '../orgrt/org-signature.js';
import { approvalCandidates, approvePaths } from '../orgrt/plant-approvals.js';
import { output } from '../output.js';
import type { Command, CommandContext, CommandResult } from '../types.js';

const log = (text: string): void => {
  console.log(text);
};

export const approvePathsAction = async (ctx: CommandContext): Promise<CommandResult> => {
  const candidates = approvalCandidates({ root: ctx.cwd });
  const paths = ctx.args.map((p) => resolve(ctx.cwd, p));
  if (!paths.length) {
    if (!candidates.length) {
      log(output.info('No path is waiting for approval.'));
      return { success: true, message: 'nothing to approve' };
    }
    log(output.bold('These would be quarantined as possible plants at the next check:'));
    for (const p of candidates) log(`  ${p}`);
    log(output.info('Approve the ones you created yourself: monomind org approve-paths <path>…'));
    return { success: true, message: `${candidates.length} candidate(s)`, data: { candidates } };
  }
  const marker = roleContextMarker();
  if (marker) {
    log(
      output.error(`Refusing: ${marker} is set — only the operator approves paths, in a terminal.`),
    );
    return { success: false, message: `refused: role context (${marker})` };
  }
  if (!ctx.interactive) {
    log(
      output.error(
        'Approving paths needs a terminal: run it yourself, not from a script or agent.',
      ),
    );
    return { success: false, message: 'refused: no TTY' };
  }
  for (const p of paths)
    log(`  ${p}${candidates.includes(p) ? '' : '  (not a candidate — ignored)'}`);
  const { confirm } = await import('../prompt.js');
  const ok = await confirm({
    message: 'Trust these paths? The org runtime will no longer quarantine them.',
    default: false,
  });
  if (!ok) return { success: false, message: 'cancelled' };
  const { approved, notCandidates } = approvePaths({ root: ctx.cwd }, paths);
  for (const p of approved) log(output.success(`approved ${p}`));
  for (const p of notCandidates) log(output.warning(`not a candidate, unchanged: ${p}`));
  return { success: true, message: `approved ${approved.length} path(s)`, data: { approved } };
};

export const approvePathsSubcommand: Command = {
  name: 'approve-paths',
  description: 'List, or approve, protected paths the org runtime would quarantine as plants',
  examples: [
    { command: 'monomind org approve-paths', description: 'List the paths waiting for approval' },
    {
      command: 'monomind org approve-paths .mcp.json',
      description: 'Trust a .mcp.json you created yourself (asks first)',
    },
  ],
  action: approvePathsAction,
};
