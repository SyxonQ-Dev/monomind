/**
 * CLI Document Command — Second Brain document management
 */

import { output } from '../output.js';
import type { Command, CommandResult } from '../types.js';
import { evalCommand } from './doc-eval.js';
import { exportDocCommand } from './doc-export.js';
import { importDocCommand } from './doc-import.js';
import { ingestCommand } from './doc-ingest.js';
import { libraryCommands } from './doc-library.js';
import { listDocCommand } from './doc-list.js';
import { reconcileDocCommand } from './doc-reconcile.js';
import { removeDocCommand } from './doc-remove.js';
import { searchDocCommand } from './doc-search.js';

export const docCommand: Command = {
  name: 'doc',
  description: 'Second Brain — document knowledge management',
  aliases: ['docs', 'knowledge'],
  subcommands: [
    ingestCommand,
    searchDocCommand,
    listDocCommand,
    ...libraryCommands,
    exportDocCommand,
    importDocCommand,
    removeDocCommand,
    reconcileDocCommand,
    evalCommand,
  ],
  options: [],
  examples: [
    { command: 'monomind doc ingest ./docs', description: 'Index documents' },
    { command: 'monomind doc search -q "auth flow"', description: 'Semantic search' },
    {
      command: 'monomind doc list --site example.com --since 7d',
      description: 'Browse the library',
    },
    {
      command: 'monomind doc cite <url> --chunk 2',
      description: 'Quote a passage with its source',
    },
    { command: 'monomind doc lookup <url> --json', description: 'Is this page already saved' },
    { command: 'monomind doc related <url> --limit 3', description: 'What relates to this page' },
    { command: 'monomind doc watch check', description: 'What changed since the last check' },
    { command: 'monomind doc export', description: 'Export as OKF bundle' },
    { command: 'monomind doc import ./bundle', description: 'Import an OKF bundle' },
    { command: 'monomind doc remove ./docs/old.md', description: 'Forget an indexed document' },
    { command: 'monomind doc eval', description: 'Score retrieval quality on the golden set' },
  ],
  action: async (): Promise<CommandResult> => {
    output.writeln();
    output.writeln(output.bold('Second Brain — Document Knowledge Management'));
    output.writeln();
    output.writeln('Usage: monomind doc <subcommand> [options]');
    output.writeln();
    output.writeln('Subcommands:');
    output.printList([
      `${output.highlight('ingest')}  - Ingest documents into the knowledge base`,
      `${output.highlight('search')}  - Semantic search over indexed documents`,
      `${output.highlight('list')}    - Browse the library: filter by site, tag, date, source (alias: library)`,
      `${output.highlight('cite')}    - Quote a passage with its URL and capture time`,
      `${output.highlight('lookup')}  - Is this URL already saved, and what was noted about it`,
      `${output.highlight('related')} - What else in the brain relates to a page`,
      `${output.highlight('watch')}   - Watch captured pages for change (add/list/remove/check)`,
      `${output.highlight('export')}  - Export as OKF bundle (markdown + frontmatter)`,
      `${output.highlight('import')}  - Import an OKF bundle produced by export`,
      `${output.highlight('remove')}  - Forget an indexed document (aliases: rm, forget)`,
      `${output.highlight('eval')}    - Retrieval-quality scoreboard: Recall@1/5/10, MRR@10`,
    ]);
    return { success: true };
  },
};

export default docCommand;
