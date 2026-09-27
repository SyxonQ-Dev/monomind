import { callMCPTool } from '../mcp-client.js';
import { output } from '../output.js';
import { confirm, select } from '../prompt.js';
import type { Command, CommandContext, CommandResult } from '../types.js';
import { STRATEGIES } from './monoswarm-state.js';

// Start swarm execution
export const startCommand: Command = {
  name: 'start',
  description: 'Start swarm execution',
  options: [
    {
      name: 'objective',
      short: 'o',
      description: 'Monoswarm objective/task',
      type: 'string',
      required: true,
    },
    {
      name: 'strategy',
      short: 's',
      description: 'Execution strategy',
      type: 'string',
      choices: STRATEGIES.map((s) => s.value),
    },
    {
      name: 'parallel',
      short: 'p',
      description: 'Enable parallel execution',
      type: 'boolean',
      default: true,
    },
  ],
  examples: [
    {
      command: 'monomind monoswarm start -o "Build REST API" -s development',
      description: 'Start development swarm',
    },
    {
      command: 'monomind monoswarm start -o "Analyze codebase" --parallel',
      description: 'Parallel analysis',
    },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const objective = ctx.args[0] || (ctx.flags.objective as string);
    let strategy = ctx.flags.strategy as string;

    if (!objective) {
      output.printError('Objective is required. Use -o or provide as argument.');
      return { success: false, exitCode: 1 };
    }

    // Interactive strategy selection
    if (!strategy && ctx.interactive) {
      strategy = await select({
        message: 'Select execution strategy:',
        options: STRATEGIES,
        default: 'development',
      });
    }

    strategy = strategy || 'development';

    output.writeln();
    output.printInfo(`Starting swarm with objective: ${output.highlight(objective)}`);
    output.writeln();

    // Compute agent deployment plan based on strategy
    const agentPlan = getAgentPlan(strategy);

    output.writeln(output.bold('Agent Deployment Plan'));
    output.printTable({
      columns: [
        { key: 'role', header: 'Role', width: 20 },
        { key: 'type', header: 'Type', width: 25 },
        { key: 'count', header: 'Count', width: 8, align: 'right' },
        { key: 'purpose', header: 'Purpose', width: 30 },
      ],
      data: agentPlan,
    });

    // Confirm execution
    if (ctx.interactive) {
      const confirmed = await confirm({
        message: `Deploy ${agentPlan.reduce((sum, a) => sum + a.count, 0)} agents?`,
        default: true,
      });

      if (!confirmed) {
        output.printInfo('Monoswarm execution cancelled');
        return { success: true };
      }
    }

    // Initialize swarm via MCP and persist state (#1423: was stub-only, no actual execution)
    const swarmId = `swarm-${Date.now().toString(36)}`;
    const totalAgents = agentPlan.reduce((sum: number, a: { count: number }) => sum + a.count, 0);

    output.writeln();
    const spinner = output.createSpinner({
      text: 'Initializing swarm via MCP...',
      spinner: 'dots',
    });
    spinner.start();

    let resolvedSwarmId = swarmId;
    try {
      // Actually call MCP to initialize the swarm
      const initResult = await callMCPTool('monoswarm_init', {
        topology: 'hierarchical',
        maxAgents: totalAgents,
        strategy: strategy === 'development' ? 'specialized' : strategy,
      });
      const mcpData = typeof initResult === 'string' ? JSON.parse(initResult) : initResult;
      // Prefer the canonical ID assigned by the MCP tool over the locally generated one
      resolvedSwarmId = mcpData?.monoswarmId ?? swarmId;
      spinner.succeed('Monoswarm initialized via MCP');
    } catch (err) {
      // monoswarm_init runs in-process via the local MCP tool registry — there is no
      // separate MCP server to "start" here. A failure means the handler itself
      // threw (bad input, filesystem/config issue, etc.), not that a server is down.
      spinner.fail('monoswarm_init failed — monoswarm metadata saved locally only');
      output.writeln(output.dim(`  Error: ${err instanceof Error ? err.message : String(err)}`));
      output.writeln(
        output.dim(
          '  Run with -v/--verbose for more detail, or `monomind doctor` to check config/permission issues.',
        ),
      );
    }

    // No further write here: monoswarm_init (called above) already persisted
    // the canonical state to `.monomind/monoswarm/state.json` — a single flat
    // record shared with the MCP tools, not a per-id map. `objective` and
    // `agentPlan` are display-only for this command; they are not tracked in
    // the merged monoswarm state (see getSwarmStatus()'s objective field).

    output.writeln();
    output.printSuccess(
      `Monoswarm ${resolvedSwarmId} config written (${totalAgents} agent slots reserved). No agents are running — use 'agent spawn' to dispatch Task-tool agents.`,
    );
    output.writeln(output.dim(`  Monitor: monomind monoswarm status ${resolvedSwarmId}`));

    return {
      success: true,
      data: { swarmId: resolvedSwarmId, objective, strategy, agents: totalAgents },
    };
  },
};

