import type { PipelineContext } from '../types.js';

// Split out of scope-resolution.ts (file-size sweep). Pure move: no behaviour change.

// ── Function index ───────────────────────────────────────────────────────────

export function buildFunctionIndex(ctx: PipelineContext): {
  byFilePath: Map<string, Map<string, string[]>>;
  nameCounts: Map<string, number>;
} {
  const byFilePath = new Map<string, Map<string, string[]>>();
  const nameCounts = new Map<string, number>();

  if (!ctx.db) return { byFilePath, nameCounts };

  const rows = ctx.db
    .prepare(
      `SELECT id, name, file_path FROM nodes WHERE label IN ('Function', 'Method', 'Constructor', 'Class') AND file_path IS NOT NULL`,
    )
    .all() as { id: string; name: string; file_path: string }[];

  for (const row of rows) {
    let fileMap = byFilePath.get(row.file_path);
    if (!fileMap) {
      fileMap = new Map();
      byFilePath.set(row.file_path, fileMap);
    }
    let ids = fileMap.get(row.name);
    if (!ids) {
      ids = [];
      fileMap.set(row.name, ids);
    }
    ids.push(row.id);
    nameCounts.set(row.name, (nameCounts.get(row.name) ?? 0) + 1);
  }

  return { byFilePath, nameCounts };
}

/** A callable node with a known line range, used to attribute a call to its caller. */
export interface EnclosingSymbol {
  id: string;
  startLine: number;
  endLine: number;
}

/**
 * Line ranges of every callable, grouped by file, innermost-first.
 *
 * Call edges are attributed to the enclosing function rather than the file.
 * Attributing them to the file makes a function appear "used" by its own file
 * purely because it is declared there, which silently disabled dead-export
 * detection: `detectDeadCodeNodes` rejects any candidate with an inbound CALLS
 * edge, and that self-edge always existed.
 */
export function buildEnclosingIndex(ctx: PipelineContext): Map<string, EnclosingSymbol[]> {
  const byFile = new Map<string, EnclosingSymbol[]>();
  if (!ctx.db) return byFile;

  const rows = ctx.db
    .prepare(
      `SELECT id, file_path, start_line, end_line FROM nodes
        WHERE label IN ('Function', 'Method', 'Constructor')
          AND file_path IS NOT NULL AND start_line IS NOT NULL AND end_line IS NOT NULL`,
    )
    .all() as { id: string; file_path: string; start_line: number; end_line: number }[];

  for (const row of rows) {
    let list = byFile.get(row.file_path);
    if (!list) {
      list = [];
      byFile.set(row.file_path, list);
    }
    list.push({ id: row.id, startLine: row.start_line, endLine: row.end_line });
  }

  // Narrowest range first, so the first containing match is the innermost
  // scope — a call inside a closure belongs to the closure, not the function
  // that happens to wrap it.
  for (const list of byFile.values()) {
    list.sort((a, b) => a.endLine - a.startLine - (b.endLine - b.startLine));
  }

  return byFile;
}

/** Line-start offsets, for turning a match offset into a 1-based line number. */
export function buildLineOffsets(source: string): number[] {
  const offsets = [0];
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10) offsets.push(i + 1);
  }
  return offsets;
}

export function lineAtOffset(lineOffsets: number[], offset: number): number {
  let lo = 0,
    hi = lineOffsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineOffsets[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/**
 * The innermost callable containing `offset`, or null when the call sits at
 * module top level — which is genuinely file-scoped, so the file node stays
 * the correct source for those.
 */
export function findEnclosingSymbolId(
  enclosing: EnclosingSymbol[] | undefined,
  lineOffsets: number[],
  offset: number | undefined,
): string | null {
  if (!enclosing || enclosing.length === 0 || offset === undefined) return null;
  const line = lineAtOffset(lineOffsets, offset);
  for (const sym of enclosing) {
    if (line >= sym.startLine && line <= sym.endLine) return sym.id;
  }
  return null;
}
