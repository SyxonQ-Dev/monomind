/**
 * Route subcommands that pick agents: task, semantic, list-agents.
 * Split from route.ts.
 *
 * @module @monomind/cli/commands/route-task-commands
 */

import type { RouteDecision } from '../monovector/index.js';
import { output } from '../output.js';
import type { Command, CommandContext, CommandResult } from '../types.js';
import { agentName, findAgent, getRouter, registryAgents } from './route-shared.js';

// ============================================================================
// Route Subcommand
// ============================================================================

export const routeTaskCommand: Command = {
  name: 'task',
  description: 'Route a task to the best registry agent (same ranking as `monomind pick`)',
  options: [
    {
      name: 'keyword',
      short: 'k',
      description: 'Accepted for compatibility; routing always uses the central picker',
      type: 'boolean',
      default: true,
    },
    {
      name: 'agent',
      short: 'a',
      description: 'Force a specific agent by name or slug (bypasses routing)',
      type: 'string',
    },
    {
      name: 'json',
      short: 'j',
      description: 'Output in JSON format',
      type: 'boolean',
      default: false,
    },
  ],
  examples: [
    {
      command: 'monomind route task "implement authentication"',
      description: 'Route task to best agent',
    },
    {
      command: 'monomind route task "write unit tests"',
      description: 'Route test task to tester agent',
    },
    {
      command: 'monomind route task "review code" --agent reviewer',
      description: 'Force specific agent',
    },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const rawTask = ctx.args[0];
    const forceAgent = ctx.flags.agent as string | undefined;
    const jsonOutput = ctx.flags.json as boolean;

    if (!rawTask) {
      output.printError('Task description is required');
      output.writeln(output.dim('Usage: monomind route task "task description"'));
      return { success: false, exitCode: 1 };
    }
    if (rawTask.length > 4096) {
      output.printError('Task description too long (max 4096 characters)');
      return { success: false, exitCode: 1 };
    }
    const taskDescription = rawTask;

    const spinner = output.createSpinner({ text: 'Analyzing task...', spinner: 'dots' });
    spinner.start();

    try {
      if (forceAgent) {
        // Use specified agent directly
        const agent = findAgent(forceAgent);

        if (!agent) {
          spinner.fail(`Agent "${forceAgent}" not found`);
          output.writeln();
          output.writeln('Available agents:');
          output.printList(registryAgents().map((a) => output.highlight(agentName(a))));
          return { success: false, exitCode: 1 };
        }
        const name = agentName(agent);

        spinner.succeed(`Routed to ${name}`);

        if (jsonOutput) {
          output.printJson({
            task: taskDescription,
            agentId: name,
            agentName: name,
            confidence: 1.0,
            method: 'forced',
          });
        } else {
          output.writeln();
          output.printBox(
            [
              `Task: ${taskDescription}`,
              `Agent: ${output.highlight(name)}`,
              `Confidence: ${output.success('100%')} (forced)`,
              `Description: ${agent.description ?? ''}`,
            ].join('\n'),
            'Routing Result',
          );
        }

        return { success: true, data: { agentId: name, agentName: name } };
      }

      // Route through the central picker (monovector createKeywordRouter)
      const router = await getRouter();
      const result: RouteDecision = await router.route(taskDescription);
      const agent = findAgent(result.route);

      spinner.succeed(`Routed to ${result.route}`);

      if (jsonOutput) {
        output.printJson({
          task: taskDescription,
          agentId: result.route,
          agentName: result.route,
          confidence: result.confidence,
          alternatives: (result.alternatives || []).map((a) => ({
            agentId: a.route,
            agentName: a.route,
            score: a.score,
          })),
        });
      } else {
        output.writeln();

        const confidence = result.confidence ?? 0;
        // Use bound methods to preserve `this` context when calling output methods
        const confidenceColor =
          confidence >= 0.7
            ? (text: string) => output.success(text)
            : confidence >= 0.4
              ? (text: string) => output.warning(text)
              : (text: string) => output.error(text);

        const alternatives = result.alternatives || [];

        output.printBox(
          [
            `Task: ${taskDescription}`,
            ``,
            `Agent: ${output.highlight(result.route)}`,
            `Confidence: ${confidenceColor(`${(confidence * 100).toFixed(1)}%`)}`,
            ``,
            `Description: ${agent?.description ?? ''}`,
            `Category: ${agent?.category || '-'}`,
          ].join('\n'),
          'Agent Routing',
        );

        if (alternatives.length > 0) {
          output.writeln();
          output.writeln(output.bold('Alternatives:'));
          output.printTable({
            columns: [
              { key: 'agent', header: 'Agent', width: 32 },
              { key: 'score', header: 'Score', width: 12, align: 'right' },
            ],
            data: alternatives.map((a) => ({
              agent: a.route,
              score: (a.score ?? 0).toFixed(3),
            })),
          });
        }
      }

      return { success: true, data: { agentId: result.route, result } };
    } catch (error) {
      spinner.fail('Routing failed');
      output.printError(error instanceof Error ? error.message : String(error));
      return { success: false, exitCode: 1 };
    }
  },
};

// ============================================================================
// List Agents Subcommand
// ============================================================================

