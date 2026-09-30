import { agentNames } from '../decision/catalogs.js';
import { callMCPTool, MCPClientError } from '../mcp-client.js';
import { output } from '../output.js';
import { select } from '../prompt.js';
import type { Command, CommandContext, CommandResult } from '../types.js';
import { getProjectCwd } from '../utils/paths.js';
import {
  agentCapabilities,
  agentTypeOptions,
  resolveAgentType,
  updateSwarmActivityMetrics,
} from './agent-lifecycle-helpers.js';

// ─── spawn subcommand ────────────────────────────────────────────────────────

export const spawnCommand: Command = {
  name: 'spawn',
  description: 'Record a new agent in the agent store (starts no process)',
  options: [
    {
      name: 'type',
      short: 't',
      description: 'Agent type to spawn: a registry agent name (see `monomind route list-agents`)',
      type: 'string',
    },
    { name: 'name', short: 'n', description: 'Agent name/identifier', type: 'string' },
    {
      name: 'provider',
      short: 'p',
      description: 'Provider to use (anthropic, openrouter, ollama)',
      type: 'string',
      default: 'anthropic',
    },
    { name: 'model', short: 'm', description: 'Model to use', type: 'string' },
    { name: 'task', description: 'Initial task for the agent', type: 'string' },
    { name: 'timeout', description: 'Agent timeout in seconds', type: 'number', default: 300 },
    {
      name: 'auto-tools',
      description: 'Enable automatic tool usage',
      type: 'boolean',
      default: true,
    },
  ],
  examples: [
    {
      command: 'monomind agent spawn --type coder --name bot-1',
      description: 'Record a coder agent (starts no process)',
    },
    {
      command: 'monomind agent spawn -t researcher --task "Research React 19"',
      description: 'Record a researcher agent with a task',
    },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    let agentType = (ctx.flags.type as string | undefined)?.slice(0, 64) ?? '';
    const requestedType = agentType;
    let agentName = (ctx.flags.name as string | undefined)?.slice(0, 128) ?? '';

    const root = getProjectCwd();
    if (!agentType && ctx.interactive) {
      agentType = await select({ message: 'Select agent type:', options: agentTypeOptions(root) });
    }
    if (agentType) {
      const resolved = resolveAgentType(agentType, agentNames(root));
      if (!resolved) {
        output.printError(
          `Unknown agent type "${agentType}". Use a registry agent name (see \`monomind route list-agents\`).`,
        );
        return { success: false, exitCode: 1 };
      }
      if (resolved !== agentType) {
        process.stderr.write(
          `[agent] "${agentType}" is an old type name; spawning "${resolved}"\n`,
        );
        agentType = resolved;
      }
    }

    const taskDescription = (ctx.flags.task as string | undefined)?.slice(0, 2048);
    if (!agentType && taskDescription) {
      try {
        const { createConfiguredRouteLayer } = await import('../routing/route-layer-factory.js');
        const layer = await createConfiguredRouteLayer();
        const routeResult = await layer.route(taskDescription);
        agentType = routeResult.agentSlug;
        process.stderr.write(
          `[route] ${routeResult.method}: "${agentType}" (confidence: ${(routeResult.confidence * 100).toFixed(1)}%)\n`,
        );
      } catch {
        // RouteLayer unavailable — fall through to error below
      }
    }

    if (!agentType) {
      output.printError(
        'Agent type is required. Use --type or -t flag, or provide --task for auto-routing.',
      );
      return { success: false, exitCode: 1 };
    }

    if (!agentName) agentName = `${agentType}-${Date.now().toString(36)}`;

    output.printInfo(`Recording ${agentType} agent: ${output.highlight(agentName)}`);
    const capabilities = agentCapabilities(root, agentType, requestedType || agentType);

    try {
      const result = await callMCPTool<{
        success?: boolean;
        error?: string;
        agentId: string;
        agentType: string;
        status: string;
        createdAt: string;
      }>('agent_spawn', {
        agentType,
        id: agentName,
        config: {
          provider: ctx.flags.provider || 'anthropic',
          model: ctx.flags.model,
          task: ctx.flags.task,
          timeout: ctx.flags.timeout,
          autoTools: ctx.flags['auto-tools'],
        },
        priority: 'normal',
        metadata: { name: agentName, capabilities },
      });

      // agent_spawn resolves (doesn't throw) on a tool-level failure like
      // "agent store is unreadable" or "agent already exists" — callMCPTool
      // only throws for registry/infra errors (tool not found/disabled), not
      // for a handler's own {success:false} response. Without this check the
      // CLI silently rendered a "spawned successfully" table full of
      // undefined fields for a spawn that never actually happened.
      if (result.success === false) {
        output.printError(`Failed to spawn agent: ${result.error || 'unknown error'}`);
        return { success: false, exitCode: 1 };
      }

      output.writeln();
      output.printTable({
        columns: [
          { key: 'property', header: 'Property', width: 15 },
          { key: 'value', header: 'Value', width: 40 },
        ],
        data: [
          { property: 'ID', value: result.agentId },
          { property: 'Type', value: result.agentType },
          { property: 'Name', value: agentName },
          { property: 'Status', value: result.status },
          { property: 'Created', value: result.createdAt },
          { property: 'Capabilities', value: capabilities.join(', ') },
        ],
      });

      output.writeln();
      output.printSuccess(`Agent ${agentName} recorded in the agent store`);
      output.writeln(
        output.dim(
          '  No process was started. To run an agent turn, use `monomind agent exec -r <runner> -p "<prompt>"`.',
        ),
      );
      updateSwarmActivityMetrics(1);

      if (ctx.flags.format === 'json') output.printJson(result);
      return { success: true, data: result };
    } catch (error) {
      output.printError(
        error instanceof MCPClientError
          ? `Failed to spawn agent: ${error.message}`
          : `Unexpected error: ${String(error)}`,
      );
      return { success: false, exitCode: 1 };
    }
  },
};
