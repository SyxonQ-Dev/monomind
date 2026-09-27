/**
 * Monograph MCP Tools — monograph_god_nodes, monograph_augment, monograph_cypher,
 * monograph_shortest_path.
 * Extracted from query-tools.ts.
 */

import type { MCPTool } from '../types.js';
import { getProjectCwd } from '../types.js';
import { _isValidDb, getDbPath, text } from './shared.js';

// ── monograph_god_nodes ───────────────────────────────────────────────────────

export const monographGodNodesTool: MCPTool = {
  name: 'monograph_god_nodes',
  description:
    'Return the top-N most connected real code entities (excludes File/Folder/Community nodes).',
  inputSchema: {
    type: 'object',
    properties: { limit: { type: 'number', description: 'Max nodes to return (default 20)' } },
  },
  handler: async (input) => {
    const dbPath = getDbPath();
    if (!_isValidDb(dbPath))
      return text('Monograph index not built yet. Run monograph_build first.');
    const { openDb, closeDb } = await import('@monoes/monograph');
    const db = openDb(dbPath);
    try {
      // Cap limit: passed directly to the SQL LIMIT clause.
      const MAX_GOD_NODES_LIMIT = 1_000;
      const rawGodLimit = (input.limit as number | undefined) ?? 20;
      const limit =
        Number.isFinite(rawGodLimit) && rawGodLimit > 0
          ? Math.min(Math.floor(rawGodLimit), MAX_GOD_NODES_LIMIT)
          : 20;
      const excluded = ['File', 'Folder', 'Community', 'Concept'];
      const rows = db
        .prepare(`
        SELECT n.id, n.label, n.name, n.file_path, n.start_line,
               COUNT(DISTINCT e1.id) + COUNT(DISTINCT e2.id) AS degree,
               COUNT(DISTINCT e2.id) AS in_degree,
               COUNT(DISTINCT e1.id) AS out_degree
        FROM nodes n
        LEFT JOIN edges e1 ON e1.source_id = n.id
        LEFT JOIN edges e2 ON e2.target_id = n.id
        WHERE n.label NOT IN (${excluded.map(() => '?').join(',')})
        GROUP BY n.id HAVING degree > 0
        ORDER BY degree DESC LIMIT ?
      `)
        .all(...excluded, limit) as any[];

      if (rows.length === 0) return text('No god nodes found. Run monograph_build first.');
      const lines = rows.map((r) => {
        const loc = r.file_path
          ? r.start_line != null
            ? `${r.file_path}:${r.start_line}`
            : r.file_path
          : '';
        return `[${r.label}] ${r.name}  degree=${r.degree} (↑${r.out_degree} ↓${r.in_degree})  ${loc}`;
      });
      return text(lines.join('\n'));
    } finally {
      closeDb(db);
    }
  },
};

// ── monograph_augment ─────────────────────────────────────────────────────────

export const monographAugmentTool: MCPTool = {
  name: 'monograph_augment',
  description:
    'Retrieve relevant code context for a query using graph-RAG. Returns formatted context block for injection into AI prompts.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query or task description' },
      topK: { type: 'number', description: 'Number of results (default: 10)' },
      format: {
        type: 'string',
        enum: ['markdown', 'json'],
        description: 'Output format (default: markdown)',
      },
    },
    required: ['query'],
  },
  handler: async (input) => {
    const { augmentContext } = await import('@monoes/monograph');
    const repoPath = getProjectCwd();
    // Cap query (forwarded to FTS/embedding in augmentContext) and topK
    // (controls how many context nodes are retrieved).
    const MAX_AUGMENT_QUERY_LEN = 16 * 1024;
    const MAX_AUGMENT_TOP_K = 100;
    const rawAugmentQuery = input.query as string;
    const augmentQuery =
      typeof rawAugmentQuery === 'string' && rawAugmentQuery.length > MAX_AUGMENT_QUERY_LEN
        ? rawAugmentQuery.slice(0, MAX_AUGMENT_QUERY_LEN)
        : rawAugmentQuery;
    const rawTopK = (input.topK as number | undefined) ?? 10;
    const topK =
      Number.isFinite(rawTopK) && rawTopK > 0
        ? Math.min(Math.floor(rawTopK), MAX_AUGMENT_TOP_K)
        : 10;
    const result = await augmentContext({
      query: augmentQuery,
      repoPath,
      topK,
      format: (input.format as 'markdown' | 'json' | undefined) ?? 'markdown',
    });
    return text(result);
  },
};

