import { makeId } from '../../types.js';

// Split out of scope-resolution.ts (file-size sweep). Pure move: no behaviour change.

// ── Edge emission ────────────────────────────────────────────────────────────

export interface PreparedEdgeStmts {
  selectExisting: import('better-sqlite3').Statement;
  updateScore: import('better-sqlite3').Statement;
  insertNew: import('better-sqlite3').Statement;
}

export function prepareEdgeStmts(db: import('better-sqlite3').Database): PreparedEdgeStmts {
  return {
    selectExisting: db.prepare(
      `SELECT id, confidence_score FROM edges WHERE source_id = ? AND target_id = ? AND relation = 'CALLS'`,
    ),
    updateScore: db.prepare(
      `UPDATE edges SET confidence_score = ?, confidence = 'EXTRACTED' WHERE id = ?`,
    ),
    insertNew: db.prepare(
      `INSERT OR IGNORE INTO edges (id, source_id, target_id, relation, confidence, confidence_score) VALUES (?, ?, ?, 'CALLS', 'EXTRACTED', ?)`,
    ),
  };
}

export const RESOLVED_CONFIDENCE_SCORE = 0.75;

export function emitEdge(
  stmts: PreparedEdgeStmts,
  sourceId: string,
  targetId: string,
): 'inserted' | 'upgraded' | 'skipped' {
  if (sourceId === targetId) return 'skipped';

  const existing = stmts.selectExisting.get(sourceId, targetId) as
    | { id: string; confidence_score: number }
    | undefined;

  if (existing) {
    const newScore = Math.max(existing.confidence_score, RESOLVED_CONFIDENCE_SCORE);
    if (newScore > existing.confidence_score) {
      stmts.updateScore.run(newScore, existing.id);
    }
    return 'upgraded';
  }

  const edgeId = makeId(sourceId, targetId, 'calls_resolved');
  try {
    stmts.insertNew.run(edgeId, sourceId, targetId, RESOLVED_CONFIDENCE_SCORE);
    return 'inserted';
  } catch {
    return 'skipped';
  }
}
