import os from 'node:os';
import path from 'node:path';

// Org dashboard routes: warm knowledge search.
// Registered, in order, by handleOrgRoutes in routes-org.mjs.
export async function handleOrgKnowledgeRoutes(req, res, url, corsOrigin, ctx) {
  // POST /api/knowledge/search — warm semantic knowledge search for hooks.
  // The dashboard server is the one long-lived process on the machine, so it
  // holds the local embedding model warm; per-prompt hook subprocesses (which
  // cannot afford a model load) POST here and fall back to keyword scoring
  // when this endpoint is cold/absent. Fully local — model + store on disk.
  if (req.method === 'POST' && url === '/api/knowledge/search') {
    let body = '';
    let overLimit = false;
    req.on('data', (c) => {
      if (overLimit) return;
      body += c;
      if (body.length > 64 * 1024) {
        // queries are prompts, not documents
        overLimit = true;
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end('{"error":"request body too large"}');
        req.destroy();
      }
    });
    req.on('end', async () => {
      if (overLimit) return;
      try {
        const payload = JSON.parse(body || '{}');
        const query = String(payload.query || '').slice(0, 2000);
        const limit = Math.min(Math.max(parseInt(payload.limit, 10) || 3, 1), 10);
        const namespace =
          typeof payload.namespace === 'string' && /^[A-Za-z0-9:_-]{1,128}$/.test(payload.namespace)
            ? payload.namespace
            : 'knowledge:shared';
        if (!query) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end('{"error":"query required"}');
          return;
        }
        const bridge = await ctx._getKnowledgeBridge();
        if (!bridge) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end('{"error":"knowledge bridge unavailable"}');
          return;
        }
        // scope: project | global | all (default all) — project results get a
        // small tie boost; global hits are flagged so callers can show origin.
        const scope =
          payload.scope === 'project' || payload.scope === 'global' ? payload.scope : 'all';
        // Rule-based router (no LLM): chunks always run (this endpoint's
        // bread and butter); the auxiliary surfaces — distilled rules,
        // knowledge-graph triplets, pattern memories — only spend a query
        // when the router votes for them or routing is unconfident.
        let wantRules = true,
          wantKg = true,
          wantMemory = true;
        let rrfFuse = null;
        try {
          const routerMod = await import('../memory/query-router.js');
          const route = routerMod.routeQuery(query);
          rrfFuse = routerMod.rrfFuse;
          wantRules = !route.confident || route.surfaces.includes('rules');
          wantKg = !route.confident || route.surfaces.includes('kg');
          wantMemory = !route.confident || route.surfaces.includes('memory');
        } catch {
          /* router unavailable — keep all surfaces on */
        }
        let kgSearch = null;
        if (wantKg && scope !== 'global') {
          try {
            kgSearch = (await import('../memory/memory-kg.js')).kgSearch;
          } catch {
            /* kg unavailable */
          }
        }
        // Superseded-version filtering — the SAME rule `searchKnowledge` (and
        // therefore `monomind doc search` / `knowledge_search`) applies. This
        // endpoint queries the bridge directly for warmth, so without this it
        // would inject old document versions the Second Brain itself hides.
        let liveProj = new Set(),
          liveGlob = new Set(),
          isSuperseded = () => false,
          overfetch = (n) => n;
        // metaProj/metaGlob distinguish "no metadata log" (cannot judge, keep
        // everything) from "log exists and is empty" (every document was
        // removed, keep nothing). Without them, `doc remove` of the last
        // document left its chunks being injected into every prompt.
        let metaProj = false,
          metaGlob = false;
        try {
          const dp = await import('../knowledge/document-pipeline.js');
          // CLAUDE_PROJECT_DIR is whatever directory the user opened, which
          // can be a package subdirectory, while the CLI writes the metadata
          // log at the project root. Walk up to the nearest one that has it:
          // resolving the wrong root yields an empty live set, which silently
          // turns filtering OFF — and superseded rows are the large majority
          // of a long-lived store, so injection would be dominated by stale
          // document versions.
          const resolveKnowledgeRoot = (start) => {
            let probe = path.resolve(start);
            for (let up = 0; up < 8; up++) {
              if (dp.hasKnowledgeMetadata?.(probe)) return probe;
              const parent = path.dirname(probe);
              if (parent === probe) break;
              probe = parent;
            }
            return path.resolve(start);
          };
          const projRoot = resolveKnowledgeRoot(process.env.CLAUDE_PROJECT_DIR || process.cwd());
          const globRoot =
            process.env.MONOMIND_GLOBAL_BRAIN_DIR ||
            path.join(os.homedir(), '.monomind', 'global-brain');
          liveProj = dp.liveContentHashes(projRoot);
          liveGlob = dp.liveContentHashes(globRoot);
          metaProj = dp.hasKnowledgeMetadata?.(projRoot) ?? liveProj.size > 0;
          metaGlob = dp.hasKnowledgeMetadata?.(globRoot) ?? liveGlob.size > 0;
          isSuperseded = dp.isSupersededKey;
          overfetch = dp.supersededOverfetchLimit;
        } catch {
          /* pipeline unavailable — no filtering, same as before */
        }
        const keepLive = (rows, live, hasMeta) =>
          (rows || [])
            .filter((r) => !isSuperseded(String(r.key || ''), live, hasMeta))
            .slice(0, limit);
        const [projRaw, globRaw, rules, graph, mems] = await Promise.all([
          scope !== 'global'
            ? bridge
                .bridgeSearchEntries({ query, namespace, limit: overfetch(limit, liveProj) })
                .catch(() => null)
            : null,
          scope !== 'project'
            ? bridge
                .bridgeSearchEntries({
                  query,
                  namespace: 'knowledge:global',
                  limit: overfetch(limit, liveGlob),
                  dbPath: '@global',
                })
                .catch(() => null)
            : null,
          // Distilled rules ("when X do Y") learned from sessions/runs —
          // small namespace, high injection value, threshold keeps it quiet.
          scope !== 'global' && wantRules
            ? bridge
                .bridgeSearchEntries({ query, namespace: 'rules', limit: 2, threshold: 0.45 })
                .catch(() => null)
            : null,
          // Knowledge-graph triplets: relationship-shaped queries surface
          // facts no chunk contains. Triplet scores derive from seeded
          // cosine matches (≥0.35), so they clear callers' relevance floors.
          scope !== 'global' && kgSearch ? kgSearch({ query, limit: 4 }).catch(() => null) : null,
          // Past patterns/decisions for "last time / previously" queries.
          scope !== 'global' && wantMemory
            ? bridge
                .bridgeSearchEntries({ query, namespace: 'patterns', limit: 2, threshold: 0.4 })
                .catch(() => null)
            : null,
        ]);
        const lists = [
          keepLive(projRaw?.results, liveProj, metaProj).map((r) => ({
            id: r.id,
            key: r.key,
            content: String(r.content || '').slice(0, 2000),
            score: r.score + 0.05,
            global: false,
            tags: r.tags,
            importance: 0.6,
          })),
          keepLive(globRaw?.results, liveGlob, metaGlob).map((r) => ({
            id: r.id,
            key: r.key,
            content: String(r.content || '').slice(0, 2000),
            score: r.score,
            global: true,
            tags: r.tags,
          })),
          (rules?.results || []).map((r) => ({
            id: r.id,
            key: r.key,
            content: String(r.content || '').slice(0, 2000),
            score: r.score + 0.05,
            global: false,
            rule: true,
            tags: r.tags,
            importance: 0.7,
          })),
          (graph?.triplets || []).map((t, i) => ({
            id: `kg:${i}:${t.source}|${t.relation}|${t.target}`,
            key: `kg:${t.source}`,
            content: String(
              t.source +
                ' —' +
                t.relation +
                '→ ' +
                t.target +
                (t.fact && t.fact !== `${t.source} ${t.relation} ${t.target}`
                  ? ` (${String(t.fact).slice(0, 300)})`
                  : ''),
            ).slice(0, 2000),
            score: t.score,
            global: false,
            triplet: true,
          })),
          (mems?.results || []).map((r) => ({
            id: r.id,
            key: r.key,
            content: String(r.content || '').slice(0, 2000),
            score: r.score,
            global: false,
            memory: true,
            tags: r.tags,
          })),
        ];
        // Rank-fuse across surfaces (raw scores aren't comparable between
        // cosine chunks and blended triplets); each item keeps its native
        // score so downstream relevance floors still apply. Fallback: flat
        // score sort when the router module failed to load.
        const merged = (
          rrfFuse
            ? rrfFuse(lists, limit)
            : lists
                .flat()
                .sort((a, b) => b.score - a.score)
                .slice(0, limit)
        ).map(({ importance, rrf, ...r }) => r);
        // Served excerpts are (very likely) injected into the caller's prompt —
        // that IS usage. Reinforce frequency_weight, per-store, fire-and-forget.
        try {
          const projIds = merged.filter((m) => !m.global && !m.triplet && m.id).map((m) => m.id);
          const globIds = merged.filter((m) => m.global && m.id).map((m) => m.id);
          if (projIds.length) bridge.bridgeRecordUsage?.({ entryIds: projIds }).catch(() => {});
          if (globIds.length)
            bridge.bridgeRecordUsage?.({ entryIds: globIds, dbPath: '@global' }).catch(() => {});
        } catch {
          /* best effort */
        }
        res.writeHead(200, {
          'Content-Type': 'application/json',
          ...(corsOrigin ? { 'Access-Control-Allow-Origin': corsOrigin } : {}),
        });
        res.end(
          JSON.stringify({
            method:
              projRaw?.searchMethod ||
              globRaw?.searchMethod ||
              rules?.searchMethod ||
              mems?.searchMethod ||
              (merged.length ? 'mixed' : 'none'),
            results: merged,
          }),
        );
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return true;
  }
  return false;
}
