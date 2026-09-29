import { callMCPTool, MCPClientError } from '../mcp-client.js';
import { output } from '../output.js';
import { confirm } from '../prompt.js';
import type { Command, CommandContext, CommandResult } from '../types.js';

// Stop swarm
export const stopCommand: Command = {
  name: 'stop',
  description: 'Mark the recorded swarm state terminated (there is no running process to stop)',
  options: [
    {
      name: 'force',
      short: 'f',
      description: 'Force immediate stop',
      type: 'boolean',
      default: false,
    },
    {
      name: 'save-state',
      description: 'Save current state for resume',
      type: 'boolean',
      default: true,
    },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const swarmId = ctx.args[0];
    const force = ctx.flags.force as boolean;

    if (!swarmId) {
      output.printError('Monoswarm ID is required');
      return { success: false, exitCode: 1 };
    }

    if (ctx.interactive && !force) {
      const confirmed = await confirm({
        message: `Stop swarm ${swarmId}? Progress will be saved.`,
        default: false,
      });

      if (!confirmed) {
        output.printInfo('Operation cancelled');
        return { success: true };
      }
    }

    output.printInfo(`Marking swarm ${swarmId} terminated...`);

    // monoswarm_shutdown marks the canonical state file terminated and clears
    // the roster itself — no further local write is needed here.
    try {
      await callMCPTool('monoswarm_shutdown', { swarmId, force });
      output.writeln(output.dim('  Monoswarm state updated'));
    } catch (err) {
      output.printWarning(`MCP stop failed: ${String(err)}`);
      return { success: false, message: `MCP stop failed: ${String(err)}`, exitCode: 1 };
    }

    output.printSuccess(`Monoswarm ${swarmId} marked terminated`);

    return { success: true, data: { swarmId, stopped: true, force } };
  },
};

// Scale swarm
export const scaleCommand: Command = {
  name: 'scale',
  description: 'Resize the recorded agent roster (starts or stops no processes)',
  options: [
    {
      name: 'agents',
      short: 'a',
      description: 'Target number of agents',
      type: 'number',
      required: true,
    },
    {
      name: 'type',
      short: 't',
      description: 'Agent type to scale',
      type: 'string',
    },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const swarmId = ctx.args[0];
    const targetAgents = ctx.flags.agents as number;
    const agentType = ctx.flags.type as string;

    if (!swarmId) {
      output.printError('Monoswarm ID is required');
      return { success: false, exitCode: 1 };
    }

    // 0 is a valid target (scale a swarm down to no agents) — check for
    // presence, not truthiness.
    if (targetAgents === undefined || Number.isNaN(targetAgents)) {
      output.printError('Target agent count required. Use --agents or -a');
      return { success: false, exitCode: 1 };
    }

    output.printInfo(`Resizing swarm ${swarmId} roster to ${targetAgents} entries...`);

    try {
      const result = await callMCPTool<{
        success: boolean;
        error?: string;
        previousCount: number;
        currentCount: number;
        spawned: string[];
        terminated: string[];
      }>('monoswarm_scale', { swarmId, targetAgents, agentType });

      if (!result.success) {
        output.printError(result.error || 'Failed to scale swarm');
        return { success: false, exitCode: 1 };
      }

      if (result.spawned.length === 0 && result.terminated.length === 0) {
        output.printInfo('Monoswarm already at target size');
        return { success: true, data: result };
      }

      if (result.spawned.length > 0) {
        output.printSuccess(
          `Recorded ${result.spawned.length} roster entr${result.spawned.length === 1 ? 'y' : 'ies'} (no process started): ${result.spawned.join(', ')}`,
        );
      }
      if (result.terminated.length > 0) {
        output.printSuccess(
          `Removed ${result.terminated.length} roster entr${result.terminated.length === 1 ? 'y' : 'ies'}: ${result.terminated.join(', ')}`,
        );
      }
      output.writeln(
        output.dim(`  ${result.previousCount} → ${result.currentCount} roster entries`),
      );

      return { success: true, data: result };
    } catch (error) {
      output.printError(
        `Scale error: ${error instanceof MCPClientError ? error.message : String(error)}`,
      );
      return { success: false, exitCode: 1 };
    }
  },
};
