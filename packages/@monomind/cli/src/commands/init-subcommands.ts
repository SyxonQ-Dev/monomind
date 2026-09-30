/**
 * Init subcommands: check, skills, hooks
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  DEFAULT_INIT_OPTIONS,
  executeInit,
  type InitOptions,
  MINIMAL_INIT_OPTIONS,
} from '../init/index.js';
import { parsePackList } from '../init/packs.js';
import { output } from '../output.js';
import type { Command, CommandContext, CommandResult } from '../types.js';

function isInitialized(cwd: string): { claude: boolean; monomind: boolean } {
  const claudePath = path.join(cwd, '.claude', 'settings.json');
  const monomindPath = path.join(cwd, '.monomind', 'config.yaml');
  return {
    claude: fs.existsSync(claudePath),
    monomind: fs.existsSync(monomindPath),
  };
}

export const checkCommand: Command = {
  name: 'check',
  description: 'Check if MonoMind is initialized',
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const initialized = isInitialized(ctx.cwd);

    const result = {
      initialized: initialized.claude || initialized.monomind,
      claude: initialized.claude,
      monomind: initialized.monomind,
      paths: {
        claudeSettings: initialized.claude ? path.join(ctx.cwd, '.claude', 'settings.json') : null,
        monomindConfig: initialized.monomind
          ? path.join(ctx.cwd, '.monomind', 'config.yaml')
          : null,
      },
    };

    if (ctx.flags.format === 'json') {
      output.printJson(result);
      return { success: true, data: result };
    }

    if (result.initialized) {
      output.printSuccess('MonoMind is initialized');
      if (initialized.claude) {
        output.printInfo(`  Claude Code: .claude/settings.json`);
      }
      if (initialized.monomind) {
        output.printInfo(`  Runtime: .monomind/config.yaml`);
      }
    } else {
      output.printWarning('MonoMind is not initialized in this directory');
      output.printInfo('Run "monomind init" to initialize');
    }

    return { success: true, data: result };
  },
};

export const skillsCommand: Command = {
  name: 'skills',
  description: 'Initialize only skills',
  options: [
    {
      name: 'all',
      description: 'Install the skills of every pack',
      type: 'boolean',
      default: false,
    },
    { name: 'core', description: 'Install the core pack skills', type: 'boolean', default: true },
    {
      name: 'packs',
      description: 'Also install the skills of these packs (comma-separated)',
      type: 'string',
    },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const packs = parsePackList((ctx.flags.packs as string | undefined) ?? '');
    if (!packs.ok) {
      output.printError(packs.message);
      return { success: false, exitCode: 1 };
    }
    const options: InitOptions = {
      ...MINIMAL_INIT_OPTIONS,
      targetDir: ctx.cwd,
      force: ctx.flags.force as boolean,
      components: {
        settings: false,
        skills: true,
        commands: false,
        agents: false,
        helpers: false,
        statusline: false,
        mcp: false,
        runtime: false,
        claudeMd: false,
        monograph: false,
        antigravity: false,
        opencode: false,
        kimicode: false,
        codex: false,
      },
      packs: packs.packs,
      skills: {
        all: ctx.flags.all as boolean,
        core: ctx.flags.core as boolean,
      },
    };

    const spinner = output.createSpinner({ text: 'Installing skills...' });
    spinner.start();

    const result = await executeInit(options);

    if (result.success) {
      spinner.succeed(`Installed ${result.summary.skillsCount} skills`);
    } else {
      spinner.fail('Failed to install skills');
      for (const error of result.errors) {
        output.printError(error);
      }
    }

    return { success: result.success, data: result };
  },
};

export const hooksCommand: Command = {
  name: 'hooks',
  description: 'Initialize only hooks configuration',
  options: [
    { name: 'all', description: 'Enable all hooks', type: 'boolean', default: true },
    {
      name: 'minimal',
      description: 'Enable only essential hooks',
      type: 'boolean',
      default: false,
    },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const minimal = ctx.flags.minimal as boolean;

    const options: InitOptions = {
      ...DEFAULT_INIT_OPTIONS,
      targetDir: ctx.cwd,
      force: ctx.flags.force as boolean,
      components: {
        settings: true,
        skills: false,
        commands: false,
        agents: false,
        helpers: false,
        statusline: false,
        mcp: false,
        runtime: false,
        claudeMd: false,
        monograph: false,
        antigravity: false,
        opencode: false,
        kimicode: false,
        codex: false,
      },
      hooks: minimal
        ? {
            preToolUse: true,
            postToolUse: true,
            userPromptSubmit: false,
            sessionStart: false,
            stop: false,
            preCompact: false,
            notification: false,
            teammateIdle: false,
            taskCompleted: false,
            timeout: 5000,
            continueOnError: true,
          }
        : DEFAULT_INIT_OPTIONS.hooks,
    };

    const spinner = output.createSpinner({ text: 'Creating hooks configuration...' });
    spinner.start();

    const result = await executeInit(options);

    if (result.success) {
      spinner.succeed(`Created settings.json with ${result.summary.hooksEnabled} hooks enabled`);
    } else {
      spinner.fail('Failed to create hooks configuration');
      for (const error of result.errors) {
        output.printError(error);
      }
    }

    return { success: result.success, data: result };
  },
};
