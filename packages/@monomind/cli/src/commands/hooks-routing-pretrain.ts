import { DEFAULT_EMBEDDING_MODEL } from '../init/types.js';
import { callMCPTool, MCPClientError } from '../mcp-client.js';
import { output } from '../output.js';
import type { Command, CommandContext, CommandResult } from '../types.js';

// Pretrain subcommand
export const pretrainCommand: Command = {
  name: 'pretrain',
  description: 'Scan hook activity and write consolidated JSON state. No model is trained.',
  options: [
    {
      name: 'path',
      short: 'p',
      description: 'Repository path',
      type: 'string',
      default: '.',
    },
    {
      name: 'depth',
      short: 'd',
      description: 'Analysis depth (shallow, medium, deep)',
      type: 'string',
      default: 'medium',
      choices: ['shallow', 'medium', 'deep'],
    },
    {
      name: 'skip-cache',
      description: 'Skip cached analysis',
      type: 'boolean',
      default: false,
    },
    {
      name: 'with-embeddings',
      description: 'Index documents for semantic search during pretraining',
      type: 'boolean',
      default: true,
    },
    {
      name: 'embedding-model',
      description: 'ONNX embedding model',
      type: 'string',
      default: DEFAULT_EMBEDDING_MODEL,
      choices: [DEFAULT_EMBEDDING_MODEL, 'Xenova/all-MiniLM-L6-v2', 'Xenova/all-mpnet-base-v2'],
    },
    {
      name: 'file-types',
      description: 'File extensions to index (comma-separated)',
      type: 'string',
      default: 'ts,js,py,md,json',
    },
  ],
  examples: [
    { command: 'monomind hooks pretrain', description: 'Pretrain with embeddings indexing' },
    {
      command: 'monomind hooks pretrain -p ../my-project --depth deep',
      description: 'Deep analysis of specific project',
    },
    {
      command: 'monomind hooks pretrain --no-with-embeddings',
      description: 'Skip embedding indexing',
    },
    {
      command: 'monomind hooks pretrain --file-types ts,tsx,js',
      description: 'Index only TypeScript/JS files',
    },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const repoPath = (ctx.flags.path as string) || '.';
    const depth = (ctx.flags.depth as string) || 'medium';
    const withEmbeddings =
      ctx.flags['with-embeddings'] !== false && ctx.flags.withEmbeddings !== false;
    const embeddingModel = (ctx.flags['embedding-model'] ||
      ctx.flags.embeddingModel ||
      DEFAULT_EMBEDDING_MODEL) as string;
    const fileTypes = (ctx.flags['file-types'] ||
      ctx.flags.fileTypes ||
      'ts,js,py,md,json') as string;

    output.writeln();
    output.writeln(output.bold('Indexing hook activity into local JSON state'));
    output.writeln();

    const spinner = output.createSpinner({ text: 'Scanning repository...', spinner: 'dots' });

    try {
      spinner.start();

      // Call MCP tool for the filesystem scan
      const result = await callMCPTool<{
        path: string;
        depth: string;
        stats: {
          filesAnalyzed: number;
          totalLines?: number;
          patternsExtracted: number;
          patternsStored?: number;
          neuralPatternsLearned?: number;
          documentsIndexed?: number;
          embeddingsGenerated?: number;
        };
        durationMs: number;
      }>('hooks_pretrain', {
        path: repoPath,
        depth,
        skipCache: ctx.flags['skip-cache'] || false,
        withEmbeddings,
        embeddingModel,
        fileTypes: fileTypes.split(',').map((t: string) => t.trim()),
      });

      spinner.succeed('Pretraining completed');

      if (ctx.flags.format === 'json') {
        output.printJson(result);
        return { success: true, data: result };
      }

      output.writeln();

      // Base stats — these reflect the actual filesystem scan work performed by the MCP tool
      const tableData: Array<{ metric: string; value: string | number }> = [
        { metric: 'Files Analyzed', value: result.stats.filesAnalyzed },
        { metric: 'Patterns Extracted', value: result.stats.patternsExtracted },
      ];

      // Optional stats returned by the MCP scan
      if (result.stats.patternsStored !== undefined) {
        tableData.push({ metric: 'Patterns Stored', value: result.stats.patternsStored });
      }

      // Embedding stats (when indexing was actually performed by the MCP tool)
      if (withEmbeddings && result.stats.documentsIndexed !== undefined) {
        tableData.push(
          { metric: 'Documents Indexed', value: result.stats.documentsIndexed },
          { metric: 'Embeddings Generated', value: result.stats.embeddingsGenerated || 0 },
        );
      }

      tableData.push({
        metric: 'Duration',
        value: `${((result.durationMs ?? 0) / 1000).toFixed(1)}s`,
      });

      output.printTable({
        columns: [
          { key: 'metric', header: 'Metric', width: 30 },
          { key: 'value', header: 'Value', width: 15, align: 'right' },
        ],
        data: tableData,
      });

      output.writeln();
      output.printSuccess('Repository intelligence bootstrapped successfully');
      if (withEmbeddings && result.stats.documentsIndexed !== undefined) {
        output.writeln(
          output.dim('  Semantic search enabled: Use "embeddings search -q <query>" to search'),
        );
      }

      return { success: true, data: result };
    } catch (error) {
      spinner.fail('Pretraining failed');
      if (error instanceof MCPClientError) {
        output.printError(`Pretraining error: ${error.message}`);
      } else {
        output.printError(`Unexpected error: ${String(error)}`);
      }
      return { success: false, exitCode: 1 };
    }
  },
};
