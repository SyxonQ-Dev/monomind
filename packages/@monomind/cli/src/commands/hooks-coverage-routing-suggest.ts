import { callMCPTool } from '../mcp-client.js';
import { output } from '../output.js';
import type { Command, CommandContext, CommandResult } from '../types.js';
import {
  classifyCoverageGap,
  readCoverageFromDisk,
  suggestAgentsForFile,
} from './hooks-coverage-utils.js';

export const coverageSuggestCommand: Command = {
  name: 'coverage-suggest',
  description: 'Suggest coverage improvements for a path (monovector integration)',
  options: [
    {
      name: 'path',
      short: 'p',
      description: 'Path to analyze for coverage suggestions',
      type: 'string',
      required: true,
    },
    {
      name: 'threshold',
      description: 'Coverage threshold percentage (default: 80)',
      type: 'number',
      default: 80,
    },
    {
      name: 'limit',
      short: 'l',
      description: 'Maximum number of suggestions (default: 20)',
      type: 'number',
      default: 20,
    },
  ],
  examples: [
    {
      command: 'monomind hooks coverage-suggest -p src/',
      description: 'Suggest improvements for src/',
    },
    {
      command: 'monomind hooks coverage-suggest -p src/services --threshold 90',
      description: 'Stricter threshold',
    },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const targetPath = ctx.args[0] || (ctx.flags.path as string);
    const threshold = (ctx.flags.threshold as number) || 80;
    const limit = (ctx.flags.limit as number) || 20;

    if (!targetPath) {
      output.printError('Path is required. Use --path or -p flag.');
      return { success: false, exitCode: 1 };
    }

    const spinner = output.createSpinner({ text: `Analyzing coverage for ${targetPath}...` });
    spinner.start();

    const diskCoverage = readCoverageFromDisk();

    if (diskCoverage.found) {
      spinner.succeed(`Coverage data loaded from ${diskCoverage.source}`);

      const pathLower = targetPath.toLowerCase().replace(/\\/g, '/');
      const matchingEntries = diskCoverage.entries.filter((e) => {
        const fileLower = e.filePath.toLowerCase().replace(/\\/g, '/');
        return fileLower.includes(pathLower);
      });

      const belowThreshold = matchingEntries.filter((e) => e.lines < threshold);
      const suggestions = belowThreshold.slice(0, limit).map((e) => {
        const { gapType, priority } = classifyCoverageGap(e.lines, threshold);
        return {
          filePath: e.filePath,
          coveragePercent: e.lines,
          gapType,
          priority,
          suggestedAgents: suggestAgentsForFile(e.filePath),
          reason:
            e.lines === 0
              ? 'No coverage at all'
              : e.lines < 20
                ? 'Very low coverage, needs tests'
                : e.lines < 50
                  ? 'Below 50%, add more tests'
                  : `Below ${threshold}% threshold`,
        };
      });

      const totalLinesCov =
        matchingEntries.length > 0
          ? matchingEntries.reduce((acc, e) => acc + e.lines, 0) / matchingEntries.length
          : 0;
      const totalBranchesCov =
        matchingEntries.length > 0
          ? matchingEntries.reduce((acc, e) => acc + e.branches, 0) / matchingEntries.length
          : 0;

      const prioritizedFiles = belowThreshold.slice(0, 5).map((e) => e.filePath);

      const result = {
        success: true,
        path: targetPath,
        suggestions,
        summary: {
          totalFiles: matchingEntries.length,
          overallLineCoverage: totalLinesCov,
          overallBranchCoverage: totalBranchesCov,
          filesBelowThreshold: belowThreshold.length,
        },
        prioritizedFiles,
        monovectorAvailable: false,
        source: diskCoverage.source,
      };

      if (ctx.flags.format === 'json') {
        output.printJson(result);
        return { success: true, data: result };
      }

      output.writeln();
      output.printBox(
        [
          `Path: ${output.highlight(targetPath)}`,
          `Files Analyzed: ${result.summary.totalFiles}`,
          `Line Coverage: ${result.summary.overallLineCoverage.toFixed(1)}%`,
          `Branch Coverage: ${result.summary.overallBranchCoverage.toFixed(1)}%`,
          `Below Threshold: ${result.summary.filesBelowThreshold} files`,
          `Source: ${output.highlight(diskCoverage.source)}`,
        ].join('\n'),
        'Coverage Summary',
      );

      if (suggestions.length > 0) {
        output.writeln();
        output.writeln(output.bold('Coverage Improvement Suggestions'));
        output.printTable({
          columns: [
            {
              key: 'filePath',
              header: 'File',
              width: 40,
              format: (v: unknown) => {
                const s = String(v);
                return s.length > 37 ? `...${s.slice(-37)}` : s;
              },
            },
            {
              key: 'coveragePercent',
              header: 'Coverage',
              width: 10,
              align: 'right',
              format: (v: unknown) => `${Number(v).toFixed(1)}%`,
            },
            { key: 'gapType', header: 'Priority', width: 10 },
            { key: 'reason', header: 'Reason', width: 25 },
          ],
          data: suggestions.slice(0, 15),
        });
      } else {
        output.writeln();
        output.printSuccess('All files meet coverage threshold!');
      }

      if (prioritizedFiles.length > 0) {
        output.writeln();
        output.writeln(output.bold('Priority Files (Top 5)'));
        output.printList(prioritizedFiles.slice(0, 5).map((f) => output.highlight(f)));
      }

      return { success: true, data: result };
    }

    try {
      const result = await callMCPTool<{
        success: boolean;
        path: string;
        suggestions: Array<{
          filePath: string;
          coveragePercent: number;
          gapType: string;
          priority: number;
          suggestedAgents: string[];
          reason: string;
        }>;
        summary: {
          totalFiles: number;
          overallLineCoverage: number;
          overallBranchCoverage: number;
          filesBelowThreshold: number;
        };
        prioritizedFiles: string[];
        monovectorAvailable: boolean;
      }>('coverage_suggest', { path: targetPath, threshold, limit });

      spinner.stop();

      if (ctx.flags.format === 'json') {
        output.printJson(result);
        return { success: true, data: result };
      }

      output.writeln();
      output.printBox(
        [
          `Path: ${output.highlight(result.path)}`,
          `Files Analyzed: ${result.summary.totalFiles}`,
          `Line Coverage: ${result.summary.overallLineCoverage.toFixed(1)}%`,
          `Branch Coverage: ${result.summary.overallBranchCoverage.toFixed(1)}%`,
          `Below Threshold: ${result.summary.filesBelowThreshold} files`,
          `Keyword routing: ${result.monovectorAvailable ? output.success('Available') : output.dim('Unavailable')}`,
        ].join('\n'),
        'Coverage Summary',
      );

      if (result.suggestions.length > 0) {
        output.writeln();
        output.writeln(output.bold('Coverage Improvement Suggestions'));
        output.printTable({
          columns: [
            {
              key: 'filePath',
              header: 'File',
              width: 40,
              format: (v: unknown) => {
                const s = String(v);
                return s.length > 37 ? `...${s.slice(-37)}` : s;
              },
            },
            {
              key: 'coveragePercent',
              header: 'Coverage',
              width: 10,
              align: 'right',
              format: (v: unknown) => `${Number(v).toFixed(1)}%`,
            },
            { key: 'gapType', header: 'Priority', width: 10 },
            { key: 'reason', header: 'Reason', width: 25 },
          ],
          data: result.suggestions.slice(0, 15),
        });
      } else {
        output.writeln();
        output.printSuccess('All files meet coverage threshold!');
      }

      if (result.prioritizedFiles.length > 0) {
        output.writeln();
        output.writeln(output.bold('Priority Files (Top 5)'));
        output.printList(result.prioritizedFiles.slice(0, 5).map((f) => output.highlight(f)));
      }

      return { success: true, data: result };
    } catch {
      spinner.fail('No coverage data found');
      output.writeln();
      output.printWarning('No coverage data found. Run your test suite with coverage first.');
      output.writeln();
      output.printList([
        'Jest:     npx jest --coverage',
        'Vitest:   npx vitest --coverage',
        'nyc:      npx nyc npm test',
        'c8:       npx c8 npm test',
      ]);
      output.writeln();
      output.writeln(
        output.dim(
          'Expected files: coverage/coverage-summary.json, coverage/lcov.info, or .nyc_output/out.json',
        ),
      );
      return { success: false, exitCode: 1 };
    }
  },
};
