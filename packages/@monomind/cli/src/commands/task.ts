/**
 * CLI Task Command
 * Task management for Monomind
 */

import { output } from '../output.js';
import type { Command, CommandContext, CommandResult } from '../types.js';
import { assignCommand } from './task-assign.js';
import { cancelCommand } from './task-cancel.js';
import { createCommand } from './task-create.js';
import { listCommand } from './task-list.js';
import { statusCommand } from './task-status.js';

export { assignCommand } from './task-assign.js';
export { cancelCommand } from './task-cancel.js';
export { createCommand } from './task-create.js';
export { listCommand } from './task-list.js';
export {
  formatPriority,
  formatStatus,
  MAX_ASSIGN_LEN,
  MAX_DEP_LEN,
  MAX_DEPS,
  MAX_DESCRIPTION_LEN,
  MAX_LIMIT,
  MAX_REASON_LEN,
  MAX_TAG_LEN,
  MAX_TAGS,
  MAX_TASK_ID_LEN,
  TASK_PRIORITIES,
  TASK_TYPES,
} from './task-shared.js';
export { statusCommand } from './task-status.js';

// Main task command
export const taskCommand: Command = {
  name: 'task',
  description: 'Task management commands',
  subcommands: [createCommand, listCommand, statusCommand, cancelCommand, assignCommand],
  options: [],
  examples: [
    {
      command: 'monomind task create -t implementation -d "Add user auth"',
      description: 'Create a task',
    },
    { command: 'monomind task list', description: 'List pending/running tasks' },
    { command: 'monomind task list --all', description: 'List all tasks' },
    { command: 'monomind task status task-123', description: 'Get task details' },
    { command: 'monomind task cancel task-123', description: 'Cancel a task' },
    {
      command: 'monomind task assign task-123 --agent coder-1',
      description: 'Assign task to agent',
    },
  ],
  action: async (_ctx: CommandContext): Promise<CommandResult> => {
    // Show help if no subcommand
    output.writeln();
    output.writeln(output.bold('Task Management Commands'));
    output.writeln();
    output.writeln('Usage: monomind task <subcommand> [options]');
    output.writeln();
    output.writeln('Subcommands:');
    output.printList([
      `${output.highlight('create')}  - Create a new task`,
      `${output.highlight('list')}    - List tasks`,
      `${output.highlight('status')}  - Get task details`,
      `${output.highlight('cancel')}  - Cancel a running task`,
      `${output.highlight('assign')}  - Assign task to agent(s)`,
    ]);
    output.writeln();
    output.writeln('Run "monomind task <subcommand> --help" for subcommand help');

    return { success: true };
  },
};

export default taskCommand;
