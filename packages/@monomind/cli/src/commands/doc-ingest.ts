import * as path from 'node:path';
import { getProjectRoot } from '../memory/memory-bridge.js';
import { output } from '../output.js';
import type { Command, CommandContext, CommandResult } from '../types.js';

export const ingestCommand: Command = {
  name: 'ingest',
  description: 'Ingest documents into the knowledge base',
  options: [
    {
      name: 'scope',
      short: 's',
      description:
        'Knowledge scope (default: shared; auto-routes to global for paths outside the project)',
      type: 'string',
    },
    {
      name: 'global',
      short: 'g',
      description: 'Ingest into the personal cross-project global brain (~/.monomind/global-brain)',
      type: 'boolean',
    },
    {
      name: 'embedder',
      description:
        'Deprecated, has no effect: the knowledge base always embeds with Alibaba-NLP/gte-modernbert-base (768d), so every stored and searched vector shares one model. "minilm" (the legacy default) means that same model; any other value is ignored with a warning',
      type: 'string',
    },
  ],
  examples: [
    { command: 'monomind doc ingest ./docs', description: 'Ingest all docs in a directory' },
    {
      command: 'monomind doc ingest ~/notes --global',
      description: 'Ingest into the global brain (auto-detected for paths outside the project)',
    },
    { command: 'monomind doc ingest report.pdf', description: 'Ingest a single file' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const target = ctx.args[0] || '.';

    // --embedder is kept only so existing scripts don't break. Chunks are stored
    // through the memory bridge, which always embeds with its own model; an
    // override here never reached it (it only swapped embedding-operations'
    // model), and a different-dimension model could not share the 768d store.
    const embedder = ctx.flags.embedder as string | undefined;
    if (embedder && embedder !== 'minilm') {
      output.printWarning(
        `--embedder ${embedder} is ignored: documents are always embedded with Alibaba-NLP/gte-modernbert-base (768d).`,
      );
    }

    const { ingestDocument, ingestDirectory } = await import('../knowledge/document-pipeline.js');
    const fs = await import('node:fs');
    const resolved = path.resolve(target);

    // Zero-decision routing: an explicit --global wins; otherwise paths OUTSIDE
    // this project belong to the personal brain (a project-scoped store would
    // never surface them again from another project).
    let scope = String(ctx.flags.scope || 'shared');
    if (ctx.flags.global === true) {
      scope = 'global';
    } else if (!ctx.flags.scope) {
      // Against the PROJECT ROOT, not the cwd: from a package subdirectory,
      // `doc ingest ../../docs` targets this very project, and routing it to
      // the personal brain because it sits above the cwd is simply wrong.
      const relToCwd = path.relative(getProjectRoot(ctx.cwd || process.cwd()), resolved);
      if (relToCwd.startsWith('..') || path.isAbsolute(relToCwd)) {
        scope = 'global';
        output.writeln(
          output.dim(
            `  ${target} is outside this project — ingesting into the global brain (use --scope shared to force project scope)`,
          ),
        );
      }
    }

    const spinner = output.createSpinner({ text: 'Indexing documents...' });
    spinner.start();

    try {
      const stat = fs.statSync(resolved);

      if (stat.isDirectory()) {
        const result = await ingestDirectory(resolved, scope, {
          rootDir: getProjectRoot(ctx.cwd || process.cwd()),
          onProgress: (file, done, total) => {
            spinner.setText(`[${done + 1}/${total}] ${path.basename(file)}`);
          },
        });
        spinner.succeed(
          `Indexed ${result.totalChunks} chunks from ${result.filesProcessed} files (${result.filesSkipped} skipped)`,
        );
        if (result.errors.length) {
          output.writeln(output.dim(`  Errors: ${result.errors.length}`));
          for (const err of result.errors.slice(0, 5)) {
            output.writeln(output.dim(`    ${err}`));
          }
        }
        return { success: true, data: result };
      } else {
        const result = await ingestDocument(resolved, scope);
        if (result.skipped && !result.error) {
          spinner.succeed(
            `Already indexed: ${path.basename(resolved)} (${result.chunksIndexed} chunks)`,
          );
        } else if (result.error) {
          spinner.fail(result.error);
          return { success: false };
        } else {
          spinner.succeed(`Indexed ${result.chunksIndexed} chunks from ${path.basename(resolved)}`);
        }
        return { success: true, data: result };
      }
    } catch (err) {
      spinner.fail(String(err));
      return { success: false, exitCode: 1 };
    }
  },
};
