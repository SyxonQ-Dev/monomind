import { output } from '../output.js';
import type { Command, CommandContext, CommandResult } from '../types.js';
import { getSwarmStatus } from './monoswarm-state.js';

// Swarm status
export const statusCommand: Command = {
  name: 'status',
  description: 'Show swarm status',
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const swarmId = ctx.args[0];

    // Get dynamic status from actual swarm state files
    const status = getSwarmStatus(swarmId);

    if (ctx.flags.format === 'json') {
      output.printJson(status);
      return { success: true, data: status };
    }

    output.writeln();

    // Show different message if no active swarm
    if (!status.hasActiveSwarm) {
      output.writeln(output.warning('No active swarm'));
      output.writeln();
      output.writeln(output.dim('Start a swarm with:'));
      output.writeln(output.dim('  npx monomind@latest monoswarm init'));
      output.writeln(output.dim('  npx monomind@latest monoswarm start'));
      output.writeln();
      return { success: true, data: status };
    }

    output.writeln(output.bold(`Monoswarm Status: ${status.id}`));
    output.writeln();

    // Progress bar
    output.writeln(`Overall Progress: ${output.progressBar(status.progress, 100, 40)}`);
    output.writeln();

    // Agent status
    output.writeln(output.bold('Agents'));
    output.printTable({
      columns: [
        { key: 'status', header: 'Status', width: 12 },
        { key: 'count', header: 'Count', width: 10, align: 'right' },
      ],
      data: [
        { status: output.success('Active'), count: status.agents.active },
        { status: output.warning('Idle'), count: status.agents.idle },
        { status: output.dim('Completed'), count: status.agents.completed },
        { status: 'Total', count: status.agents.total },
      ],
    });

    output.writeln();

    // Task status
    output.writeln(output.bold('Tasks'));
    output.printTable({
      columns: [
        { key: 'status', header: 'Status', width: 12 },
        { key: 'count', header: 'Count', width: 10, align: 'right' },
      ],
      data: [
        { status: output.success('Completed'), count: status.tasks.completed },
        { status: output.info('In Progress'), count: status.tasks.inProgress },
        { status: output.dim('Pending'), count: status.tasks.pending },
        { status: 'Total', count: status.tasks.total },
      ],
    });

    output.writeln();

    // Metrics
    output.writeln(output.bold('Performance Metrics'));
    output.printList([
      `Tokens Used: ${status.metrics.tokensUsed}`,
      `Avg Response Time: ${status.metrics.avgResponseTime}`,
      `Success Rate: ${status.metrics.successRate}`,
      `Elapsed Time: ${status.metrics.elapsedTime}`,
    ]);

    return { success: true, data: status };
  },
};
