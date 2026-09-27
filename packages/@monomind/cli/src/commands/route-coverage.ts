/**
 * Route coverage subcommand: coverage-aware routing.
 * Split from route.ts.
 *
 * @module @monomind/cli/commands/route-coverage
 */

import { output } from '../output.js';
import type { Command, CommandContext, CommandResult } from '../types.js';

// ============================================================================
// Coverage-Aware Routing Subcommand
// ============================================================================

export const coverageRouteCommand: Command = {
  name: 'coverage',
  aliases: ['cov'],
  description: 'Route tasks based on test coverage analysis (ADR-017)',
  options: [
    {
      name: 'path',
      short: 'p',
      description: 'Path to analyze for coverage',
      type: 'string',
    },
    {
      name: 'threshold',
      short: 't',
      description: 'Coverage threshold percentage (default: 80)',
      type: 'number',
      default: 80,
    },
    {
      name: 'suggest',
      short: 's',
      description: 'Get suggestions for improving coverage',
      type: 'boolean',
      default: false,
    },
    {
      name: 'gaps',
      short: 'g',
      description: 'List coverage gaps with agent assignments',
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
    { command: 'monomind route coverage', description: 'Analyze coverage and suggest routing' },
    { command: 'monomind route coverage --suggest', description: 'Get improvement suggestions' },
    { command: 'monomind route coverage --gaps', description: 'List coverage gaps by agent' },
    {
      command: 'monomind route coverage -p src/auth -t 90',
      description: 'Analyze specific path with threshold',
    },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const path = (ctx.flags.path as string) || '';
    const threshold = (ctx.flags.threshold as number) || 80;
    const suggestMode = ctx.flags.suggest as boolean;
    const gapsMode = ctx.flags.gaps as boolean;
    const jsonOutput = ctx.flags.json as boolean;

    const spinner = output.createSpinner({ text: 'Analyzing coverage...', spinner: 'dots' });
    spinner.start();

    try {
      // Lazy load coverage router
      const { coverageRoute, coverageSuggest, coverageGaps } = await import(
        '../monovector/coverage-router.js'
      );

      if (gapsMode) {
        // List coverage gaps with agent assignments
        const result = await coverageGaps({ threshold, groupByAgent: true });
        spinner.succeed(`Found ${result.totalGaps} coverage gaps`);

        if (jsonOutput) {
          output.printJson(result);
        } else {
          output.writeln();
          output.writeln(output.bold('Coverage Gaps by Agent'));
          output.writeln(output.dim(result.summary));
          output.writeln();

          if (Object.keys(result.byAgent).length > 0) {
            for (const [agent, files] of Object.entries(result.byAgent)) {
              output.writeln(`${output.highlight(agent)} (${files.length} files)`);
              for (const file of files.slice(0, 5)) {
                output.writeln(`  ${output.dim('•')} ${file}`);
              }
              if (files.length > 5) {
                output.writeln(output.dim(`    ... and ${files.length - 5} more`));
              }
              output.writeln();
            }
          } else {
            output.printSuccess('No coverage gaps found!');
          }

          output.writeln();
          output.writeln(output.bold('Top Gaps:'));
          output.printTable({
            columns: [
              { key: 'file', header: 'File', width: 50 },
              { key: 'coverage', header: 'Coverage', width: 12, align: 'right' },
              { key: 'gap', header: 'Gap', width: 10, align: 'right' },
              { key: 'agent', header: 'Agent', width: 15 },
            ],
            data: result.gaps.slice(0, 10).map((g) => ({
              file: g.file.length > 48 ? `...${g.file.slice(-45)}` : g.file,
              coverage: `${g.currentCoverage.toFixed(1)}%`,
              gap: `${g.gap.toFixed(1)}%`,
              agent: g.suggestedAgent,
            })),
          });
        }

        return { success: true, data: result };
      }

      if (suggestMode || path) {
        // Suggest improvements for path
        const result = await coverageSuggest(path || '.', { threshold, limit: 20 });
        spinner.succeed(`Found ${result.suggestions.length} coverage suggestions`);

        if (jsonOutput) {
          output.printJson(result);
        } else {
          output.writeln();
          output.writeln(output.bold('Coverage Improvement Suggestions'));
          output.writeln(output.dim(`Path: ${result.path}, Threshold: ${threshold}%`));
          output.writeln();

          if (result.suggestions.length === 0) {
            output.printSuccess('All files meet coverage threshold!');
          } else {
            output.writeln(`Total Gap: ${output.warning(`${result.totalGap.toFixed(1)}%`)}`);
            output.writeln(
              `Estimated Effort: ${output.dim(`${result.estimatedEffort.toFixed(1)} hours`)}`,
            );
            output.writeln();

            output.printTable({
              columns: [
                { key: 'file', header: 'File', width: 45 },
                { key: 'current', header: 'Current', width: 10, align: 'right' },
                { key: 'target', header: 'Target', width: 10, align: 'right' },
                { key: 'priority', header: 'Priority', width: 10, align: 'right' },
              ],
              data: result.suggestions.slice(0, 15).map((s) => ({
                file: s.file.length > 43 ? `...${s.file.slice(-40)}` : s.file,
                current: `${s.currentCoverage.toFixed(1)}%`,
                target: `${s.targetCoverage.toFixed(1)}%`,
                priority: String(s.priority),
              })),
            });

            // Show test suggestions for top file
            if (result.suggestions.length > 0 && result.suggestions[0].suggestedTests.length > 0) {
              output.writeln();
              output.writeln(output.bold('Suggested Tests for Top Priority File:'));
              output.printList(result.suggestions[0].suggestedTests);
            }
          }
        }

        return { success: true, data: result };
      }

      // Default: Route based on coverage analysis
      const routeResult = await coverageRoute('', { threshold });
      spinner.succeed('Coverage analysis complete');

      if (jsonOutput) {
        output.printJson(routeResult);
      } else {
        output.writeln();
        output.writeln(output.bold('Coverage-Aware Routing'));
        output.writeln();

        const actionColors: Record<string, (s: string) => string> = {
          'add-tests': (s: string) => output.error(s),
          'review-coverage': (s: string) => output.warning(s),
          prioritize: (s: string) => output.error(s),
          skip: (s: string) => output.success(s),
        };
        const colorFn = actionColors[routeResult.action] || ((s: string) => s);

        output.printBox(
          [
            `Action: ${colorFn(routeResult.action.toUpperCase())}`,
            `Priority: ${routeResult.priority}/10`,
            `Impact Score: ${routeResult.impactScore}%`,
            `Estimated Effort: ${routeResult.estimatedEffort} hours`,
            ``,
            `Test Types: ${routeResult.testTypes.join(', ')}`,
            `Target Files: ${routeResult.targetFiles.length}`,
          ].join('\n'),
          'Coverage Analysis',
        );

        if (routeResult.targetFiles.length > 0) {
          output.writeln();
          output.writeln(output.bold('Target Files:'));
          output.printList(
            routeResult.targetFiles
              .slice(0, 5)
              .map((f) => (f.length > 60 ? `...${f.slice(-57)}` : f)),
          );
          if (routeResult.targetFiles.length > 5) {
            output.writeln(output.dim(`  ... and ${routeResult.targetFiles.length - 5} more`));
          }
        }

        if (routeResult.gaps.length > 0) {
          output.writeln();
          output.writeln(output.bold('Coverage Gaps:'));
          output.printTable({
            columns: [
              { key: 'file', header: 'File', width: 40 },
              { key: 'current', header: 'Current', width: 10, align: 'right' },
              { key: 'gap', header: 'Gap', width: 10, align: 'right' },
            ],
            data: routeResult.gaps.slice(0, 5).map((g) => ({
              file: g.file.length > 38 ? `...${g.file.slice(-35)}` : g.file,
              current: `${g.currentCoverage.toFixed(1)}%`,
              gap: `${g.gap.toFixed(1)}%`,
            })),
          });
        }
      }

      return { success: true, data: routeResult };
    } catch (error) {
      spinner.fail('Coverage analysis failed');
      output.printError(error instanceof Error ? error.message : String(error));
      return { success: false, exitCode: 1 };
    }
  },
};