// ── monograph_cypher ──────────────────────────────────────────────────────────

export const monographCypherTool: MCPTool = {
  name: 'monograph_cypher',
  description:
    'Execute a restricted read-only Cypher-style MATCH query against the Monograph knowledge graph. Supports node and relationship patterns. Write operations (CREATE, MERGE, SET, DELETE, REMOVE, DROP) are blocked.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'Cypher MATCH query. Example: MATCH (a:Function)-[:CALLS]->(b:Function {name: "authenticate"}) RETURN a.name, a.filePath',
      },
    },
    required: ['query'],
  },
  handler: async (input) => {
    const { openDb, closeDb } = await import('@monoes/monograph');
    const { getMonographCypher } = await import('@monoes/monograph');
    const db = openDb(getDbPath());
    try {
      // Cap query: forwarded to the Cypher query engine; very long strings
      // waste parse time and can stress the query compiler.
      const MAX_CYPHER_QUERY_LEN = 16 * 1024;
      const rawCypherQuery = input.query as string;
      const cypherQuery =
        typeof rawCypherQuery === 'string' && rawCypherQuery.length > MAX_CYPHER_QUERY_LEN
          ? rawCypherQuery.slice(0, MAX_CYPHER_QUERY_LEN)
          : rawCypherQuery;
      const result = getMonographCypher(db, cypherQuery);
      if (result.error) return text(`Error: ${result.error}`);
      if (result.rows.length === 0) return text('No results found.');
      const header = Object.keys(result.rows[0]).join('\t');
      const lines = result.rows.map((r) => Object.values(r).join('\t'));
      return text(
        [header, ...lines, `\n(${result.rows.length} rows, ${result.queryTime}ms)`].join('\n'),
      );
    } finally {
      closeDb(db);
    }
  },
};

// ── monograph_shortest_path ───────────────────────────────────────────────────

export const monographShortestPathTool: MCPTool = {
  name: 'monograph_shortest_path',
  description: 'Find the shortest path between two nodes in the dependency graph.',
  inputSchema: {
    type: 'object',
    properties: {
      source: { type: 'string', description: 'Source node ID or name' },
      target: { type: 'string', description: 'Target node ID or name' },
      maxDepth: { type: 'number', description: 'Max path depth (default 6)' },
    },
    required: ['source', 'target'],
  },
  handler: async (input) => {
    const { openDb, closeDb, getShortestPath } = await import('@monoes/monograph');
    const db = openDb(getDbPath());
    try {
      const path = getShortestPath(
        db,
        input.source as string,
        input.target as string,
        (input.maxDepth as number | undefined) ?? 6,
      );
      if (!path) return text(`No path found between ${input.source} and ${input.target}`);
      // Enrich each node ID with file:line for direct LLM navigation
      const enriched = path.map((nodeId) => {
        const row = db
          .prepare(
            'SELECT label, name, file_path, start_line FROM nodes WHERE id = ? OR name = ? LIMIT 1',
          )
          .get(nodeId, nodeId) as any;
        if (!row) return nodeId;
        const loc = row.file_path
          ? row.start_line != null
            ? `${row.file_path}:${row.start_line}`
            : row.file_path
          : '';
        return loc ? `${row.name ?? nodeId}  [${loc}]` : (row.name ?? nodeId);
      });
      return text(`Path (${path.length - 1} hops):\n${enriched.join(' → ')}`);
    } finally {
      closeDb(db);
    }
  },
};
