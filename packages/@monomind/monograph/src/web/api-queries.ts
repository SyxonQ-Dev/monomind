import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { type IndexScope, readIndexScope } from '../pipeline/index-scope.js';
import { ftsSearch } from '../storage/fts-store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'));
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ApiNode {
  id: string;
  name: string;
  label: string;
  filePath: string | null;
  startLine: number | null;
  endLine: number | null;
  communityId: number | null;
}

export interface ApiEdge {
  sourceId: string;
  targetId: string;
  relation: string;
  confidenceScore: number;
}

export interface GraphData {
  nodes: ApiNode[];
  edges: ApiEdge[];
  communities: Record<string, string[]>;
  totalNodeCount: number;
  totalEdgeCount: number;
  truncated: boolean;
}

export interface NodeDetail {
  node: ApiNode | null;
  callers: ApiNode[];
  callees: ApiNode[];
}

export interface StatsData {
  nodeCount: number;
  edgeCount: number;
  communityCount: number;
  buildAt: string | null;
  /** Source-selection domain the index was built with; null for indexes built before it was recorded. */
  scope: IndexScope | null;
}

// ── Query helpers (testable in isolation) ─────────────────────────────────────

export function rowToApiNode(row: Record<string, unknown>): ApiNode {
  return {
    id: row.id as string,
    name: row.name as string,
    label: row.label as string,
    filePath: (row.file_path as string | null) ?? null,
    startLine: (row.start_line as number | null) ?? null,
    endLine: (row.end_line as number | null) ?? null,
    communityId: (row.community_id as number | null) ?? null,
  };
}

export function queryGraphData(db: Database.Database): GraphData {
  const totalNodeCount = (db.prepare('SELECT COUNT(*) as c FROM nodes').get() as { c: number }).c;
  const totalEdgeCount = (db.prepare('SELECT COUNT(*) as c FROM edges').get() as { c: number }).c;

  // Select the most connected nodes for a representative visualization
  const nodeRows = db
    .prepare(
      `SELECT n.id, n.name, n.label, n.file_path, n.start_line, n.end_line, n.community_id
       FROM nodes n
       LEFT JOIN (
         SELECT node_id, SUM(cnt) AS deg FROM (
           SELECT source_id AS node_id, COUNT(*) AS cnt FROM edges GROUP BY source_id
           UNION ALL
           SELECT target_id AS node_id, COUNT(*) AS cnt FROM edges GROUP BY target_id
         ) GROUP BY node_id
       ) d ON d.node_id = n.id
       ORDER BY d.deg DESC NULLS LAST
       LIMIT 2000`,
    )
    .all() as Record<string, unknown>[];

  const nodes = nodeRows.map(rowToApiNode);
  const nodeIds = new Set(nodes.map((n) => n.id));

  const edges: ApiEdge[] = [];
  if (nodeIds.size > 0) {
    // Use a temp table so SQLite filters edges instead of scanning full table in JS
    db.exec('CREATE TEMP TABLE IF NOT EXISTS _vis_nodes (id TEXT PRIMARY KEY)');
    db.exec('DELETE FROM _vis_nodes');
    const insertVis = db.prepare('INSERT OR IGNORE INTO _vis_nodes (id) VALUES (?)');
    const insertAll = db.transaction((ids: string[]) => {
      for (const id of ids) insertVis.run(id);
    });
    insertAll([...nodeIds]);

    const edgeRows = db
      .prepare(`SELECT e.source_id, e.target_id, e.relation, e.confidence_score FROM edges e
        JOIN _vis_nodes s ON e.source_id = s.id
        JOIN _vis_nodes t ON e.target_id = t.id
        LIMIT 10000`)
      .all() as Record<string, unknown>[];

    for (const r of edgeRows) {
      edges.push({
        sourceId: r.source_id as string,
        targetId: r.target_id as string,
        relation: r.relation as string,
        confidenceScore: r.confidence_score as number,
      });
    }
  }

  const communities: Record<string, string[]> = {};
  for (const node of nodes) {
    if (node.communityId != null) {
      const key = String(node.communityId);
      if (!communities[key]) communities[key] = [];
      communities[key].push(node.id);
    }
  }

  return {
    nodes,
    edges,
    communities,
    totalNodeCount,
    totalEdgeCount,
    truncated: totalNodeCount > nodes.length,
  };
}

