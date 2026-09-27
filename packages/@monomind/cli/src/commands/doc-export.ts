import * as path from 'node:path';
import { getProjectRoot } from '../memory/memory-bridge.js';
import { output } from '../output.js';
import type { Command, CommandContext, CommandResult } from '../types.js';

export const exportDocCommand: Command = {
  name: 'export',
  description: 'Export knowledge base as OKF bundle (markdown + frontmatter)',
  options: [
    {
      name: 'output',
      short: 'o',
      description: 'Output directory',
      type: 'string',
      default: '.monomind/knowledge-export',
    },
    {
      name: 'scope',
      short: 's',
      description: 'Knowledge scope (default: shared)',
      type: 'string',
      default: 'shared',
    },
    {
      name: 'global',
      short: 'g',
      description: 'Export the personal cross-project global brain (portable between machines)',
      type: 'boolean',
    },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const { exportToOKF, getKnowledgeRoot } = await import('../knowledge/document-pipeline.js');
    const outDir = path.resolve(String(ctx.flags.output || '.monomind/knowledge-export'));
    const isGlobal = ctx.flags.global === true;
    const scope = isGlobal ? 'global' : String(ctx.flags.scope || 'shared');

    const spinner = output.createSpinner({ text: 'Exporting to OKF...' });
    spinner.start();

    try {
      // The scope decides the store, not the flag alone: `--scope profile:<id>`
      // lives in that profile's brain, and reading the project's log for it
      // exported an empty bundle.
      const result = await exportToOKF(outDir, getKnowledgeRoot(scope, getProjectRoot()), scope);
      spinner.succeed(`Exported ${result.exported} documents to ${result.outputDir}`);
      return { success: true, data: result };
    } catch (err) {
      spinner.fail(String(err));
      return { success: false, exitCode: 1 };
    }
  },
};
