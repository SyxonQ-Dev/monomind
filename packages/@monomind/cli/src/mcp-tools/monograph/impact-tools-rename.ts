import type { MonographRenameResult } from '@monoes/monograph';
import type { MCPTool } from '../types.js';
import { nodeLocation, textWithData } from './impact-tools-shared.js';
import { getDbPath, text } from './shared.js';

// ── monograph_rename ──────────────────────────────────────────────────────────

// ── monograph_rename ──────────────────────────────────────────────────────────

export const monographRenameTool: MCPTool = {
  name: 'monograph_rename',
  description:
    'Dry-run multi-file rename: finds all references to a symbol and shows before/after diffs without writing files.',
  inputSchema: {
    type: 'object',
    properties: {
      oldName: { type: 'string', description: 'Current symbol name' },
      newName: { type: 'string', description: 'New symbol name' },
      filePath: { type: 'string', description: 'Optional file path to disambiguate the symbol' },
      dryRun: {
        type: 'boolean',
        description: 'Always true — files are never modified (default: true)',
      },
    },
    required: ['oldName', 'newName'],
  },
  handler: async (input) => {
    const { openDb, closeDb } = await import('@monoes/monograph');
    const { getMonographRename } = await import('@monoes/monograph');
    const db = openDb(getDbPath());
    try {
      const oldName = input.oldName as string;
      const newName = input.newName as string;
      const result: MonographRenameResult = getMonographRename(db, {
        oldName,
        newName,
        filePath: input.filePath as string | undefined,
        dryRun: (input.dryRun as boolean | undefined) ?? true,
      });

      if (result.error) {
        return textWithData(
          `Rename failed: ${result.error}`,
          { ...result, oldName, newName },
          true,
        );
      }
      const symbol = result.symbol;
      if (!symbol) {
        return textWithData(`Symbol not found: ${oldName}`, { ...result, oldName, newName });
      }

      // The library returns `changes` (file/line/before/after) — not
      // `occurrences` or `references`. Reading either of those names yielded a
      // permanent "Occurrences: 0" no matter how many changes were found.
      const MAX_LISTED_CHANGES = 30;
      const MAX_RENDERED_LINE = 200;
      const shown = result.changes.slice(0, MAX_LISTED_CHANGES);
      const clip = (s: string) =>
        s.length > MAX_RENDERED_LINE ? `${s.slice(0, MAX_RENDERED_LINE)}…` : s;

      const lines: string[] = [
        `Rename: ${oldName} → ${newName}  (dry-run, no files written)`,
        `Symbol: [${symbol.label}] ${symbol.name}  ${nodeLocation(symbol)}`,
        `Changes: ${result.changes.length} across ${result.referencingFiles.length} files`,
        '',
      ];
      for (const change of shown) {
        lines.push(`  ${change.file}:${change.line}`);
        lines.push(`    - ${clip(change.before)}`);
        lines.push(`    + ${clip(change.after)}`);
      }
      if (result.changes.length > shown.length) {
        lines.push(`  … ${result.changes.length - shown.length} more`);
      }

      return textWithData(lines.join('\n').trim(), {
        oldName,
        newName,
        dryRun: true,
        symbol: {
          id: symbol.id,
          name: symbol.name,
          label: symbol.label,
          filePath: symbol.filePath ?? null,
          startLine: symbol.startLine ?? null,
        },
        referencingFiles: result.referencingFiles,
        changeCount: result.changes.length,
        changes: result.changes,
        truncated: {
          changesListedInText: shown.length,
          changesOmittedFromText: result.changes.length - shown.length,
        },
      });
    } finally {
      closeDb(db);
    }
  },
};

// ── monograph_tool_map ────────────────────────────────────────────────────────

// ── monograph_tool_map ────────────────────────────────────────────────────────

export const monographToolMapTool: MCPTool = {
  name: 'monograph_tool_map',
  description:
    'List MCP/RPC tool definitions in the knowledge graph with handler associations. Shows which functions handle each tool.',
  inputSchema: {
    type: 'object',
    properties: {
      tool: { type: 'string', description: 'Filter by tool name substring' },
    },
  },
  handler: async (input) => {
    const { openDb, closeDb } = await import('@monoes/monograph');
    const { getToolMap } = await import('@monoes/monograph');
    const db = openDb(getDbPath());
    try {
      const results = getToolMap(db, { tool: input.tool as string | undefined });
      if (results.length === 0) return text('No tools found. Run monograph_build first.');
      const lines = results.map((r) => {
        const loc = r.handlerFile
          ? r.handlerLine != null
            ? `${r.handlerFile}:${r.handlerLine}`
            : r.handlerFile
          : (r.filePath ?? '');
        return `${r.name}${r.handlerName ? ` → ${r.handlerName}` : ''}${loc ? `  (${loc})` : ''}`;
      });
      return text(`Tools (${results.length}):\n${lines.join('\n')}`);
    } finally {
      closeDb(db);
    }
  },
};