export function queryNode(db: Database.Database, id: string): NodeDetail {
  const nodeRow = db
    .prepare(
      'SELECT id, name, label, file_path, start_line, end_line, community_id FROM nodes WHERE id = ?',
    )
    .get(id) as Record<string, unknown> | undefined;

  if (!nodeRow) return { node: null, callers: [], callees: [] };

  const node = rowToApiNode(nodeRow);

  const callerRows = db
    .prepare(
      `SELECT n.id, n.name, n.label, n.file_path, n.start_line, n.end_line, n.community_id
       FROM nodes n JOIN edges e ON n.id = e.source_id
       WHERE e.target_id = ? AND e.relation = 'CALLS' LIMIT 20`,
    )
    .all(id) as Record<string, unknown>[];

  const calleeRows = db
    .prepare(
      `SELECT n.id, n.name, n.label, n.file_path, n.start_line, n.end_line, n.community_id
       FROM nodes n JOIN edges e ON n.id = e.target_id
       WHERE e.source_id = ? AND e.relation = 'CALLS' LIMIT 20`,
    )
    .all(id) as Record<string, unknown>[];

  return {
    node,
    callers: callerRows.map(rowToApiNode),
    callees: calleeRows.map(rowToApiNode),
  };
}

export function querySearch(db: Database.Database, q: string): ApiNode[] {
  const results = ftsSearch(db, q, 10);
  return results.map((r) => ({
    id: r.id,
    name: r.name,
    label: r.label,
    filePath: r.filePath,
    startLine: r.startLine ?? null,
    endLine: r.endLine ?? null,
    communityId: null,
  }));
}

export function queryStats(db: Database.Database): StatsData {
  const nodeCount = (db.prepare('SELECT COUNT(*) as c FROM nodes').get() as { c: number }).c;
  const edgeCount = (db.prepare('SELECT COUNT(*) as c FROM edges').get() as { c: number }).c;
  const communityCount = (
    db
      .prepare('SELECT COUNT(DISTINCT community_id) as c FROM nodes WHERE community_id IS NOT NULL')
      .get() as { c: number }
  ).c;
  const metaRow = db.prepare("SELECT value FROM index_meta WHERE key = 'indexed_at'").get() as
    | { value: string }
    | undefined;

  return {
    nodeCount,
    edgeCount,
    communityCount,
    buildAt: metaRow?.value ?? null,
    scope: readIndexScope(db),
  };
}

export interface GrepResult {
  id: string;
  name: string;
  label: string;
  filePath: string | null;
  startLine: number | null;
}

export function queryGrep(
  db: Database.Database,
  pattern: string,
  caseSensitive: boolean,
): GrepResult[] {
  const sql = caseSensitive
    ? `SELECT id, name, label, file_path, start_line FROM nodes WHERE name GLOB ? LIMIT 100`
    : `SELECT id, name, label, file_path, start_line FROM nodes WHERE name LIKE ? LIMIT 100`;
  const param = caseSensitive ? `*${pattern}*` : `%${pattern}%`;
  const rows = db.prepare(sql).all(param) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: r.id as string,
    name: r.name as string,
    label: r.label as string,
    filePath: (r.file_path as string | null) ?? null,
    startLine: (r.start_line as number | null) ?? null,
  }));
}

export interface FileLine {
  number: number;
  content: string;
}

export interface FileContent {
  path: string;
  totalLines: number;
  lines: FileLine[];
}

export function readFileContent(
  filePath: string,
  startLine?: number,
  endLine?: number,
): FileContent {
  const raw = readFileSync(filePath, 'utf8');
  const allLines = raw.split('\n');
  // Remove trailing empty line from split
  if (allLines.length > 0 && allLines[allLines.length - 1] === '') allLines.pop();

  const start = startLine ?? 1;
  const end = endLine ?? allLines.length;

  const lines: FileLine[] = [];
  for (let i = start - 1; i < end && i < allLines.length; i++) {
    lines.push({ number: i + 1, content: allLines[i]! });
  }

  return { path: filePath, totalLines: allLines.length, lines };
}

