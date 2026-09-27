import { resolve } from 'node:path';
import { output } from '../output.js';
import type { Command, CommandContext, CommandResult } from '../types.js';
import { formatErrorWithCause } from '../utils/native-error.js';
import { walkDocs } from './monograph-shared.js';
import { printStats } from './monograph-stats.js';

// ── wiki subcommand ───────────────────────────────────────────────────────────

export const wikiCommand: Command = {
  name: 'wiki',
  description: 'Scan all docs and PDFs in the project and build a searchable knowledge graph',
  options: [
    { name: 'path', short: 'p', type: 'string', description: 'Root path (default: cwd)' },
    {
      name: 'llm',
      type: 'boolean',
      description: 'Enrich with Claude semantic extraction (uses Claude Code CLI)',
    },
    {
      name: 'llm-sections',
      type: 'number',
      description: 'Max sections for LLM enrichment (default 100)',
      default: '100',
    },
    { name: 'force', short: 'f', type: 'boolean', description: 'Force full rebuild' },
  ],
  examples: [
    {
      command: 'monomind monograph wiki',
      description: 'Build knowledge graph from all docs and PDFs',
    },
    {
      command: 'monomind monograph wiki --llm',
      description: 'Also extract semantic relationships with Claude',
    },
    {
      command: 'monomind monograph wiki --llm --llm-sections 200',
      description: 'Process 200 sections with Claude',
    },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const root = resolve((ctx.flags.path as string | undefined) ?? process.cwd());
    const force = ctx.flags.force === true;
    const llmFlag = ctx.flags.llm === true;
    const llmSections = parseInt((ctx.flags['llm-sections'] as string) || '100', 10);
    const { isClaudeCodeAvailable } = await import('../routing/llm-caller.js');
    const claudeAvailable = isClaudeCodeAvailable();
    const llmMaxSections = llmFlag && claudeAvailable ? llmSections : 0;

    if (llmFlag && !claudeAvailable) {
      output.printWarning('--llm passed but Claude Code CLI not found — LLM extraction disabled');
    }

    // Pre-scan docs
    const docs = walkDocs(root, []);
    const byExt = new Map<string, number>();
    for (const { ext } of docs) byExt.set(ext, (byExt.get(ext) ?? 0) + 1);

    output.writeln();
    output.writeln(output.bold('Monograph — Wiki & Document Knowledge Graph'));
    output.writeln(output.dim('─'.repeat(60)));
    output.writeln(`  Path : ${root}`);
    output.writeln();

    if (docs.length === 0) {
      output.printWarning('No document files found (.md .mdx .txt .rst .pdf)');
      output.writeln(output.dim(`  Searched: ${root}`));
      output.writeln(output.dim("  Make sure you're in the right directory."));
      return { success: false, exitCode: 1 };
    }

    output.writeln(output.bold(`  Discovered ${docs.length} files:`));
    for (const [ext, count] of [...byExt.entries()].sort()) {
      const label =
        ext === '.pdf'
          ? '(PDF chunks will be created)'
          : ext === '.md' || ext === '.mdx'
            ? '(headings → Section nodes)'
            : '(plain text → Section nodes)';
      output.writeln(
        `    ${output.success(ext.padEnd(6))} ${String(count).padStart(4)} files  ${output.dim(label)}`,
      );
    }

    if (llmMaxSections > 0) {
      output.writeln();
      output.writeln(
        `  ${output.success('Claude enrichment')} enabled — up to ${llmMaxSections} sections`,
      );
      output.writeln(
        output.dim('  Extracts typed semantic relationships (DESCRIBES, CAUSES, PART_OF, …)'),
      );
    } else if (!llmFlag) {
      output.writeln();
      output.writeln(
        output.dim('  Tip: add --llm to extract Claude-inferred semantic relationships'),
      );
    }
    output.writeln();

    const spinner = output.createSpinner({ text: 'Building…', spinner: 'dots' });
    spinner.start();

    const startTime = Date.now();
    const progressLines: string[] = [];

    try {
      const { buildAsync } = await import('@monoes/monograph');
      await buildAsync(root, {
        codeOnly: false,
        force,
        llmMaxSections,
        onProgress: (p: { phase: string; message?: string }) => {
          const msg = `[${p.phase}] ${p.message ?? ''}`;
          progressLines.push(msg);
          if (
            p.phase.includes('docs') ||
            p.phase.includes('pdf') ||
            p.phase.includes('contextual') ||
            p.phase.includes('llm') ||
            p.phase.includes('embed')
          ) {
            spinner.setText(msg.slice(0, 70));
          }
        },
      });

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      spinner.succeed(`Done in ${elapsed}s`);

      output.writeln();
      output.writeln(output.bold('  Knowledge graph phases:'));
      for (const line of progressLines.filter(
        (l) =>
          l.includes('docs') ||
          l.includes('pdf') ||
          l.includes('contextual') ||
          l.includes('llm') ||
          l.includes('embed') ||
          l.includes('structure'),
      )) {
        output.writeln(output.dim(`    ${line}`));
      }

      output.writeln();
      await printStats(root);

      output.writeln();
      output.writeln(output.bold('  Next steps:'));
      output.printList([
        'monomind monograph search "your query"   — search the wiki',
        'monomind monograph stats                 — full node/edge breakdown',
        'monomind monograph watch                 — rebuild on file changes',
      ]);

      return { success: true };
    } catch (err) {
      spinner.fail('Build failed');
      output.printError(formatErrorWithCause(err));
      return { success: false, exitCode: 1 };
    }
  },
};
