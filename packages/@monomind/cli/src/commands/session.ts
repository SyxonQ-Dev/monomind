/**
 * CLI Session Command
 * Session management for Monomind
 */

import { output } from '../output.js';
import type { Command, CommandContext, CommandResult } from '../types.js';
import { currentCommand } from './session-current.js';
import { deleteCommand } from './session-delete.js';
import { listCommand } from './session-list.js';
import { replayCommand } from './session-replay.js';
import { restoreCommand } from './session-restore.js';
import { saveCommand } from './session-save.js';

export { currentCommand } from './session-current.js';
export { deleteCommand } from './session-delete.js';
export { listCommand } from './session-list.js';
export { replayCommand } from './session-replay.js';
export { restoreCommand } from './session-restore.js';
export { saveCommand } from './session-save.js';
export { formatDate, formatDuration, formatSize, formatStatus } from './session-shared.js';

// Main session command
export const sessionCommand: Command = {
  name: 'session',
  description: 'Session management commands',
  subcommands: [
    listCommand,
    saveCommand,
    restoreCommand,
    deleteCommand,
    currentCommand,
    replayCommand,
  ],
  options: [],
  examples: [
    { command: 'monomind session list', description: 'List all sessions' },
    { command: 'monomind session save -n "checkpoint-1"', description: 'Save current session' },
    { command: 'monomind session restore session-123', description: 'Restore a session' },
    { command: 'monomind session delete session-123', description: 'Delete a session' },
    { command: 'monomind session current', description: 'Show current session' },
    { command: 'monomind session replay list', description: 'List available session replays' },
    {
      command: 'monomind session replay show session-123',
      description: 'Show replay for a session',
    },
  ],
  action: async (_ctx: CommandContext): Promise<CommandResult> => {
    // Show help if no subcommand
    output.writeln();
    output.writeln(output.bold('Session Management Commands'));
    output.writeln();
    output.writeln('Usage: monomind session <subcommand> [options]');
    output.writeln();
    output.writeln('Subcommands:');
    output.printList([
      `${output.highlight('list')}    - List all sessions`,
      `${output.highlight('save')}    - Save current session state`,
      `${output.highlight('restore')} - Restore a saved session`,
      `${output.highlight('delete')}  - Delete a saved session`,
      `${output.highlight('current')} - Show current active session`,
      `${output.highlight('replay')}  - Session replay and inspection (show, list)`,
    ]);
    output.writeln();
    output.writeln('Run "monomind session <subcommand> --help" for subcommand help');

    return { success: true };
  },
};

export default sessionCommand;
