import { callMCPTool, MCPClientError } from '../mcp-client.js';
import type { DiffClassification } from '../monovector/diff-classifier.js';
import { output } from '../output.js';
import type { Command, CommandContext, CommandResult } from '../types.js';

function getRiskDisplay(risk: string): string {
  switch (risk) {
    case 'critical':
      return output.color(output.bold('CRITICAL'), 'bgRed' as never, 'white' as never);
    case 'high-risk':
      return output.error('HIGH');
    case 'medium-risk':
      return output.warning('MEDIUM');
    case 'low-risk':
      return output.success('LOW');
    default:
      return risk;
  }
}

function getStatusDisplay(status: string): string {
  switch (status) {
    case 'added':
      return output.success('A');
    case 'modified':
      return output.warning('M');
    case 'deleted':
      return output.error('D');
    case 'renamed':
      return output.info('R');
    default:
      return status;
  }
}

// Diff subcommand
export const diffCommand: Command = {
  name: 'diff',
  description: 'Analyze git diff for change risk assessment and classification',
  options: [
    {
      name: 'risk',
      short: 'r',
      description: 'Show risk assessment',
      type: 'boolean',
      default: false,
    },
    {
      name: 'classify',
      short: 'c',
      description: 'Classify change type',
      type: 'boolean',
      default: false,
    },
    {
      name: 'reviewers',
      description: 'Show recommended reviewers',
      type: 'boolean',
      default: false,
    },
    {
      name: 'format',
      short: 'f',
      description: 'Output format: text, json, table',
      type: 'string',
      default: 'text',
      choices: ['text', 'json', 'table'],
    },
    {
      name: 'verbose',
      short: 'v',
      description: 'Show detailed file-level analysis',
      type: 'boolean',
      default: false,
    },
  ],
  examples: [
    {
      command: 'monomind analyze diff --risk',
      description: 'Analyze current diff with risk assessment',
    },
    {
      command: 'monomind analyze diff HEAD~1 --classify',
      description: 'Classify changes from last commit',
    },
    {
      command: 'monomind analyze diff main..feature --format json',
      description: 'Compare branches with JSON output',
    },
    {
      command: 'monomind analyze diff --reviewers',
      description: 'Get recommended reviewers for changes',
    },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const ref = ctx.args[0] || 'HEAD';
    const showRisk = ctx.flags.risk as boolean;
    const showClassify = ctx.flags.classify as boolean;
    const showReviewers = ctx.flags.reviewers as boolean;
    const formatType = (ctx.flags.format as string) || 'text';
    const verbose = ctx.flags.verbose as boolean;

    // If no specific flag, show all
    const showAll = !showRisk && !showClassify && !showReviewers;

    output.printInfo(`Analyzing diff: ${output.highlight(ref)}`);

    try {
      // Call MCP tool for diff analysis
      const result = await callMCPTool<{
        ref: string;
        timestamp: string;
        files: Array<{
          path: string;
          status: string;
          additions: number;
          deletions: number;
          binary: boolean;
        }>;
        risk: {
          overall: string;
          score: number;
          breakdown: {
            fileCount: number;
            totalChanges: number;
            highRiskFiles: string[];
            securityConcerns: string[];
            breakingChanges: string[];
            testCoverage: string;
          };
        };
        // Real shape is DiffClassification (monovector/diff-classifier.ts):
        // { primary, secondary, confidence, impactLevel, suggestedReviewers,
        // testingStrategy, riskFactors }. This used to be hand-typed here as
        // { category, subcategory, confidence, reasoning } — none of which
        // exist on the real object except confidence — so every read of
        // .category/.subcategory/.reasoning below produced `undefined`
        // ("Type: undefined" in the Diff Analysis summary box, and the same
        // for Category/Subcategory/Reasoning in the --classify table).
        classification: DiffClassification;
        fileRisks: Array<{
          path: string;
          risk: string;
          score: number;
          reasons: string[];
        }>;
        recommendedReviewers: string[];
        summary: string;
      }>('analyze_diff', {
        ref,
        includeFileRisks: verbose,
        includeReviewers: showReviewers || showAll,
      });

      // JSON output
      if (formatType === 'json') {
        output.printJson(result);
        return { success: true, data: result };
      }

      output.writeln();

      // Summary box
      const files = result.files || [];
      const risk = result.risk || {
        overall: 'unknown',
        score: 0,
        breakdown: {
          fileCount: 0,
          totalChanges: 0,
          highRiskFiles: [],
          securityConcerns: [],
          breakingChanges: [],
          testCoverage: 'unknown',
        },
      };
      // Ensure breakdown arrays exist to prevent .length crashes
      if (risk.breakdown) {
        risk.breakdown.highRiskFiles = risk.breakdown.highRiskFiles || [];
        risk.breakdown.securityConcerns = risk.breakdown.securityConcerns || [];
        risk.breakdown.breakingChanges = risk.breakdown.breakingChanges || [];
      }
      const classification: DiffClassification = result.classification || {
        primary: 'unknown',
        secondary: [],
        confidence: 0,
        impactLevel: 'low',
        suggestedReviewers: [],
        testingStrategy: [],
        riskFactors: [],
      };

      output.printBox(
        [
          `Ref: ${result.ref || 'HEAD'}`,
          `Files: ${files.length}`,
          `Risk: ${getRiskDisplay(risk.overall)} (${risk.score}/100)`,
          `Type: ${classification.primary}${classification.secondary.length ? ` (${classification.secondary.join(', ')})` : ''}`,
          ``,
          result.summary || 'No summary available',
        ].join('\n'),
        'Diff Analysis',
      );

      // Risk assessment
      if (showRisk || showAll) {
        output.writeln();
        output.writeln(output.bold('Risk Assessment'));
        output.writeln(output.dim('-'.repeat(50)));

        output.printTable({
          columns: [
            { key: 'metric', header: 'Metric', width: 25 },
            { key: 'value', header: 'Value', width: 30 },
          ],
          data: [
            { metric: 'Overall Risk', value: getRiskDisplay(risk.overall) },
            { metric: 'Risk Score', value: `${risk.score}/100` },
            { metric: 'Files Changed', value: risk.breakdown.fileCount },
            { metric: 'Total Lines Changed', value: risk.breakdown.totalChanges },
            { metric: 'Test Coverage', value: risk.breakdown.testCoverage },
          ],
        });

        // Security concerns
        if (risk.breakdown.securityConcerns.length > 0) {
          output.writeln();
          output.writeln(output.bold(output.warning('Security Concerns')));
          output.printList(risk.breakdown.securityConcerns.map((c) => output.warning(c)));
        }

        // Breaking changes
        if (risk.breakdown.breakingChanges.length > 0) {
          output.writeln();
          output.writeln(output.bold(output.error('Potential Breaking Changes')));
          output.printList(risk.breakdown.breakingChanges.map((c) => output.error(c)));
        }

        // High risk files
        if (risk.breakdown.highRiskFiles.length > 0) {
          output.writeln();
          output.writeln(output.bold('High Risk Files'));
          output.printList(risk.breakdown.highRiskFiles.map((f) => output.warning(f)));
        }
      }

      // Classification
      if (showClassify || showAll) {
        output.writeln();
        output.writeln(output.bold('Classification'));
        output.writeln(output.dim('-'.repeat(50)));

        output.printTable({
          columns: [
            { key: 'field', header: 'Field', width: 15 },
            { key: 'value', header: 'Value', width: 40 },
          ],
          data: [
            { field: 'Category', value: classification.primary },
            {
              field: 'Subcategory',
              value: classification.secondary.length ? classification.secondary.join(', ') : '-',
            },
            { field: 'Confidence', value: `${(classification.confidence * 100).toFixed(0)}%` },
            { field: 'Impact Level', value: classification.impactLevel },
          ],
        });

        output.writeln();
        output.writeln(
          output.dim(
            classification.riskFactors.length
              ? `Risk factors: ${classification.riskFactors.join(', ')}`
              : 'No specific risk factors identified.',
          ),
        );
      }

      // Reviewers
      if (showReviewers || showAll) {
        output.writeln();
        output.writeln(output.bold('Recommended Reviewers'));
        output.writeln(output.dim('-'.repeat(50)));

        const reviewers = result.recommendedReviewers || [];
        if (reviewers.length > 0) {
          output.printNumberedList(reviewers.map((r) => output.highlight(r)));
        } else {
          output.writeln(output.dim('No specific reviewers recommended'));
        }
      }

      // Verbose file-level details
      if (verbose && result.fileRisks) {
        output.writeln();
        output.writeln(output.bold('File-Level Analysis'));
        output.writeln(output.dim('-'.repeat(50)));

        output.printTable({
          columns: [
            { key: 'path', header: 'File', width: 40 },
            { key: 'risk', header: 'Risk', width: 12, format: (v) => getRiskDisplay(String(v)) },
            { key: 'score', header: 'Score', width: 8, align: 'right' },
            {
              key: 'reasons',
              header: 'Reasons',
              width: 30,
              format: (v) => {
                const reasons = v as string[];
                return reasons.slice(0, 2).join('; ');
              },
            },
          ],
          data: result.fileRisks,
        });
      }

      // Files changed table
      if (formatType === 'table' || showAll) {
        output.writeln();
        output.writeln(output.bold('Files Changed'));
        output.writeln(output.dim('-'.repeat(50)));

        output.printTable({
          columns: [
            {
              key: 'status',
              header: 'Status',
              width: 10,
              format: (v) => getStatusDisplay(String(v)),
            },
            { key: 'path', header: 'File', width: 45 },
            {
              key: 'additions',
              header: '+',
              width: 8,
              align: 'right',
              format: (v) => output.success(`+${v}`),
            },
            {
              key: 'deletions',
              header: '-',
              width: 8,
              align: 'right',
              format: (v) => output.error(`-${v}`),
            },
          ],
          data: files.slice(0, 20),
        });

        if (files.length > 20) {
          output.writeln(output.dim(`  ... and ${files.length - 20} more files`));
        }
      }

      return { success: true, data: result };
    } catch (error) {
      if (error instanceof MCPClientError) {
        output.printError(`Diff analysis failed: ${error.message}`);
      } else {
        output.printError(`Unexpected error: ${String(error)}`);
      }
      return { success: false, exitCode: 1 };
    }
  },
};
