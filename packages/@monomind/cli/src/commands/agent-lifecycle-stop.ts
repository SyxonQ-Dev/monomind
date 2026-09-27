import { callMCPTool, MCPClientError } from '../mcp-client.js';
import { output } from '../output.js';
import { confirm } from '../prompt.js';
import type { Command, CommandContext, CommandResult } from '../types.js';
import { updateSwarmActivityMetrics } from './agent-lifecycle-helpers.js';

// ─── stop subcommand ─────────────────────────────────────────────────────────

export const stopCommand: Command = {
  name: 'stop',
  aliases: ['kill'],
  description: 'Stop a running agent',
  options: [
    {
      name: 'force',
      short: 'f',
      description: 'Force stop without graceful shutdown',
      type: 'boolean',
      default: false,
    },
    {
      name: 'timeout',
      description: 'Graceful shutdown timeout in seconds',
      type: 'number',
      default: 30,
    },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const agentId = ctx.args[0];

    if (!agentId) {
      output.printError('Agent ID is required');
      return { success: false, exitCode: 1 };
    }

    const force = ctx.flags.force as boolean;

    if (!force && ctx.interactive) {
      const confirmed = await confirm({
        message: `Are you sure you want to stop agent ${agentId}?`,
        default: false,
      });
      if (!confirmed) {
        output.printInfo('Operation cancelled');
        return { success: true };
      }
    }

    output.printInfo(`Stopping agent ${agentId}...`);

    try {
      const result = await callMCPTool<{
        success?: boolean;
        error?: string;
        agentId: string;
        terminated: boolean;
        terminatedAt: string;
      }>('agent_terminate', {
        agentId,
        graceful: !force,
        reason: 'Stopped by user via CLI',
      });

      // agent_terminate resolves (doesn't throw) with {success:false, error}
      // for a nonexistent agent or an unreadable store — callMCPTool only
      // throws for registry/infra errors. Without this check the CLI printed
      // "stopped successfully" for an agent that was never actually stopped.
      if (result.success === false) {
        output.printError(`Failed to stop agent: ${result.error || 'unknown error'}`);
        return { success: false, exitCode: 1 };
      }

      output.printSuccess(`Agent ${agentId} stopped successfully`);
      updateSwarmActivityMetrics(-1);

      if (ctx.flags.format === 'json') output.printJson(result);
      return { success: true, data: result };
    } catch (error) {
      output.printError(
        error instanceof MCPClientError
          ? `Failed to stop agent: ${error.message}`
          : `Unexpected error: ${String(error)}`,
      );
      return { success: false, exitCode: 1 };
    }
  },
};
