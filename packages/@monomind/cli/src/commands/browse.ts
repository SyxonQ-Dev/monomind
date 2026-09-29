import browseBase, { disconnectSession } from '@monoes/monobrowse/cli/commands';
import type { Command } from '../types.js';
import { browseActionCommand } from './browse-action.js';
import { browsePlatformCommand } from './browse-platform.js';
import { browseWorkflowCommand } from './browse-workflow.js';

const REPLACED = new Set(['workflow', 'action', 'platform']);

// @monoes/monobrowse permits commands that return void after writing output,
// whereas Monomind's dispatcher requires CommandResult | undefined. Keep that
// third-party variance at this integration boundary instead of weakening the
// CLI-wide command contract.
const monobrowseCommand = browseBase as unknown as Command;

// bin/cli.js lets the event loop drain rather than process.exit() (ADR-R001),
// so the CDP websocket a subcommand opened would hold the process until the
// 5 s FORCE_EXIT_MS watchdog (#408). Drop the connection once the action
// settles — the connection only: the browser stays for the next command.
// monobrowse's own `batch` dispatches over its unwrapped subcommands, so a
// batch keeps one connection across its steps.
function disconnectAfterAction(cmd: Command): Command {
  const action = cmd.action;
  return {
    ...cmd,
    action: action
      ? async (ctx) => {
          try {
            return await action(ctx);
          } finally {
            disconnectSession();
          }
        }
      : undefined,
    subcommands: cmd.subcommands?.map(disconnectAfterAction),
  };
}

// Augment the base browse command with workflow/action/platform subcommands
const browseCommand: Command = {
  ...monobrowseCommand,
  subcommands: [
    ...(monobrowseCommand.subcommands ?? [])
      .filter((s) => !REPLACED.has(s.name))
      .map(disconnectAfterAction),
    browseWorkflowCommand,
    browseActionCommand,
    browsePlatformCommand,
  ],
};

export default browseCommand;
