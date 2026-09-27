import * as path from 'node:path';
import { getProjectRoot } from '../memory/memory-bridge.js';
import { output } from '../output.js';
import type { Command, CommandContext, CommandResult } from '../types.js';

export const removeDocCommand: Command = {
  name: 'remove',
  description: 'Forget an indexed document',
  aliases: ['rm', 'forget'],
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
      description: 'Remove from the personal cross-project global brain',
      type: 'boolean',
    },
  ],
  examples: [
    {
      command: 'monomind doc remove ./docs/old-spec.md',
      description: 'Stop returning a document in search',
    },
    {
      command: 'monomind doc remove ~/notes/stale.md --global',
      description: 'Forget it from the personal brain',
    },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const target = ctx.args[0];
    if (!target) {
      output.printError('Document path required: monomind doc remove <path>');
      return { success: false, exitCode: 1 };
    }

    const { getKnowledgeRoot, listDocuments, removeDocument } = await import(
      '../knowledge/document-pipeline.js'
    );
    const isGlobal = ctx.flags.global === true;
    const scope = isGlobal ? 'global' : String(ctx.flags.scope || 'shared');
    // The scope decides the store: a `profile:<id>` document is in that
    // profile's brain, and looking for it in the project's log reported a
    // document that is plainly indexed as "not indexed".
    const root = getKnowledgeRoot(scope, getProjectRoot());
    const resolved = path.resolve(target);

    // The metadata log keys on the resolved path recorded at ingest, so a
    // mistyped path would otherwise write a tombstone that matches nothing and
    // report success. Fail like `rm` does instead.
    if (!listDocuments(root, scope).some((d) => path.resolve(d.filePath) === resolved)) {
      output.printError(`Not indexed under scope '${scope}': ${resolved}`);
      output.writeln(
        output.dim(`  See what is indexed: monomind doc list${isGlobal ? ' --global' : ''}`),
      );
      return { success: false, exitCode: 1 };
    }

    await removeDocument(resolved, scope, root);
    output.writeln(`Forgot ${output.highlight(path.basename(resolved))} (${scope})`);
    // Honest about what happened on disk: the tombstone hides the chunks from
    // every search surface, but the bridge exposes no delete-by-prefix, so the
    // rows themselves go on the next full re-index.
    output.writeln(
      output.dim(
        '  Chunks are hidden from search immediately; storage is reclaimed on the next full re-index.',
      ),
    );
    return { success: true, data: { filePath: resolved, scope } };
  },
};
