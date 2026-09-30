import { callMCPTool, MCPClientError } from '../mcp-client.js';
import { output } from '../output.js';
import { select } from '../prompt.js';
import type { Command, CommandContext, CommandResult } from '../types.js';
import { STRATEGIES, TOPOLOGIES } from './monoswarm-state.js';

// Initialize swarm
export const initCommand: Command = {
  name: 'init',
  description: 'Record a new swarm state file (starts no agents)',
  options: [
    {
      name: 'topology',
      short: 't',
      description: 'Monoswarm topology',
      type: 'string',
      choices: TOPOLOGIES.map((t) => t.value),
      default: 'hierarchical',
    },
    {
      name: 'max-agents',
      short: 'm',
      description: 'Maximum number of agents',
      type: 'number',
      default: 15,
    },
    {
      name: 'strategy',
      short: 's',
      description: 'Coordination strategy',
      type: 'string',
      choices: STRATEGIES.map((s) => s.value),
    },
    {
      name: 'v1-mode',
      description: 'Enable v1 15-agent hierarchical mesh mode',
      type: 'boolean',
      default: false,
    },
  ],
  // `--format json` reserves stdout for the result document; the progress
  // lines and table go to stderr (dropped under -Q) (#418).
  action: (ctx: CommandContext): Promise<CommandResult> =>
    output.reserveStdout(ctx.flags.format === 'json', () => runInit(ctx)),
};

async function runInit(ctx: CommandContext): Promise<CommandResult> {
  let topology = ctx.flags.topology as string;
  const maxAgents = (ctx.flags['max-agents'] as number) || 15;
  const v1Mode = ctx.flags.v1Mode as boolean;

  // mode enables hierarchical-mesh hybrid
  if (v1Mode) {
    topology = 'hierarchical-mesh';
    output.printInfo('v1 Mode: Using hierarchical-mesh topology with 15-agent coordination');
  }

  // Interactive topology selection
  if (!topology && ctx.interactive) {
    topology = await select({
      message: 'Select swarm topology:',
      options: TOPOLOGIES,
      default: 'hierarchical',
    });
  }

  output.writeln();
  output.printInfo('Initializing swarm...');

  try {
    // Call MCP tool to initialize swarm
    const result = await callMCPTool<{
      monoswarmId: string;
      topology: string;
      initializedAt: string;
      config: {
        topology: string;
        maxAgents: number;
      };
    }>('monoswarm_init', {
      topology: topology as
        | 'hierarchical'
        | 'mesh'
        | 'adaptive'
        | 'ring'
        | 'star'
        | 'hybrid'
        | 'hierarchical-mesh',
      maxAgents,
      config: {
        failureHandling: 'retry',
        loadBalancing: true,
      },
      metadata: {
        v1Mode,
        strategy: ctx.flags.strategy || 'development',
      },
    });

    // Display initialization progress
    output.writeln(output.dim(`  Wrote swarm config: ${result.monoswarmId}`));

    if (v1Mode) {
      output.writeln(
        output.dim(
          '  (v1-mode: topology renamed to hierarchical-mesh; no ANN or keyword routing is performed during init)',
        ),
      );
    }

    output.writeln();
    output.printTable({
      columns: [
        { key: 'property', header: 'Property', width: 20 },
        { key: 'value', header: 'Value', width: 35 },
      ],
      data: [
        { property: 'Monoswarm ID', value: result.monoswarmId },
        { property: 'Topology', value: result.topology },
        { property: 'Max Agents', value: result.config.maxAgents },
        { property: 'v1 Mode', value: v1Mode ? 'Enabled' : 'Disabled' },
      ],
    });

    output.writeln();
    output.printSuccess('Monoswarm state recorded (no agents started)');

    // No further write here: monoswarm_init already persisted the canonical
    // state to `.monomind/monoswarm/state.json` (a single flat record — the
    // CLI and the MCP tools share exactly that one file, so writing a second,
    // differently-shaped copy would overwrite the tool's own record).

    if (ctx.flags.format === 'json') {
      output.printDocument(result);
    }

    return { success: true, data: result };
  } catch (error) {
    if (error instanceof MCPClientError) {
      output.printError(`Failed to initialize swarm: ${error.message}`);
    } else {
      output.printError(`Unexpected error: ${String(error)}`);
    }
    return { success: false, exitCode: 1 };
  }
}
