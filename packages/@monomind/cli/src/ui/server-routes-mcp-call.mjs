import fs from 'node:fs';
import path from 'node:path';
import { handleMcpToolsPart1 } from './server-routes-mcp-tools-1.mjs';
import { handleMcpToolsPart2 } from './server-routes-mcp-tools-2.mjs';

export async function handleMcpCallRoutes(req, res, url, corsOrigin, ctx) {
  const { projectDir } = ctx;
  // -------------------------------------------------- POST /api/mcp/call
  if (req.method === 'POST' && url === '/api/mcp/call') {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 2097152) {
        req.destroy();
        return;
      }
    });
    req.on('end', async () => {
      const json = (res) => {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          ...(corsOrigin ? { 'Access-Control-Allow-Origin': corsOrigin } : {}),
        });
      };
      const ok = (data) => {
        json(res);
        res.end(
          JSON.stringify({
            content: [
              {
                type: 'text',
                text: typeof data === 'string' ? data : JSON.stringify(data, null, 2),
              },
            ],
          }),
        );
      };
      const err = (msg) => {
        json(res);
        res.end(JSON.stringify({ error: msg }));
      };
      try {
        const { tool, input = {}, args = {} } = JSON.parse(body);
        const qs2 = new URL(req.url, 'http://localhost').searchParams;
        // dir can come from: URL query string, body.args.dir, body.input.dir, or server default
        const dir2 = qs2.get('dir') || args.dir || input.dir || projectDir;
        const d2 = path.resolve(dir2 || process.cwd());
        const dbPath2 = path.join(d2, '.monomind', 'monograph.db');
        if (!fs.existsSync(dbPath2)) {
          err('monograph.db not found — run monograph build first');
          return;
        }
        // Import only graphology-free storage modules to avoid broken graphology dep
        const { openDb, closeDb } = await import(
          new URL('../../../../monograph/dist/src/storage/db.js', import.meta.url).href
        );
        const { ftsSearch } = await import(
          new URL('../../../../monograph/dist/src/storage/fts-store.js', import.meta.url).href
        );
        const { countNodes } = await import(
          new URL('../../../../monograph/dist/src/storage/node-store.js', import.meta.url).href
        );
        const { countEdges } = await import(
          new URL('../../../../monograph/dist/src/storage/edge-store.js', import.meta.url).href
        );
        const _getShortestPath = (db, fromId, toId, maxDepth = 6) => {
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
        const db2 = openDb(dbPath2);
        try {
          const mcpCtx = { tool, input, args, db2, ok, err, d2, ftsSearch, countNodes, countEdges };
          const handled =
            (await handleMcpToolsPart1(mcpCtx)) || (await handleMcpToolsPart2(mcpCtx));
          if (!handled) ok(`Tool "${tool}" not implemented in control panel`);
        } finally {
          closeDb(db2);
        }
      } catch (e2) {
        err(String(e2));
      }
    });
    return true;
  }
  return false;
}
