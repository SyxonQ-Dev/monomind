import fs from 'node:fs';
import path from 'node:path';

// Monograph dashboard routes (extracted from routes-monograph.mjs).
// Registered, in order, by handleMonographRoutes in routes-monograph.mjs.
export async function handleMonographHtmlRoutes(req, res, url, corsOrigin, ctx) {
  // ------------------------------------------------------- GET /api/monograph-html
  if (req.method === 'GET' && url === '/api/monograph-html') {
    try {
      const qs = new URL(req.url, 'http://localhost').searchParams;
      const dir = qs.get('dir') || ctx.projectDir || process.cwd();
      const d = path.resolve(dir || process.cwd());
      const dbPath = path.join(d, '.monomind', 'monograph.db');

      // Generate HTML on-the-fly from SQLite DB
      if (fs.existsSync(dbPath)) {
        let html;
        try {
          // Try better-sqlite3 first (fast, in-process)
          const { openDb, closeDb } = await import(
            new URL('../../../../monograph/dist/src/storage/db.js', import.meta.url).href
          );
          const { toHtml } = await import(
            new URL('../../../../monograph/dist/src/export/html.js', import.meta.url).href
          );
          const db = openDb(dbPath);
          try {
            const rawNodes = db.prepare('SELECT * FROM nodes LIMIT 5000').all();
            const rawEdges = db.prepare('SELECT * FROM edges').all();
            const parsedNodes = rawNodes.map((n) => ({
              id: n.id,
              label: n.label,
              name: n.name,
              normLabel: n.norm_label,
              filePath: n.file_path,
              startLine: n.start_line,
              endLine: n.end_line,
              communityId: n.community_id,
              isExported: !!n.is_exported,
              language: n.language,
              properties: n.properties ? JSON.parse(n.properties) : {},
            }));
            const parsedEdges = rawEdges.map((e) => ({
              id: e.id,
              sourceId: e.source_id,
              targetId: e.target_id,
              relation: e.relation,
              confidence: e.confidence,
              confidenceScore: e.confidence_score,
              weight: e.weight,
            }));
            html = toHtml(parsedNodes, parsedEdges);
          } finally {
            closeDb(db);
          }
        } catch {
          // Fallback: sqlite3 CLI + inline Sigma.js graph
          const { execFileSync } = await import('node:child_process');
          const runSql = (sql) => {
            try {
              return JSON.parse(
                execFileSync('sqlite3', ['-json', dbPath], {
                  encoding: 'utf-8',
                  timeout: 15000,
                  maxBuffer: 50 * 1024 * 1024,
                  input: `${sql};`,
                }) || '[]',
              );
            } catch {
              return [];
            }
          };
          const rawNodes = runSql(
            'SELECT id, name, label, file_path, community_id FROM nodes LIMIT 2000',
          );
          const rawEdges = runSql('SELECT source_id, target_id, relation FROM edges');
          const degree = new Map();
          for (const n of rawNodes) degree.set(n.id, 0);
          for (const e of rawEdges) {
            if (degree.has(e.source_id))
              degree.set(e.source_id, (degree.get(e.source_id) || 0) + 1);
            if (degree.has(e.target_id))
              degree.set(e.target_id, (degree.get(e.target_id) || 0) + 1);
          }
          const topNodes = [...rawNodes]
            .sort((a, b) => (degree.get(b.id) || 0) - (degree.get(a.id) || 0))
            .slice(0, 500);
          const topIds = new Set(topNodes.map((n) => n.id));
          const filteredEdges = rawEdges
            .filter((e) => topIds.has(e.source_id) && topIds.has(e.target_id))
            .slice(0, 2000);
          const colors = [
            '#4E79A7',
            '#F28E2B',
            '#E15759',
            '#76B7B2',
            '#59A14F',
            '#EDC948',
            '#B07AA1',
            '#FF9DA7',
            '#9C755F',
            '#BAB0AC',
          ];
          const nodesJson = JSON.stringify(
            topNodes.map((n, i) => {
              const d = degree.get(n.id) || 1;
              const c =
                n.community_id != null
                  ? colors[n.community_id % colors.length]
                  : colors[i % colors.length];
              return {
                id: n.id,
                label: n.name || n.id,
                x: Math.cos(i * 0.618 * Math.PI * 2) * 300 + Math.random() * 50,
                y: Math.sin(i * 0.618 * Math.PI * 2) * 300 + Math.random() * 50,
                size: Math.min(3 + Math.sqrt(d) * 2, 20),
                color: c,
              };
            }),
          );
          const edgesJson = JSON.stringify(
            filteredEdges.map((e, i) => ({
              id: `e${i}`,
              source: e.source_id,
              target: e.target_id,
            })),
          );
          html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Monograph</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/sigma.js/2.4.0/sigma.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/graphology/0.25.4/graphology.umd.min.js"></script>
<style>*{margin:0;padding:0}body{background:#0f0f1a;overflow:hidden}#g{width:100vw;height:100vh}</style></head>
<body><div id="g"></div><script>
const g=new graphology.Graph();
${nodesJson}.forEach(n=>g.addNode(n.id,{label:n.label,x:n.x,y:n.y,size:n.size,color:n.color}));
${edgesJson}.forEach(e=>{try{g.addEdge(e.source,e.target,{size:0.5,color:'#333'})}catch{}});
new Sigma(g,document.getElementById('g'),{renderEdgeLabels:false,labelColor:{color:'#ccc'},labelSize:10});
</script></body></html>`;
        }
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          ...(corsOrigin ? { 'Access-Control-Allow-Origin': corsOrigin } : {}),
          'Cache-Control': 'no-cache',
        });
        res.end(html);
        return true;
      }

      // Fallback: try legacy graph.html on disk
      const htmlPath = path.join(d, '.monomind', 'graph', 'graph.html');
      const html = fs.readFileSync(htmlPath, 'utf-8');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        ...(corsOrigin ? { 'Access-Control-Allow-Origin': corsOrigin } : {}),
        'Cache-Control': 'no-cache',
      });
      res.end(html);
    } catch (_err) {
      res.writeHead(404, { 'Content-Type': 'text/html' });
      res.end(
        '<html><body style="background:#0f0f1a;color:#888;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;"><div style="text-align:center;"><h3 style="color:#4E79A7;">No Graph Built Yet</h3><p>Run <code style="color:#00E5C8;">mcp__monomind__monograph_build</code> or click BUILD in the sidebar.</p></div></body></html>',
      );
    }
    return true;
  }

  // ------------------------------------------------------- GET /api/monograph-report
  if (req.method === 'GET' && url === '/api/monograph-report') {
    try {
      const qs = new URL(req.url, 'http://localhost').searchParams;
      const dir = qs.get('dir') || ctx.projectDir || process.cwd();
      const d = path.resolve(dir || process.cwd());
      const dbPath = path.join(d, '.monomind', 'monograph.db');
      let report = null,
        exists = false,
        stats = null;
      if (fs.existsSync(dbPath)) {
        exists = true;
        const { openDb, closeDb } = await import(
          new URL('../../../../monograph/dist/src/storage/db.js', import.meta.url).href
        );
        const db = openDb(dbPath);
        try {
          const nodeCount = db.prepare('SELECT COUNT(*) AS c FROM nodes').get().c;
          const edgeCount = db.prepare('SELECT COUNT(*) AS c FROM edges').get().c;
          const topNodes = db
            .prepare(
              `SELECT n.id, n.name, n.label, (SELECT COUNT(*) FROM edges e WHERE e.source_id=n.id OR e.target_id=n.id) AS deg FROM nodes n ORDER BY deg DESC LIMIT 20`,
            )
            .all();
          const labelDist = db
            .prepare(
              'SELECT label, COUNT(*) AS cnt FROM nodes GROUP BY label ORDER BY cnt DESC LIMIT 10',
            )
            .all();
          const dbStat = fs.statSync(dbPath);
          stats = { nodes: nodeCount, edges: edgeCount, size: dbStat.size, mtime: dbStat.mtimeMs };
          report = [
            '# Monograph Knowledge Graph',
            '',
            `## Overview`,
            `- **Nodes**: ${nodeCount.toLocaleString()}`,
            `- **Edges**: ${edgeCount.toLocaleString()}`,
            `- **Last built**: ${new Date(dbStat.mtimeMs).toLocaleString()}`,
            '',
            '## Top 20 Nodes by Degree',
            ...topNodes.map(
              (n, i) =>
                `${String(i + 1).padStart(3, ' ')}. **${n.name || n.id}** \`${n.label}\` — ${n.deg} connections`,
            ),
            '',
            '## Node Type Distribution',
            ...labelDist.map((r) => `- **${r.label}**: ${r.cnt}`),
          ].join('\n');
        } finally {
          closeDb(db);
        }
      }
      res.writeHead(200, {
        'Content-Type': 'application/json',
        ...(corsOrigin ? { 'Access-Control-Allow-Origin': corsOrigin } : {}),
        'Cache-Control': 'no-cache',
      });
      res.end(JSON.stringify({ exists, report, stats }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return true;
  }

  // -------------------------------------------------- GET /api/monograph-graph
  if (req.method === 'GET' && url === '/api/monograph-graph') {
    try {
      const qs = new URL(req.url, 'http://localhost').searchParams;
      const dir = qs.get('dir') || ctx.projectDir || process.cwd();
      const d = path.resolve(dir || process.cwd());
      const dbPath = path.join(d, '.monomind', 'monograph.db');
      let nodes = [],
        edges = [];
      if (fs.existsSync(dbPath)) {
        const { execFileSync } = await import('node:child_process');
        const runSql = (sql, timeout = 10000) => {
          try {
            return JSON.parse(
              execFileSync('sqlite3', ['-json', dbPath], {
                encoding: 'utf-8',
                timeout,
                maxBuffer: 50 * 1024 * 1024,
                input: `${sql};`,
              }) || '[]',
            );
          } catch {
            return [];
          }
        };
        const nodeLimit = Math.min(parseInt(qs.get('limit') || '500', 10), 5000);
        const labelFilter = qs.get('labels')
          ? qs
              .get('labels')
              .split(',')
              .map((s) => s.trim())
          : null;
        const rawNodes = labelFilter
          ? runSql(
              `SELECT id, name, label, file_path, community_id FROM nodes WHERE label IN (${labelFilter.map((l) => `'${l.replace(/'/g, "''")}'`).join(',')}) LIMIT 5000`,
            )
          : runSql(`SELECT id, name, label, file_path, community_id FROM nodes LIMIT 5000`);
        const rawEdges = runSql('SELECT source_id, target_id, relation FROM edges');
        const degree = new Map();
        for (const n of rawNodes) degree.set(n.id, 0);
        for (const e of rawEdges) {
          if (degree.has(e.source_id)) degree.set(e.source_id, (degree.get(e.source_id) || 0) + 1);
          if (degree.has(e.target_id)) degree.set(e.target_id, (degree.get(e.target_id) || 0) + 1);
        }
        const topNodes = labelFilter
          ? rawNodes
          : [...rawNodes]
              .sort((a, b) => (degree.get(b.id) || 0) - (degree.get(a.id) || 0))
              .slice(0, nodeLimit);
        const topIds = new Set(topNodes.map((n) => n.id));
        nodes = topNodes.map((n) => ({
          id: n.id,
          label: n.name || n.id,
          type: n.label || 'unknown',
          degree: degree.get(n.id) || 0,
        }));
        edges = rawEdges
          .filter((e) => topIds.has(e.source_id) && topIds.has(e.target_id))
          .slice(0, 2000)
          .map((e) => ({
            source: e.source_id,
            target: e.target_id,
            relation: e.relation || 'REF',
          }));
      }
      res.writeHead(200, {
        'Content-Type': 'application/json',
        ...(corsOrigin ? { 'Access-Control-Allow-Origin': corsOrigin } : {}),
        'Cache-Control': 'no-cache',
      });
      res.end(JSON.stringify({ nodes, edges }));
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    }
    return true;
  }
  return false;
}
