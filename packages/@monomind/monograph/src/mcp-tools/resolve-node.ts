import type Database from 'better-sqlite3';
import { isTestPath } from '../health/hotspot-utils.js';

/** A node a name could have referred to — enough to re-query unambiguously. */
export interface SymbolCandidate {
  id: string;
  name: string;
  label: string;
  filePath: string | null;
  startLine: number | null;
}

export interface NodeResolution {
  /** The single node the name resolved to, if it resolved to exactly one. */
  row?: Record<string, unknown>;
  /** Populated when the name matched several nodes — non-test definitions first. */
  candidates: SymbolCandidate[];
}

/** Candidate lists exist to be read by a human or an agent; a long one is noise. */
export const CANDIDATE_CAP = 25;
/** Rows fetched before ranking, so non-test definitions are not cut off by the cap. */
const CANDIDATE_SCAN = 500;

export function toCandidate(row: Record<string, unknown>): SymbolCandidate {
  return {
    id: row.id as string,
    name: row.name as string,
    label: row.label as string,
    filePath: (row.file_path as string | null) ?? null,
    startLine: (row.start_line as number | null) ?? null,
  };
}

/** Exact path match, else a trailing-fragment match so `user.ts` narrows `/app/user.ts`. */
export function matchesFilePath(row: Record<string, unknown>, filePath: string): boolean {
  const rowPath = (row.file_path as string | null) ?? '';
  return rowPath === filePath || rowPath.endsWith(filePath);
}

const isTestRow = (row: Record<string, unknown>): boolean =>
  isTestPath((row.file_path as string | null) ?? '');

/**
 * Resolve a symbol name (optionally narrowed by file path) to one node. When
 * several nodes still match, nothing is picked: a confident answer about the
 * wrong definition (say, a test mock) is worse than asking which one was meant.
 */
export function resolveNodeByName(
  db: Database.Database,
  name: string,
  filePath?: string,
): NodeResolution {
  const rows = db
    .prepare('SELECT * FROM nodes WHERE name = ? LIMIT ?')
    .all(name, CANDIDATE_SCAN) as Record<string, unknown>[];
  let matches = rows;
  if (filePath) {
    const exact = rows.filter((r) => r.file_path === filePath);
    matches = exact.length > 0 ? exact : rows.filter((r) => matchesFilePath(r, filePath));
  }

  if (matches.length === 0) return { candidates: [] };
  if (matches.length === 1) return { row: matches[0], candidates: [] };

  const ranked = [...matches.filter((r) => !isTestRow(r)), ...matches.filter(isTestRow)];
  return { candidates: ranked.slice(0, CANDIDATE_CAP).map(toCandidate) };
}
