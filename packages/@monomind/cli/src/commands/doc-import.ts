import * as path from 'node:path';
import { getProjectRoot } from '../memory/memory-bridge.js';
import { output } from '../output.js';
import type { Command, CommandContext, CommandResult } from '../types.js';

export const importDocCommand: Command = {
  name: 'import',
  description: 'Import an OKF bundle produced by `doc export`',
  options: [
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
      description: 'Import into the personal cross-project global brain',
      type: 'boolean',
    },
  ],
  examples: [
    {
      command: 'monomind doc import ./.monomind/knowledge-export',
      description: 'Import a bundle into this project',
    },
    {
      command: 'monomind doc import ~/brain-bundle --global',
      description: 'Restore a personal brain on another machine',
    },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const bundle = ctx.args[0];
    if (!bundle) {
      output.printError('Bundle directory required: monomind doc import <bundle-dir>');
      return { success: false, exitCode: 1 };
    }

    const { getKnowledgeRoot, importFromOKF } = await import('../knowledge/document-pipeline.js');
    const fs = await import('node:fs');
    const resolved = path.resolve(bundle);

    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      output.printError(`Not a directory: ${resolved}`);
      return { success: false, exitCode: 1 };
    }

    const isGlobal = ctx.flags.global === true;
    const scope = isGlobal ? 'global' : String(ctx.flags.scope || 'shared');

    const spinner = output.createSpinner({ text: 'Importing OKF bundle...' });
    spinner.start();

    try {
      // importFromOKF, not ingestDirectory: the bundle's own index.md is a
      // manifest, not knowledge, and plain ingest would index it as a document.
      // The scope decides the store (`ingestDocument` resolves it the same way
      // per file; passing the matching root keeps the two in step).
      const result = await importFromOKF(
        resolved,
        scope,
        getKnowledgeRoot(scope, getProjectRoot()),
      );
      spinner.result(
        `Imported ${result.totalChunks} chunks from ${result.filesProcessed} documents (${result.filesSkipped} already indexed)`,
      );
      if (result.errors.length) {
        output.writeln(output.dim(`  Errors: ${result.errors.length}`));
        for (const err of result.errors.slice(0, 5)) output.writeln(output.dim(`    ${err}`));
      }
      return { success: true, data: result };
    } catch (err) {
      spinner.fail(String(err));
      return { success: false, exitCode: 1 };
    }
  },
};