// ── Cluster / community queries ───────────────────────────────────────────────

export interface ClusterSummary {
  id: number;
  label: string | null;
  memberCount: number;
}

export interface ClusterDetail {
  id: number;
  label: string | null;
  members: unknown[];
}

export function queryClusters(db: Database.Database): ClusterSummary[] {
  try {
    const rows = db
      .prepare(
        `SELECT c.id, c.label, COUNT(n.id) as memberCount
       FROM communities c LEFT JOIN nodes n ON n.community_id = c.id
       GROUP BY c.id ORDER BY memberCount DESC`,
      )
      .all() as { id: number; label: string | null; memberCount: number }[];
    return rows;
  } catch {
    const rows = db
      .prepare(
        `SELECT community_id as id, COUNT(*) as memberCount FROM nodes WHERE community_id IS NOT NULL GROUP BY community_id ORDER BY memberCount DESC`,
      )
      .all() as { id: number; memberCount: number }[];
    return rows.map((r) => ({ id: r.id, label: null, memberCount: r.memberCount }));
  }
}

export function queryCluster(db: Database.Database, name: string): ClusterDetail | null {
  try {
    const comm = db
      .prepare('SELECT id, label FROM communities WHERE label = ? LIMIT 1')
      .get(name) as { id: number; label: string } | undefined;
    if (!comm) return null;
    const members = db
      .prepare(
        'SELECT id, name, label, file_path, start_line, end_line, community_id FROM nodes WHERE community_id = ? LIMIT 200',
      )
      .all(comm.id) as Record<string, unknown>[];
    return { id: comm.id, label: comm.label, members: members.map(rowToApiNode) };
  } catch (err) {
    const msg = String(err);
    if (!msg.includes('no such table')) throw err;
    return null;
  }
}

// ── Process queries ───────────────────────────────────────────────────────────

export interface ProcessSummary {
  id: string;
  name: string;
  filePath: string | null;
}

export function queryProcessesList(db: Database.Database): ProcessSummary[] {
  const rows = db
    .prepare(`SELECT id, name, file_path FROM nodes WHERE label = 'Process' LIMIT 200`)
    .all() as { id: string; name: string; file_path: string | null }[];
  return rows.map((r) => ({ id: r.id, name: r.name, filePath: r.file_path }));
}

export function queryProcess(db: Database.Database, name: string): Record<string, unknown> | null {
  const row = db
    .prepare(
      `SELECT id, name, label, file_path, start_line, end_line, community_id FROM nodes WHERE label = 'Process' AND name = ? LIMIT 1`,
    )
    .get(name) as Record<string, unknown> | undefined;
  return row ?? null;
}

// ── Server info ───────────────────────────────────────────────────────────────

export interface ServerInfo {
  name: string;
  version: string;
  nodeVersion: string;
  uptimeSeconds: number;
}

export function getServerInfo(): ServerInfo {
  return {
    name: 'monograph',
    version: PKG_VERSION,
    nodeVersion: process.version,
    uptimeSeconds: process.uptime(),
  };
}

// ── Streaming graph export ────────────────────────────────────────────────────

export async function streamGraph(
  db: Database.Database,
  onRecord: (record: unknown) => void,
): Promise<void> {
  const nodeRows = db
    .prepare('SELECT id, name, label, file_path, start_line, end_line, community_id FROM nodes')
    .all() as Record<string, unknown>[];
  for (const row of nodeRows) {
    onRecord({ type: 'node', ...rowToApiNode(row) });
  }
  const edgeRows = db
    .prepare('SELECT source_id, target_id, relation, confidence_score FROM edges')
    .all() as Record<string, unknown>[];
  for (const row of edgeRows) {
    onRecord({
      type: 'edge',
      sourceId: row.source_id,
      targetId: row.target_id,
      relation: row.relation,
      confidenceScore: row.confidence_score,
    });
  }
}