/** The deployment plan `monoswarm start` shows; every `type` is a registry
 *  agent name (a spawnable Task subagent_type). */
function getAgentPlan(
  strategy: string,
): Array<{ role: string; type: string; count: number; purpose: string }> {
  const plans: Record<
    string,
    Array<{ role: string; type: string; count: number; purpose: string }>
  > = {
    specialized: [
      {
        role: 'Coordinator',
        type: 'coordinator',
        count: 1,
        purpose: 'Central orchestration (anti-drift)',
      },
      { role: 'Researcher', type: 'researcher', count: 1, purpose: 'Requirements analysis' },
      { role: 'Architect', type: 'Software Architect', count: 1, purpose: 'System design' },
      { role: 'Coder', type: 'coder', count: 2, purpose: 'Implementation' },
      { role: 'Tester', type: 'tester', count: 1, purpose: 'Quality assurance' },
      { role: 'Reviewer', type: 'reviewer', count: 1, purpose: 'Code review' },
    ],
    balanced: [
      { role: 'Coordinator', type: 'coordinator', count: 1, purpose: 'Orchestrate workflow' },
      { role: 'Worker', type: 'coder', count: 4, purpose: 'General implementation' },
      { role: 'Reviewer', type: 'reviewer', count: 1, purpose: 'Quality review' },
    ],
    adaptive: [
      { role: 'Coordinator', type: 'coordinator', count: 1, purpose: 'Dynamic orchestration' },
      { role: 'Scout', type: 'researcher', count: 1, purpose: 'Task analysis' },
      { role: 'Worker', type: 'coder', count: 3, purpose: 'Adaptive execution' },
    ],
    development: [
      { role: 'Coordinator', type: 'coordinator', count: 1, purpose: 'Orchestrate workflow' },
      { role: 'Architect', type: 'Software Architect', count: 1, purpose: 'System design' },
      { role: 'Coder', type: 'coder', count: 3, purpose: 'Implementation' },
      { role: 'Tester', type: 'tester', count: 2, purpose: 'Quality assurance' },
      { role: 'Reviewer', type: 'reviewer', count: 1, purpose: 'Code review' },
    ],
    research: [
      { role: 'Coordinator', type: 'coordinator', count: 1, purpose: 'Research coordination' },
      { role: 'Researcher', type: 'researcher', count: 4, purpose: 'Data gathering' },
      { role: 'Analyst', type: 'researcher', count: 2, purpose: 'Analysis and synthesis' },
    ],
    testing: [
      { role: 'Test Lead', type: 'tester', count: 1, purpose: 'Test strategy' },
      { role: 'Unit Tester', type: 'tester', count: 2, purpose: 'Unit tests' },
      { role: 'Integration Tester', type: 'tester', count: 2, purpose: 'Integration tests' },
      { role: 'QA Reviewer', type: 'reviewer', count: 1, purpose: 'Quality review' },
    ],
    optimization: [
      {
        role: 'Performance Lead',
        type: 'Performance Benchmarker',
        count: 1,
        purpose: 'Performance strategy',
      },
      { role: 'Profiler', type: 'Performance Monitor', count: 2, purpose: 'Profiling' },
      { role: 'Optimizer', type: 'coder', count: 2, purpose: 'Optimization' },
    ],
    maintenance: [
      { role: 'Coordinator', type: 'coordinator', count: 1, purpose: 'Maintenance planning' },
      { role: 'Refactorer', type: 'coder', count: 2, purpose: 'Code cleanup' },
      { role: 'Documenter', type: 'researcher', count: 1, purpose: 'Documentation' },
    ],
    analysis: [
      { role: 'Analyst Lead', type: 'researcher', count: 1, purpose: 'Analysis coordination' },
      { role: 'Code Analyst', type: 'reviewer', count: 2, purpose: 'Code analysis' },
      { role: 'Security Analyst', type: 'Security Engineer', count: 1, purpose: 'Security review' },
    ],
  };

  return plans[strategy] || plans.development;
}
