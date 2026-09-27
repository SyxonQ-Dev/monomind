import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { output } from '../output.js';
import type { Command, CommandContext, CommandResult } from '../types.js';
import { formatErrorWithCause } from '../utils/native-error.js';
import { getDbPath } from './monograph-shared.js';

// ── lsp subcommand ───────────────────────────────────────────────────────────

export const lspCommand: Command = {
  name: 'lsp',
  description: 'Start the Monograph LSP server over stdio (for editor integration)',
  options: [{ name: 'path', short: 'p', type: 'string', description: 'Root path (default: cwd)' }],
  examples: [
    { command: 'monomind monograph lsp', description: 'Start LSP server for current project' },
    {
      command: 'monomind monograph lsp -p /path/to/project',
      description: 'Start LSP server for a specific project',
    },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const root = resolve((ctx.flags.path as string | undefined) ?? process.cwd());
    const dbPath = getDbPath(root);

    if (!existsSync(dbPath)) {
      output.printError('No monograph database found. Run `monomind monograph build` first.');
      return { success: false, exitCode: 1 };
    }

    try {
      const { openDb } = await import('@monoes/monograph');
      const { startLspServer } = await import('@monoes/monograph/lsp');
      const db = openDb(dbPath);
      startLspServer(db, root);
      // startLspServer blocks on stdin until the editor disconnects
      return { success: true };
    } catch (err) {
      output.printError(formatErrorWithCause(err));
      return { success: false, exitCode: 1 };
    }
  },
};
