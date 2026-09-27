import { output } from '../output.js';
import type { Command, CommandContext, CommandResult } from '../types.js';

// ─── patterns subcommand ─────────────────────────────────────────────────────

export const patternsCommand: Command = {
  name: 'patterns',
  description: 'List and search stored patterns',
  options: [
    {
      name: 'action',
      short: 'a',
      type: 'string',
      description: 'Action: analyze, learn, predict, list',
      default: 'list',
    },
    { name: 'query', short: 'q', type: 'string', description: 'Pattern query for search' },
    {
      name: 'limit',
      short: 'l',
      type: 'number',
      description: 'Max patterns to return',
      default: '10',
    },
  ],
  examples: [
    {
      command: 'monomind hooks intelligence patterns --action list',
      description: 'List all patterns',
    },
    {
      command: 'monomind hooks intelligence patterns -a analyze -q "error handling"',
      description: 'Analyze patterns',
    },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const action = (ctx.flags.action as string) || 'list';
    const query = ctx.flags.query as string;
    const limit = parseInt(ctx.flags.limit as string, 10) || 10;

    output.writeln();
    output.writeln(output.bold(`Neural Patterns - ${action}`));
    output.writeln(output.dim('─'.repeat(40)));

    try {
      const {
        initializeIntelligence,
        getIntelligenceStats,
        findSimilarPatterns,
        getAllPatterns,
        getPersistenceStatus,
      } = await import('../memory/intelligence.js');

      await initializeIntelligence();
      const stats = getIntelligenceStats();
      const persistence = getPersistenceStatus();

      if (action === 'list') {
        const allPatterns = await getAllPatterns();
        const patterns = query
          ? await findSimilarPatterns(query, { k: limit })
          : allPatterns.slice(0, limit);

        if (patterns.length === 0) {
          output.writeln(
            output.dim(
              'No patterns found. Train some patterns first with: hooks intelligence train',
            ),
          );
          output.writeln();
          output.printBox(
            [
              `Total Patterns: ${stats.patternsLearned}`,
              `Trajectories: ${stats.trajectoriesRecorded}`,
              `ReasoningBank Size: ${stats.reasoningBankSize}`,
              `Persistence: ${persistence.patternsExist ? 'Loaded from disk' : 'Not persisted'}`,
              `Data Dir: ${persistence.dataDir}`,
            ].join('\n'),
            'Pattern Statistics',
          );
        } else {
          output.printTable({
            columns: [
              { key: 'id', header: 'ID', width: 20 },
              { key: 'type', header: 'Type', width: 18 },
              { key: 'confidence', header: 'Confidence', width: 12 },
              { key: 'usage', header: 'Usage', width: 10 },
            ],
            data: patterns.map((p, i) => ({
              id: (p.id || `P${String(i + 1).padStart(3, '0')}`).substring(0, 18),
              type: output.highlight(p.type || 'unknown'),
              confidence: `${((p.confidence || 0.5) * 100).toFixed(1)}%`,
              usage: String(p.usageCount || 0),
            })),
          });
        }

        output.writeln();
        output.writeln(
          output.dim(
            `Total: ${allPatterns.length} patterns (persisted) | Trajectories: ${stats.trajectoriesRecorded}`,
          ),
        );
        if (persistence.patternsExist)
          output.writeln(output.success(`✓ Loaded from: ${persistence.patternsFile}`));
      } else if (action === 'analyze' && !query) {
        output.printError('--query is required when --action analyze is used.');
        return { success: false, exitCode: 1 };
      } else if (action === 'analyze' && query) {
        const related = await findSimilarPatterns(query, { k: limit });
        output.writeln(`Analyzing patterns related to: "${query}"`);
        output.writeln();

        if (related.length > 0) {
          output.printTable({
            columns: [
              { key: 'content', header: 'Pattern', width: 40 },
              { key: 'confidence', header: 'Confidence', width: 12 },
              { key: 'type', header: 'Type', width: 15 },
            ],
            data: related.slice(0, 5).map((p) => ({
              content: (p.content || '').substring(0, 38) + (p.content?.length > 38 ? '...' : ''),
              confidence: `${((p.confidence || 0) * 100).toFixed(0)}%`,
              type: p.type || 'general',
            })),
          });
        } else {
          output.writeln(output.dim('No related patterns found.'));
        }
      }

      return { success: true };
    } catch {
      output.writeln(output.dim('Intelligence system not initialized.'));
      output.writeln(output.dim('Run: monomind hooks intelligence train --pattern-type general'));
      return { success: false };
    }
  },
};
