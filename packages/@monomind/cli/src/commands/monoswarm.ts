/**
 * CLI Monoswarm Command
 * Monoswarm coordination and management commands
 */

import { output } from '../output.js';
import type { Command, CommandContext, CommandResult } from '../types.js';
import { initCommand } from './monoswarm-init.js';
import { scaleCommand, stopCommand } from './monoswarm-lifecycle.js';
import { startCommand } from './monoswarm-start.js';
import { statusCommand } from './monoswarm-status.js';

export { initCommand } from './monoswarm-init.js';
export { scaleCommand, stopCommand } from './monoswarm-lifecycle.js';
export { startCommand } from './monoswarm-start.js';
export {
  getAgentStoreFile,
  getSwarmDir,
  getSwarmStateFile,
  getSwarmStatus,
} from './monoswarm-state.js';
export { statusCommand } from './monoswarm-status.js';

// Main swarm command
export const monoswarmCommand: Command = {
  name: 'monoswarm',
  description: 'Monoswarm coordination commands',
  subcommands: [initCommand, startCommand, statusCommand, stopCommand, scaleCommand],
  options: [],
  examples: [
    { command: 'monomind monoswarm init --v1-mode', description: 'Initialize monoswarm' },
    {
      command: 'monomind monoswarm start -o "Build API" -s development',
      description: 'Start development monoswarm',
    },
  ],
  action: async (_ctx: CommandContext): Promise<CommandResult> => {
    output.writeln();
    output.writeln(output.bold('Monoswarm Coordination Commands'));
    output.writeln();
    output.writeln('Usage: monomind monoswarm <subcommand> [options]');
    output.writeln();
    output.writeln('Subcommands:');
    output.printList([
      `${output.highlight('init')}        - Initialize a new monoswarm`,
      `${output.highlight('start')}       - Start monoswarm execution`,
      `${output.highlight('status')}      - Show monoswarm status`,
      `${output.highlight('stop')}        - Stop monoswarm execution`,
      `${output.highlight('scale')}       - Scale monoswarm agent count`,
    ]);

    return { success: true };
  },
};

export default monoswarmCommand;
