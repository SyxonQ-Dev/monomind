/**
 * CLI Monoswarm Command
 * Monoswarm coordination and management commands
 */

import { MONOSWARM_DEPRECATION, withDeprecationNotice } from '../deprecations.js';
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
  description:
    'Monoswarm coordination commands (deprecated: records topology/roster/votes in a state file; starts no agents)',
  // Each subcommand prints the deprecation notice on stderr first (#418).
  subcommands: [initCommand, startCommand, statusCommand, stopCommand, scaleCommand].map((sub) =>
    withDeprecationNotice(sub, MONOSWARM_DEPRECATION),
  ),
  options: [],
  examples: [
    {
      command: 'monomind monoswarm init --v1-mode',
      description: 'Record a monoswarm state file (starts no agents)',
    },
    {
      command: 'monomind monoswarm start -o "Build API" -s development',
      description: 'Record a development monoswarm config (starts no agents)',
    },
  ],
  action: async (_ctx: CommandContext): Promise<CommandResult> => {
    output.writeln();
    output.writeln(output.bold('Monoswarm Coordination Commands'));
    output.writeln(
      output.warning(
        'Deprecated: monoswarm only records state — it starts no agents and topologies change no behaviour.',
      ),
    );
    output.writeln();
    output.writeln('Usage: monomind monoswarm <subcommand> [options]');
    output.writeln();
    output.writeln('Subcommands:');
    output.printList([
      `${output.highlight('init')}        - Record a new monoswarm state file`,
      `${output.highlight('start')}       - Record a monoswarm config (starts no agents)`,
      `${output.highlight('status')}      - Show the recorded monoswarm state`,
      `${output.highlight('stop')}        - Mark the recorded swarm state terminated (there is no running process to stop)`,
      `${output.highlight('scale')}       - Resize the recorded agent roster (starts or stops no processes)`,
    ]);

    return { success: true };
  },
};

export default monoswarmCommand;