export const listAgentsCommand: Command = {
  name: 'list-agents',
  aliases: ['agents', 'ls'],
  description: 'List all available agent types for routing',
  options: [
    {
      name: 'json',
      short: 'j',
      description: 'Output in JSON format',
      type: 'boolean',
      default: false,
    },
  ],
  examples: [
    { command: 'monomind route list-agents', description: 'List all agents' },
    { command: 'monomind route agents --json', description: 'List agents as JSON' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const jsonOutput = ctx.flags.json as boolean;

    try {
      const agents = registryAgents().map((a) => ({
        id: a.id,
        name: agentName(a),
        category: a.category ?? '',
        description: a.description ?? '',
      }));
      if (jsonOutput) {
        output.printJson(agents);
      } else {
        output.writeln();
        output.writeln(output.bold('Available Agents'));
        output.writeln(
          output.dim('Name = spawnable Task subagent_type (from .monomind/registry.json)'),
        );
        output.writeln();

        output.printTable({
          columns: [
            { key: 'name', header: 'Name', width: 32 },
            { key: 'category', header: 'Category', width: 14 },
            { key: 'description', header: 'Description', width: 45 },
          ],
          data: agents.map((a) => ({
            name: output.highlight(a.name),
            category: a.category,
            description: a.description.replace(/\s+/g, ' ').slice(0, 90),
          })),
        });

        output.writeln();
        output.writeln(output.dim(`Total: ${agents.length} agents`));
      }

      return { success: true, data: agents };
    } catch (error) {
      output.printError(error instanceof Error ? error.message : String(error));
      return { success: false, exitCode: 1 };
    }
  },
};

// ============================================================================
// Semantic Route Subcommand (RouteLayer — cosine similarity)
// ============================================================================

export const semanticRouteCommand: Command = {
  name: 'semantic',
  aliases: ['sem'],
  description:
    'Route a task through the central picker, falling back to cosine similarity (RouteLayer) and Haiku',
  options: [
    {
      name: 'task',
      short: 't',
      description: 'Task description to route',
      type: 'string',
      required: true,
    },
    {
      name: 'debug',
      short: 'd',
      description: 'Include all route scores in the output',
      type: 'boolean',
      default: false,
    },
    {
      name: 'json',
      short: 'j',
      description: 'Output in JSON format',
      type: 'boolean',
      default: false,
    },
  ],
  examples: [
    {
      command: 'monomind route semantic -t "audit the API for injection risks"',
      description: 'Semantic routing',
    },
    {
      command: 'monomind route semantic -t "write unit tests" --debug',
      description: 'Show all route scores',
    },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const rawSemanticTask = ctx.flags.task as string;
    const debug = ctx.flags.debug as boolean;
    const jsonOutput = ctx.flags.json as boolean;

    if (!rawSemanticTask) {
      output.printError('Task description is required. Use --task or -t flag.');
      return { success: false, exitCode: 1 };
    }
    if (rawSemanticTask.length > 4096) {
      output.printError('Task description too long (max 4096 characters)');
      return { success: false, exitCode: 1 };
    }
    const taskDescription = rawSemanticTask;

    const spinner = output.createSpinner({ text: 'Computing semantic route...', spinner: 'dots' });
    spinner.start();

    try {
      // Builds a RouteLayer with a real local embedding model + headless
      // Claude Code (Haiku) fallback when available; degrades gracefully.
      const { createConfiguredRouteLayer } = await import('../routing/route-layer-factory.js');
      const layer = await createConfiguredRouteLayer({ debug });
      const result = await layer.route(taskDescription);

      spinner.succeed(`Routed to ${result.agentSlug}`);

      if (jsonOutput) {
        output.printJson(result);
      } else {
        output.writeln();
        const confidencePct = (result.confidence * 100).toFixed(1);
        const methodColor =
          result.method === 'semantic' || result.method === 'jev'
            ? (s: string) => output.success(s)
            : (s: string) => output.warning(s);

        output.printBox(
          [
            `Task: ${taskDescription}`,
            ``,
            `Agent: ${output.highlight(result.agentSlug)}`,
            `Route: ${result.routeName}`,
            `Confidence: ${methodColor(`${confidencePct}%`)}`,
            `Method: ${methodColor(result.method)}`,
          ].join('\n'),
          'Semantic Routing Result',
        );

        if (debug && result.allScores && result.allScores.length > 0) {
          output.writeln();
          output.writeln(output.bold('All Route Scores (top 10):'));
          const top10 = result.allScores.slice(0, 10);
          output.printTable({
            columns: [
              { key: 'route', header: 'Route', width: 30 },
              { key: 'agent', header: 'Agent Slug', width: 35 },
              { key: 'score', header: 'Score', width: 10, align: 'right' },
            ],
            data: top10.map((s) => ({
              route: s.routeName,
              agent: s.agentSlug,
              score: s.score.toFixed(4),
            })),
          });
        }
      }

      return { success: true, data: result };
    } catch (error) {
      spinner.fail('Semantic routing failed');
      output.printError(error instanceof Error ? error.message : String(error));
      return { success: false, exitCode: 1 };
    }
  },
};
