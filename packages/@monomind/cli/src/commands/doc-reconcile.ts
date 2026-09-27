import { getProjectRoot } from '../memory/memory-bridge.js';
import { output } from '../output.js';
import type { Command, CommandContext, CommandResult } from '../types.js';

export const reconcileDocCommand: Command = {
  name: 'reconcile',
  description: 'Find and forget indexed documents whose source file no longer exists',
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
      description: 'Reconcile the personal cross-project global brain',
      type: 'boolean',
    },
    {
      name: 'apply',
      description: 'Actually forget the stale entries (default: dry run)',
      type: 'boolean',
    },
  ],
  examples: [
    {
      command: 'monomind doc reconcile',
      description: 'Show indexed documents whose file is gone (changes nothing)',
    },
    { command: 'monomind doc reconcile --apply', description: 'Forget them' },
    {
      command: 'monomind doc reconcile --global --apply',
      description: 'Same, for the personal brain',
    },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const { getKnowledgeRoot, reconcileIndex } = await import('../knowledge/document-pipeline.js');
    const isGlobal = ctx.flags.global === true;
    const scope = isGlobal ? 'global' : String(ctx.flags.scope || 'shared');
    // The scope decides the store — reconciling a `profile:<id>` scope against
    // the project's log swept a store with nothing in it and reported a clean
    // bill of health for the one that was actually asked about.
    const root = getKnowledgeRoot(scope, getProjectRoot());
    const apply = ctx.flags.apply === true;

    let report;
    try {
      report = await reconcileIndex(root, { scope, apply });
    } catch (err) {
      // reconcileIndex refuses to run against a missing root or a missing
      // metadata log, because there every indexed file looks deleted. Surface
      // that as a refusal, never as "0 stale entries found".
      output.printError(String(err instanceof Error ? err.message : err));
      return { success: false, exitCode: 1 };
    }

    if (report.missing.length === 0) {
      output.writeln(`Index is consistent — all ${report.scanned} indexed documents still exist.`);
      return { success: true, data: report };
    }

    output.writeln(
      `${output.highlight(String(report.missing.length))} of ${report.scanned} indexed documents no longer exist on disk:`,
    );
    for (const m of report.missing.slice(0, 20)) {
      output.writeln(output.dim(`  ${m.filePath}`));
    }
    if (report.missing.length > 20) {
      output.writeln(output.dim(`  ... and ${report.missing.length - 20} more`));
    }

    if (!apply) {
      // Dry run is the default because "the file is missing" also describes an
      // unmounted volume, a checked-out branch, and a partial clone. The user
      // is the one who knows which it is.
      output.writeln('');
      output.writeln(
        output.dim('Nothing was changed. Re-run with --apply to forget these entries.'),
      );
      return { success: true, data: report };
    }

    output.writeln('');
    output.writeln(
      `Forgot ${output.highlight(String(report.removed))} stale ${report.removed === 1 ? 'entry' : 'entries'}.`,
    );
    if (report.archivePath) {
      output.writeln(output.dim(`  Archived first, and reversible from: ${report.archivePath}`));
    }
    output.writeln(
      output.dim(
        '  Chunks are hidden from search immediately; storage is reclaimed on the next full re-index.',
      ),
    );
    return { success: true, data: report };
  },
};
