import { output } from '../output.js';
import type { Command, CommandContext, CommandResult } from '../types.js';

// ─── status subcommand ───────────────────────────────────────────────────────

export const statusCommand: Command = {
  name: 'status',
  description: 'Check pattern storage and similarity search status',
  options: [{ name: 'verbose', short: 'v', type: 'boolean', description: 'Show detailed metrics' }],
  examples: [
    { command: 'monomind hooks intelligence status', description: 'Show pattern-learning status' },
    { command: 'monomind hooks intelligence status -v', description: 'Show detailed metrics' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const verbose = ctx.flags.verbose === true;

    output.writeln();
    output.writeln(output.bold('Pattern Learning Status'));
    output.writeln(output.dim('─'.repeat(50)));

    const spinner = output.createSpinner({
      text: 'Checking pattern-learning systems...',
      spinner: 'dots',
    });
    spinner.start();

    try {
      const { getIntelligenceStats, initializeIntelligence, getPersistenceStatus } = await import(
        '../memory/intelligence.js'
      );
      const { getHNSWStatus, loadEmbeddingModel } = await import('../memory/memory-initializer.js');

      await initializeIntelligence();
      const stats = getIntelligenceStats();
      const hnswStatus = (await getHNSWStatus()) ?? {
        available: false,
        thresholdEntries: 0,
        activeEmbeddedEntries: 0,
        built: false,
        entryCount: 0,
        dimensions: 0,
        cachePath: null,
      };
      const persistence = getPersistenceStatus();
      const modelInfo = await loadEmbeddingModel({ verbose: false });

      spinner.succeed('Pattern-learning systems checked');

      output.writeln();
      output.printTable({
        columns: [
          { key: 'component', header: 'Component', width: 22 },
          { key: 'status', header: 'Status', width: 12 },
          { key: 'details', header: 'Details', width: 34 },
        ],
        data: [
          {
            component: 'Pattern Learning',
            status: stats.sonaEnabled ? output.success('Active') : output.warning('Inactive'),
            details: stats.sonaEnabled
              ? 'JS pattern-learning layer initialized'
              : 'Not initialized',
          },
          {
            component: 'ReasoningBank',
            status: stats.reasoningBankSize > 0 ? output.success('Active') : output.dim('Empty'),
            details: `${stats.patternsLearned} patterns stored`,
          },
          {
            component: 'Pattern Index',
            status: hnswStatus.available ? output.success('Ready') : output.dim('Empty'),
            details: hnswStatus.available
              ? `${hnswStatus.entryCount} vectors, ${hnswStatus.dimensions}-dim (ANN via SQLite)`
              : 'No vectors indexed yet',
          },
          {
            component: 'Embedding Model',
            status: modelInfo.success ? output.success('Loaded') : output.warning('Fallback'),
            details: `${modelInfo.modelName} (${modelInfo.dimensions}-dim)`,
          },
          {
            component: 'Persistence',
            status: persistence.patternsExist ? output.success('Saved') : output.dim('None'),
            details: persistence.patternsExist
              ? output.dim(persistence.dataDir)
              : 'No persisted patterns',
          },
        ],
      });

      if (verbose) {
        output.writeln();
        output.writeln(output.bold('Detailed Metrics'));
        output.printTable({
          columns: [
            { key: 'metric', header: 'Metric', width: 28 },
            { key: 'value', header: 'Value', width: 20 },
          ],
          data: [
            { metric: 'Trajectories Recorded', value: String(stats.trajectoriesRecorded) },
            { metric: 'Patterns Learned', value: String(stats.patternsLearned) },
            { metric: 'ReasoningBank Size', value: String(stats.reasoningBankSize) },
            { metric: 'Index Dimensions', value: String(hnswStatus.dimensions) },
            { metric: 'Avg Adaptation Time', value: `${stats.avgAdaptationTime.toFixed(3)}ms` },
            {
              metric: 'Last Adaptation',
              value: stats.lastAdaptation
                ? new Date(stats.lastAdaptation).toLocaleTimeString()
                : 'Never',
            },
          ],
        });
      }

      return { success: true, data: { stats, hnswStatus, modelInfo, persistence } };
    } catch (error) {
      spinner.fail('Failed to check pattern-learning systems');
      output.printError(error instanceof Error ? error.message : String(error));
      return { success: false, exitCode: 1 };
    }
  },
};
