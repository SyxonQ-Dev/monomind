import fs from 'node:fs';
import path from 'node:path';

// Monograph dashboard routes (extracted from routes-monograph.mjs).
// Registered, in order, by handleMonographRoutes in routes-monograph.mjs.
export async function handleMonographQueryRoutes(req, res, url, corsOrigin, ctx) {
  // -------------------------------------------------- GET /api/monograph-query
  if (req.method === 'GET' && url === '/api/monograph-query') {
    try {
      const qs = new URL(req.url, 'http://localhost').searchParams;
      const dir = qs.get('dir') || ctx.projectDir || process.cwd();
      const q = (qs.get('q') || '').trim().slice(0, 4096);
      const d = path.resolve(dir || process.cwd());
      const dbPath = path.join(d, '.monomind', 'monograph.db');
      if (!q) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Missing ?q= parameter' }));
        return true;
      }
      if (!fs.existsSync(dbPath)) {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          ...(corsOrigin ? { 'Access-Control-Allow-Origin': corsOrigin } : {}),
        });
        res.end(
          JSON.stringify({
            success: false,
            result: 'Graph not built yet. Run: monomind monograph build',
          }),
        );
        return true;
      }
      const { openDb, closeDb } = await import(
        new URL('../../../../monograph/dist/src/storage/db.js', import.meta.url).href
      );
      const { ftsSearch } = await import(
        new URL('../../../../monograph/dist/src/storage/fts-store.js', import.meta.url).href
      );
      const db = openDb(dbPath);
      let result = '';
      try {
        const hits = ftsSearch(db, q, 20);
        if (!hits.length) {
          result = `No matches found for: "${q}"`;
        } else {
          result = hits
            .map(
              (h, i) =>
                `${String(i + 1).padStart(3, ' ')}. ${h.name} [${h.normLabel}]${h.filePath ? `\n     ${h.filePath}` : ''}`,
            )
            .join('\n');
          // Show outgoing edges for top hit
          const topHit = hits[0];
          const neighbors = db
            .prepare('SELECT target_id, relation FROM edges WHERE source_id=? LIMIT 10')
            .all(topHit.id);
          if (neighbors.length) {
            result +=
              `\n\n── ${topHit.name} references:\n` +
              neighbors
                .map((n) => `   ${n.relation} → ${n.target_id.split('/').pop() || n.target_id}`)
                .join('\n');
          }
        }
      } finally {
        closeDb(db);
      }
      res.writeHead(200, {
        'Content-Type': 'application/json',
        ...(corsOrigin ? { 'Access-Control-Allow-Origin': corsOrigin } : {}),
      });
      res.end(JSON.stringify({ success: true, query: q, result }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return true;
  }

  // -------------------------------------------------- GET /api/monograph-explain
  if (req.method === 'GET' && url === '/api/monograph-explain') {
    try {
      const qs = new URL(req.url, 'http://localhost').searchParams;
      const dir = qs.get('dir') || ctx.projectDir || process.cwd();
      const nodeQ = (qs.get('node') || '').trim().slice(0, 4096);
      const d = path.resolve(dir || process.cwd());
      const dbPath = path.join(d, '.monomind', 'monograph.db');
      if (!nodeQ) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Missing ?node= parameter' }));
        return true;
      }
      if (!fs.existsSync(dbPath)) {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          ...(corsOrigin ? { 'Access-Control-Allow-Origin': corsOrigin } : {}),
        });
        res.end(
          JSON.stringify({
            success: false,
            explanation: 'Graph not built yet. Run: monomind monograph build',
          }),
        );
        return true;
      }
      const { openDb, closeDb } = await import(
        new URL('../../../../monograph/dist/src/storage/db.js', import.meta.url).href
      );
      const { ftsSearch } = await import(
        new URL('../../../../monograph/dist/src/storage/fts-store.js', import.meta.url).href
      );
      const db = openDb(dbPath);
      let explanation = '';
      try {
        let nd =
          db.prepare('SELECT * FROM nodes WHERE id=?').get(nodeQ) ||
          db.prepare('SELECT * FROM nodes WHERE name=?').get(nodeQ);
        if (!nd) {
          const hits = ftsSearch(db, nodeQ, 1);
          if (hits[0]) nd = db.prepare('SELECT * FROM nodes WHERE id=?').get(hits[0].id);
        }
        if (!nd) {
          explanation = `No node found matching: "${nodeQ}"`;
        } else {
          const outEdges = db
            .prepare('SELECT target_id, relation FROM edges WHERE source_id=? LIMIT 20')
            .all(nd.id);
          const inEdges = db
            .prepare('SELECT source_id, relation FROM edges WHERE target_id=? LIMIT 20')
            .all(nd.id);
          explanation = [
            `## ${nd.name} [${nd.label}]`,
            nd.file_path ? `File: ${nd.file_path}${nd.start_line ? `:${nd.start_line}` : ''}` : '',
            nd.language ? `Language: ${nd.language}` : '',
            nd.is_exported ? 'Exported: yes' : 'Exported: no',
            '',
            outEdges.length
              ? `References (${outEdges.length}):\n` +
                outEdges
                  .map((e) => `  ${e.relation} → ${e.target_id.split('/').pop() || e.target_id}`)
                  .join('\n')
              : 'No outgoing references.',
            inEdges.length
              ? `\nReferenced by (${inEdges.length}):\n` +
                inEdges
                  .map((e) => `  ${e.source_id.split('/').pop() || e.source_id} [${e.relation}]`)
                  .join('\n')
              : '',
          ]
            .filter(Boolean)
            .join('\n');
        }
      } finally {
        closeDb(db);
      }
      res.writeHead(200, {
        'Content-Type': 'application/json',
        ...(corsOrigin ? { 'Access-Control-Allow-Origin': corsOrigin } : {}),
      });
      res.end(JSON.stringify({ success: true, node: nodeQ, explanation }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return true;
  }

  // -------------------------------------------------- GET /api/monograph-path
  if (req.method === 'GET' && url === '/api/monograph-path') {
    try {
      const qs = new URL(req.url, 'http://localhost').searchParams;
      const dir = qs.get('dir') || ctx.projectDir || process.cwd();
      const from = (qs.get('from') || '').trim().slice(0, 4096);
      const to = (qs.get('to') || '').trim().slice(0, 4096);
      const d = path.resolve(dir || process.cwd());
      const dbPath = path.join(d, '.monomind', 'monograph.db');
      if (!from || !to) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Missing ?from= and ?to= parameters' }));
        return true;
      }
      if (!fs.existsSync(dbPath)) {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          ...(corsOrigin ? { 'Access-Control-Allow-Origin': corsOrigin } : {}),
        });
        res.end(JSON.stringify({ success: false, path: 'Graph not built yet.' }));
        return true;
      }
      // Import only graphology-free storage modules to avoid broken graphology dep
      const { openDb, closeDb } = await import(
        new URL('../../../../monograph/dist/src/storage/db.js', import.meta.url).href
      );
      const { ftsSearch } = await import(
        new URL('../../../../monograph/dist/src/storage/fts-store.js', import.meta.url).href
      );
      // SQL-based BFS for shortest path (avoids graphology)
      const getShortestPath = (db, fromId, toId, maxDepth = 6) => {
        if (fromId === toId) return [fromId];
        const visited = new Set([fromId]);
        let frontier = [[fromId]];
        for (let depth = 0; depth < maxDepth; depth++) {
          const next = [];
          for (const chain of frontier) {
            const cur = chain[chain.length - 1];
            const neighbors = db
              .prepare(
                'SELECT target_id AS id FROM edges WHERE source_id=? UNION SELECT source_id AS id FROM edges WHERE target_id=?',
              )
              .all(cur, cur);
            for (const { id } of neighbors) {
              if (!visited.has(id)) {
                const newChain = [...chain, id];
                if (id === toId) return newChain;
                visited.add(id);
                next.push(newChain);
              }
            }
          }
          if (!next.length) break;
          frontier = next;
        }
        return null;
      };
      const db = openDb(dbPath);
      let pathResult = '';
      try {
        const resolveId = (q) => {
          const direct = db.prepare('SELECT id FROM nodes WHERE id=? OR name=?').get(q, q);
          if (direct) return direct.id;
          const hits = ftsSearch(db, q, 1);
          return hits[0]?.id || q;
        };
        const fromId = resolveId(from);
        const toId = resolveId(to);
        const p = getShortestPath(db, fromId, toId);
        if (!p?.length) {
          pathResult = `No path found between "${from}" and "${to}"`;
        } else {
          const names = p.map((id) => {
            const n = db.prepare('SELECT name FROM nodes WHERE id=?').get(id);
            return n ? n.name : id.split('/').pop() || id;
          });
          pathResult = `${names.join(' → ')}  (${p.length - 1} hop${p.length !== 2 ? 's' : ''})`;
        }
      } finally {
        closeDb(db);
      }
      res.writeHead(200, {
        'Content-Type': 'application/json',
        ...(corsOrigin ? { 'Access-Control-Allow-Origin': corsOrigin } : {}),
      });
      res.end(JSON.stringify({ success: true, from, to, path: pathResult }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return true;
  }
  return false;
}
