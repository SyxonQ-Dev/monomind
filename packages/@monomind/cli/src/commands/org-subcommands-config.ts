// packages/@monomind/cli/src/commands/org-subcommands-config.ts
//
// `monomind org` config management subcommands: create, validate, migrate,
// list, delete, mark-complete.

import type { Command, CommandContext, CommandResult } from '../types.js';
import { validateOrgName } from './org-control.js';
import { deleteAction, listAction, markCompleteAction, migrateAction } from './org-manage.js';

export const createSubcommand: Command = {
  name: 'create',
  description: 'Scaffold an org config from a starter template',
  options: [
    {
      name: 'template',
      description: 'content-team | dev-team | research-pod | kg-extraction | advisor-orchestrator',
      type: 'string',
    },
    {
      name: 'goal',
      description: "Org goal (defaults to the template's placeholder)",
      type: 'string',
    },
    { name: 'schedule', description: 'Daemon schedule, e.g. 30m or 2h', type: 'string' },
    { name: 'force', description: 'Overwrite an existing org config', type: 'boolean' },
    {
      name: 'yes',
      short: 'y',
      description: 'Skip the per-role model confirmation prompt (TTY only)',
      type: 'boolean',
    },
  ],
  examples: [
    {
      command: 'monomind org create blog --template content-team --goal "3 posts/week"',
      description: 'Create a content org',
    },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const v = validateOrgName(ctx.args[0]);
    if (!v.ok) return v.result;
    const { createAction } = await import('./org-observe.js');
    return createAction(ctx, v.name);
  },
};

export const validateSubcommand: Command = {
  name: 'validate',
  description: 'Validate org config(s) against the runtime schema and structural invariants',
  examples: [
    { command: 'monomind org validate growth', description: 'Validate one org config' },
    {
      command: 'monomind org validate',
      description: 'Validate every org config in the project',
    },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const { validateAction } = await import('./org-observe.js');
    return validateAction(ctx);
  },
};

export const migrateSubcommand: Command = {
  name: 'migrate',
  description: 'Convert a legacy-format org config (topology/board/loop) to the current format',
  examples: [
    {
      command: 'monomind org migrate growth',
      description: 'Migrate one org; original saved as growth.v1.json',
    },
  ],
  action: migrateAction,
};

export const listSubcommand: Command = {
  name: 'list',
  description: 'List all orgs in the current project',
  action: listAction,
};

export const deleteSubcommand: Command = {
  name: 'delete',
  description: 'Delete an org and all its data',
  options: [
    { name: 'yes', short: 'y', description: 'Skip confirmation', type: 'boolean' },
    {
      name: 'force',
      description: 'Delete even if the org appears to be running',
      type: 'boolean',
    },
  ],
  action: deleteAction,
};

export const markCompleteSubcommand: Command = {
  name: 'mark-complete',
  description: 'Manually close a stale/crashed run',
  action: markCompleteAction,
};
