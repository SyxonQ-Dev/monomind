import { output } from '../output.js';
import type { Command, CommandContext, CommandResult } from '../types.js';

// ─── predict subcommand ──────────────────────────────────────────────────────

export const predictCommand: Command = {
  name: 'predict',
  description: 'Find similar patterns by similarity search',
  options: [
    {
      name: 'input',
      short: 'i',
      type: 'string',
      description: 'Input text to predict routing for',
      required: true,
    },
    {
      name: 'k',
      short: 'k',
      type: 'number',
      description: 'Number of top predictions',
      default: '5',
    },
    {
      name: 'format',
      short: 'f',
      type: 'string',
      description: 'Output format: json, table',
      default: 'table',
    },
  ],
  examples: [
    {
      command: 'monomind hooks intelligence predict -i "implement authentication"',
      description: 'Predict routing for task',
    },
    {
      command: 'monomind hooks intelligence predict -i "fix bug in login" -k 3',
      description: 'Get top 3 predictions',
    },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const inputText = ctx.flags.input as string;
    const k = parseInt((ctx.flags.k as string) || '5', 10);
    const format = (ctx.flags.format as string) || 'table';

    if (!inputText) {
      output.printError('--input is required');
      return { success: false, exitCode: 1 };
    }

    output.writeln();
    output.writeln(output.bold('Pattern Similarity Search'));
    output.writeln(output.dim('─'.repeat(50)));

    const spinner = output.createSpinner({ text: 'Searching patterns...', spinner: 'dots' });
    spinner.start();

    try {
      const { initializeIntelligence, findSimilarPatterns } = await import(
        '../memory/intelligence.js'
      );

      await initializeIntelligence();

      const startSearch = performance.now();
      const matches = await findSimilarPatterns(inputText, { k });
      const searchTime = performance.now() - startSearch;

      spinner.succeed(`Prediction complete (search: ${searchTime.toFixed(1)}ms)`);
      output.writeln();

      if (matches.length === 0) {
        output.writeln(
          output.warning(
            'No similar patterns found. Try training first: monomind hooks intelligence train',
          ),
        );
        return { success: true, data: { matches: [] } };
      }

      if (format === 'json') {
        output.writeln(JSON.stringify(matches, null, 2));
      } else {
        const patternTypes: Record<string, number> = {};
        for (const match of matches) {
          const type = match.type || 'unknown';
          patternTypes[type] = (patternTypes[type] || 0) + match.similarity;
        }

        const sorted = Object.entries(patternTypes).sort((a, b) => b[1] - a[1]);
        const topType = sorted[0]?.[0] || 'unknown';
        const confidence = matches[0]?.similarity || 0;

        output.printBox(
          [
            `Input: ${inputText.substring(0, 60)}${inputText.length > 60 ? '...' : ''}`,
            ``,
            `Predicted Type: ${topType}`,
            `Confidence: ${(confidence * 100).toFixed(1)}%`,
            `Latency: ${searchTime.toFixed(1)}ms`,
            ``,
            `Top ${matches.length} Similar Patterns:`,
          ].join('\n'),
          'Result',
        );

        output.printTable({
          columns: [
            { key: 'rank', header: '#', width: 3 },
            { key: 'id', header: 'Pattern ID', width: 20 },
            { key: 'type', header: 'Type', width: 15 },
            { key: 'similarity', header: 'Similarity', width: 12 },
          ],
          data: matches.slice(0, k).map((m, i) => ({
            rank: String(i + 1),
            id: m.id?.substring(0, 20) || 'unknown',
            type: m.type || 'action',
            similarity: `${(m.similarity * 100).toFixed(1)}%`,
          })),
        });
      }

      return { success: true, data: { matches, searchTime } };
    } catch (error) {
      spinner.fail('Prediction failed');
      output.printError(error instanceof Error ? error.message : String(error));
      return { success: false, exitCode: 1 };
    }
  },
};
