import { getProjectRoot } from '../memory/memory-bridge.js';
import { output } from '../output.js';
import type { Command, CommandContext, CommandResult } from '../types.js';

export const evalCommand: Command = {
  name: 'eval',
  description: 'Measure retrieval quality (Recall@1/5/10, MRR@10) on the local golden set',
  aliases: ['benchmark', 'scoreboard'],
  options: [
    {
      name: 'split',
      description: 'Golden-set split: dev (tunable) | test (sealed, stop-condition only) | all',
      type: 'string',
      default: 'dev',
    },
    { name: 'k', description: 'Retrieval cutoff (default: 10)', type: 'number', default: 10 },
    { name: 'json', description: 'Emit the machine-readable report only', type: 'boolean' },
    { name: 'out', short: 'o', description: 'Write the JSON report to this path', type: 'string' },
    {
      name: 'rebuild',
      description: 'Rebuild the isolated eval store from scratch',
      type: 'boolean',
    },
    {
      name: 'screen',
      description:
        'Screen a JSON file of candidate golden pairs for lexical overlap before adding them',
      type: 'string',
    },
    {
      name: 'provision-model',
      description:
        'Download the embedding weights (the ONLY networked step; run once before evaluating)',
      type: 'boolean',
    },
    {
      name: 'store-root',
      description: 'Where the isolated eval store lives (default: <repo>/.monomind/eval)',
      type: 'string',
    },
  ],
  examples: [
    { command: 'monomind doc eval', description: 'Score the dev split and print the table' },
    {
      command: 'monomind doc eval --split test --json',
      description: 'Sealed run — aggregates only, appended to the exposure ledger',
    },
    {
      command: 'monomind doc eval --provision-model',
      description: 'One-off: fetch the embedding weights (the only networked step)',
    },
    {
      command: 'monomind doc eval --out scoreboard.json',
      description: 'Persist the machine-readable report',
    },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const { runEval, renderReport } = await import('../knowledge/eval/harness.js');

    // Authoring-time screening: reject high-overlap candidates BEFORE they
    // enter the set, rather than discovering the distribution afterwards.
    if (ctx.flags.screen) {
      const fs = await import('node:fs');
      const { screenCandidates } = await import('../knowledge/eval/harness.js');
      const cands = JSON.parse(fs.readFileSync(String(ctx.flags.screen), 'utf8'));
      const rep = await screenCandidates(getProjectRoot(ctx.cwd || process.cwd()), cands);
      if (ctx.flags.out) fs.writeFileSync(String(ctx.flags.out), JSON.stringify(rep, null, 2));
      if (ctx.flags.json === true) {
        output.writeln(JSON.stringify(rep, null, 2));
        return { success: true, data: rep };
      }
      output.writeln(
        `\nscreened ${rep.total}: ${rep.accepted} accepted, ${rep.rejected} rejected (corpus ${rep.corpusHash})`,
      );
      output.writeln(
        `overlap bands of accepted: low ${rep.bands.low}  mid ${rep.bands.mid}  high ${rep.bands.high}`,
      );
      for (const c of rep.candidates.filter((x) => !x.accepted))
        output.writeln(`  REJECT ${c.id}: ${c.reason}`);
      return { success: true, data: rep };
    }

    // The explicit, non-query-time provisioning step. Separating this from
    // measurement is what makes "clean checkout" and "zero network at query
    // time" jointly satisfiable — `doc eval` itself never fetches.
    if (ctx.flags['provision-model'] === true) {
      const { provisionModel } = await import('../knowledge/eval/model-presence.js');
      try {
        const p = await provisionModel((m) => output.writeln(output.dim(`  ${m}`)));
        output.printSuccess(`Models provisioned (embedding: ${(p.bytes / 1e6).toFixed(0)}MB).`);
        return { success: true, data: p };
      } catch (err) {
        output.printError(String(err instanceof Error ? err.message : err));
        return { success: false, exitCode: 1 };
      }
    }

    const split = String(ctx.flags.split || 'dev');
    if (!['dev', 'test', 'all'].includes(split)) {
      output.printError(`--split must be dev, test or all (got "${split}")`);
      return { success: false, exitCode: 1 };
    }
    const asJson = ctx.flags.json === true;
    const repoRoot = getProjectRoot(ctx.cwd || process.cwd());

    try {
      const report = await runEval({
        repoRoot,
        k: Number(ctx.flags.k || 10),
        rebuild: ctx.flags.rebuild === true,
        storeRoot: ctx.flags['store-root'] ? String(ctx.flags['store-root']) : undefined,
        split: split as 'dev' | 'test' | 'all',
        onProgress: (msg) => {
          if (!asJson) output.writeln(output.dim(`  ${msg}`));
        },
      });

      if (ctx.flags.out) {
        const fs = await import('node:fs');
        fs.writeFileSync(String(ctx.flags.out), JSON.stringify(report, null, 2));
      }
      if (asJson) output.writeln(JSON.stringify(report, null, 2));
      else output.writeln(renderReport(report));

      // A network attempt during the query phase invalidates the run outright.
      return { success: report.networkFree.verdict === 'proven-blocked', data: report };
    } catch (err) {
      output.printError(String(err instanceof Error ? err.message : err));
      return { success: false, exitCode: 1 };
    }
  },
};
