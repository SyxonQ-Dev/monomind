import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as hil from './org-hil.mjs';
import { handleOrgAgentRoutes } from './routes-org-agents.mjs';
import { handleOrgApprovalRoutes } from './routes-org-approvals.mjs';
import { handleOrgConfigRoutes } from './routes-org-config.mjs';
import { handleOrgFileRoutes } from './routes-org-files.mjs';
import { handleOrgLifecycleRoutes } from './routes-org-lifecycle.mjs';
import { handleOrgLiveRoutes } from './routes-org-live.mjs';
import { handleOrgMastermindRoutes } from './routes-org-mastermind.mjs';
import { handleOrgPlanningRoutes } from './routes-org-planning.mjs';
import { handleOrgRunRoutes } from './routes-org-runs.mjs';
import { handleOrgStatusRoutes } from './routes-org-status.mjs';

export async function handleOrgRoutes(req, res, url, corsOrigin, ctx) {
  if (await handleOrgConfigRoutes(req, res, url, corsOrigin, ctx)) return true;
  if (await handleOrgAgentRoutes(req, res, url, corsOrigin, ctx)) return true;
  if (await handleOrgStatusRoutes(req, res, url, corsOrigin, ctx)) return true;
  if (await handleOrgApprovalRoutes(req, res, url, corsOrigin, ctx)) return true;
  if (await handleOrgPlanningRoutes(req, res, url, corsOrigin, ctx)) return true;
  if (await handleOrgFileRoutes(req, res, url, corsOrigin, ctx)) return true;
  if (await handleOrgLifecycleRoutes(req, res, url, corsOrigin, ctx)) return true;
  if (await handleOrgRunRoutes(req, res, url, corsOrigin, ctx)) return true;
  if (await handleOrgMastermindRoutes(req, res, url, corsOrigin, ctx)) return true;
  if (await handleOrgLiveRoutes(req, res, url, corsOrigin, ctx)) return true;

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

  // GET /api/mastermind/metrics — aggregate system metrics from token-summary and monoswarm-activity
  if (req.method === 'GET' && url === '/api/mastermind/metrics') {
    try {
      const base = path.join(ctx.projectDir || process.cwd(), '.monomind', 'metrics');
      let tokens = {},
        monoswarm = {},
        events = [];
      try {
        tokens = JSON.parse(fs.readFileSync(path.join(base, 'token-summary.json'), 'utf8'));
      } catch (_) {}
      try {
        monoswarm = JSON.parse(fs.readFileSync(path.join(base, 'monoswarm-activity.json'), 'utf8'));
      } catch (_) {}
      try {
        const evPath = path.join(
          ctx.projectDir || process.cwd(),
          'data',
          'mastermind-events.jsonl',
        );
        const lines = fs
          .readFileSync(evPath, 'utf8')
          .split('\n')
          .filter((l) => l.trim())
          .slice(-20);
        events = lines
          .map((l) => {
            try {
              return JSON.parse(l);
            } catch (_) {
              return null;
            }
          })
          .filter(Boolean);
      } catch (_) {}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ tokens, monoswarm, recentEvents: events }));
    } catch (_) {
      res.writeHead(500);
      res.end('{"tokens":{},"monoswarm":{},"recentEvents":[]}');
    }
    return true;
  }

  // ------------------------------------------------- GET /api/playbooks
  // List playbook definitions from <dir>/.monomind/playbooks/*.json.
  // (Previously only POST was registered, so GET /api/playbooks?dir=... fell
  // through to the 404 handler.)
  if (req.method === 'GET' && url === '/api/playbooks') {
    try {
      const qp = new URL(req.url, 'http://localhost').searchParams;
      const dir = qp.get('dir') || ctx.projectDir || process.cwd();
      const playbookDir = path.join(path.resolve(dir), '.monomind', 'playbooks');
      const result = [];
      if (fs.existsSync(playbookDir)) {
        const files = fs
          .readdirSync(playbookDir)
          .filter((f) => f.endsWith('.json') && !f.startsWith('._'));
        for (const file of files) {
          try {
            const fpath = path.join(playbookDir, file);
            const def = JSON.parse(fs.readFileSync(fpath, 'utf8'));
            const stat = fs.statSync(fpath);
            result.push({
              ...def,
              id: def.id || file.replace('.json', ''),
              file,
              modifiedAt: stat.mtimeMs,
            });
          } catch (_) {}
        }
      }
      res.writeHead(200, {
        'Content-Type': 'application/json',
        ...(corsOrigin ? { 'Access-Control-Allow-Origin': corsOrigin } : {}),
        'Cache-Control': 'no-cache',
      });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return true;
  }

  // ------------------------------------------------- POST /api/playbooks
  // Save a playbook definition to .monomind/playbooks/<id>.json
  if (req.method === 'POST' && url === '/api/playbooks') {
    try {
      let body = '';
      await new Promise((resolve, reject) => {
        req.on('data', (d) => {
          body += d;
        });
        req.on('end', resolve);
        req.on('error', reject);
      });
      const pb = JSON.parse(body);
      if (!pb.id || !pb.name) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'id and name are required' }));
        return true;
      }
      const dir = ctx.projectDir || process.cwd();
      const playbookDir = path.join(dir, '.monomind', 'playbooks');
      fs.mkdirSync(playbookDir, { recursive: true });
      const filePath = path.join(playbookDir, `${pb.id}.json`);
      fs.writeFileSync(filePath, JSON.stringify(pb, null, 2));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, id: pb.id, file: `${pb.id}.json` }));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
    return true;
  }

  // ------------------------------------------------- GET /api/workflow-defs
  if (req.method === 'GET' && url === '/api/workflow-defs') {
    try {
      const qp = new URL(req.url, 'http://x').searchParams;
      const dir = qp.get('dir') || ctx.projectDir || process.cwd();
      const playbookDir = path.join(dir, '.monomind', 'playbooks');
      const result = [];
      if (fs.existsSync(playbookDir)) {
        const files = fs.readdirSync(playbookDir).filter((f) => f.endsWith('.json'));
        for (const file of files) {
          try {
            const fpath = path.join(playbookDir, file);
            const stat = fs.statSync(fpath);
            const def = JSON.parse(fs.readFileSync(fpath, 'utf8'));
            const params = (def.params || []).map((p) =>
              typeof p === 'string' ? p : p.name || p.key || '',
            );
            result.push({
              id: def.id || file.replace('.json', ''),
              name: def.name || file.replace('.json', ''),
              description: def.description || null,
              file,
              nodeCount: Array.isArray(def.nodes) ? def.nodes.length : 0,
              params,
              modifiedAt: stat.mtimeMs,
            });
          } catch (_) {}
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
    return true;
  }

  // ------------------------------------------------- GET /api/org-coverage
  // Audit coverage report written by the audit loop to .monomind/audit/coverage.json
  if (req.method === 'GET' && url === '/api/org-coverage') {
    try {
      const qp = new URL(req.url, 'http://localhost').searchParams;
      const dir = path.resolve(qp.get('dir') || ctx.projectDir || process.cwd());
      const covPath = path.join(dir, '.monomind', 'audit', 'coverage.json');
      if (!fs.existsSync(covPath)) {
        res.writeHead(404, {
          'Content-Type': 'application/json',
          ...(corsOrigin ? { 'Access-Control-Allow-Origin': corsOrigin } : {}),
        });
        res.end('{}');
        return true;
      }
      const coverage = JSON.parse(fs.readFileSync(covPath, 'utf8'));
      res.writeHead(200, {
        'Content-Type': 'application/json',
        ...(corsOrigin ? { 'Access-Control-Allow-Origin': corsOrigin } : {}),
        'Cache-Control': 'no-cache',
      });
      res.end(JSON.stringify(coverage));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return true;
  }

  // ------------------------------------------------- GET /api/workflow-runs
  if (req.method === 'GET' && url === '/api/workflow-runs') {
    // Reads from ~/.monomind/browse-runs.json written by the monobrowse dashboard server.
    try {
      const runsFile = path.join(os.homedir(), '.monomind', 'browse-runs.json');
      if (fs.existsSync(runsFile)) {
        const raw = fs.readFileSync(runsFile, 'utf-8');
        const runs = JSON.parse(raw);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(Array.isArray(runs) ? runs : []));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('[]');
      }
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('[]');
    }
    return true;
  }

  // ---- POST /api/orgs/:name/mark-complete — manual STALE recovery ----
  if (
    req.method === 'POST' &&
    /^\/api\/orgs\/[a-z0-9][a-z0-9_-]{0,63}\/mark-complete$/i.test(url)
  ) {
    const _mcOrgName = decodeURIComponent(url.split('/')[3]);
    if (_mcOrgName.length > 64 || !/^[a-z0-9][a-z0-9_-]*$/i.test(_mcOrgName)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid org name' }));
      return true;
    }
    const _mcRoot = ctx.projectDir || process.cwd();
    const _mcMonoDir = ctx._getGitMonomindDir(_mcRoot) || path.join(_mcRoot, '.monomind');
    const _mcRunId = ctx.activeOrgRuns.get(_mcOrgName) || ctx._getActiveRunId(_mcOrgName, _mcRoot);
    if (!_mcRunId) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `No active run for org: ${_mcOrgName}` }));
      return true;
    }
    const _mcEvent = {
      type: 'run:complete',
      org: _mcOrgName,
      runId: _mcRunId,
      ts: Date.now(),
      reason: 'manual',
    };
    try {
      const _mcRunFile = path.join(_mcMonoDir, 'orgs', _mcOrgName, 'runs', `${_mcRunId}.jsonl`);
      if (fs.existsSync(_mcRunFile))
        await ctx.appendToFile(_mcRunFile, `${JSON.stringify(_mcEvent)}\n`);
      ctx.activeOrgRuns.delete(_mcOrgName);
      // Clean up ppid-keyed active-run files for this org
      const _mcCapDir = path.join(ctx.MONOMIND_HOME, '.monomind', 'capture');
      try {
        const _mcPpidDir = path.join(_mcCapDir, 'active-runs');
        if (fs.existsSync(_mcPpidDir)) {
          fs.readdirSync(_mcPpidDir)
            .filter((f) => f.endsWith('.json'))
            .forEach((_pf) => {
              try {
                const _pd = JSON.parse(fs.readFileSync(path.join(_mcPpidDir, _pf), 'utf8'));
                if (_pd.org === _mcOrgName) fs.unlinkSync(path.join(_mcPpidDir, _pf));
              } catch (_) {}
            });
        }
        const _mcActiveFile = path.join(_mcCapDir, 'active-run.json');
        if (fs.existsSync(_mcActiveFile)) {
          try {
            const _a = JSON.parse(fs.readFileSync(_mcActiveFile, 'utf8'));
            if (_a.org === _mcOrgName) fs.unlinkSync(_mcActiveFile);
          } catch (_) {}
        }
      } catch (_) {}
      ctx._updateRunState(_mcEvent, _mcRoot);
      ctx.broadcastMm(_mcEvent);
      const _mcFwdClients = ctx.runStreamClients.get(_mcOrgName);
      if (_mcFwdClients && _mcFwdClients.size > 0) {
        const _mcLine = `data: ${JSON.stringify(_mcEvent)}\n\n`;
        for (const _cl of _mcFwdClients) {
          try {
            _cl.write(_mcLine);
          } catch (_) {
            _mcFwdClients.delete(_cl);
          }
        }
      }
      res.writeHead(200, {
        'Content-Type': 'application/json',
        ...(corsOrigin ? { 'Access-Control-Allow-Origin': corsOrigin } : {}),
      });
      res.end(JSON.stringify({ ok: true, runId: _mcRunId }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return true;
  }

  // ---- GET /api/orgs/:name/runs/current/stream — Phase 3 streaming tail ----
  if (
    req.method === 'GET' &&
    /^\/api\/orgs\/[a-z0-9][a-z0-9_-]{0,63}\/runs\/current\/stream$/i.test(url)
  ) {
    const _stOrgName = decodeURIComponent(url.split('/')[3]);
    if (_stOrgName.length > 64 || !/^[a-z0-9][a-z0-9_-]*$/i.test(_stOrgName)) {
      res.writeHead(400);
      res.end('Invalid org name');
      return true;
    }
    const _stQs = new URL(req.url, 'http://localhost').searchParams;
    const _stSince = Math.max(0, parseInt(_stQs.get('since') || '0', 10) || 0);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      ...(corsOrigin ? { 'Access-Control-Allow-Origin': corsOrigin } : {}),
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    // Register client for live events
    if (!ctx.runStreamClients.has(_stOrgName)) ctx.runStreamClients.set(_stOrgName, new Set());
    ctx.runStreamClients.get(_stOrgName).add(res);
    // Replay events since `since` (SQLite row id cursor; falls back to JSONL line offset)
    try {
      let _stReplayedViaSqlite = false;
      if (ctx._runDb) {
        // SQLite path: cursor is last row id seen (client sends 0 on first connect)
        const _stStmt = ctx._runDb.prepare(
          'SELECT id, raw FROM run_events WHERE org=? AND id > ? ORDER BY id LIMIT 2000',
        );
        _stStmt.bind([_stOrgName, _stSince]);
        let _stLastId = _stSince;
        while (_stStmt.step()) {
          const _stRow = _stStmt.getAsObject();
          try {
            res.write(`data: ${_stRow.raw}\n\n`);
            _stLastId = _stRow.id;
          } catch (_) {
            break;
          }
        }
        _stStmt.free();
        if (_stLastId > _stSince) {
          // SQLite had rows — send cursor and skip JSONL fallback
          res.write(
            `data: ${JSON.stringify({ type: 'stream:replay-done', count: _stLastId })}\n\n`,
          );
          _stReplayedViaSqlite = true;
        }
      }
      if (!_stReplayedViaSqlite) {
        // JSONL fallback: SQLite absent or returned 0 rows — read directly from run file.
        // `since` is a 0-based line offset in this path.
        const _stRoot = ctx.projectDir || process.cwd();
        const _stRunId =
          ctx.activeOrgRuns.get(_stOrgName) || ctx._getActiveRunId(_stOrgName, _stRoot);
        if (_stRunId) {
          const _stMono = ctx._getGitMonomindDir(_stRoot) || path.join(_stRoot, '.monomind');
          const _stRunFile = path.join(_stMono, 'orgs', _stOrgName, 'runs', `${_stRunId}.jsonl`);
          if (fs.existsSync(_stRunFile)) {
            const _stLines = fs.readFileSync(_stRunFile, 'utf8').trim().split('\n').filter(Boolean);
            for (let _i = _stSince; _i < _stLines.length; _i++) {
              try {
                res.write(`data: ${_stLines[_i]}\n\n`);
              } catch (_) {
                break;
              }
            }
            res.write(
              `data: ${JSON.stringify({ type: 'stream:replay-done', count: _stLines.length })}\n\n`,
            );
          } else {
            res.write(`data: ${JSON.stringify({ type: 'stream:replay-done', count: 0 })}\n\n`);
          }
        } else {
          res.write(`data: ${JSON.stringify({ type: 'stream:replay-done', count: 0 })}\n\n`);
        }
      }
    } catch (_) {}
    const _stKa = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch (_) {
        clearInterval(_stKa);
      }
    }, 20000);
    req.on('close', () => {
      clearInterval(_stKa);
      const _stClients = ctx.runStreamClients.get(_stOrgName);
      if (_stClients) {
        _stClients.delete(res);
        if (_stClients.size === 0) ctx.runStreamClients.delete(_stOrgName);
      }
    });
    return true;
  }

  // ---- POST /api/orgs/:name/chat — user sends a message to a running org ----
  if (req.method === 'POST' && /^\/api\/orgs\/[a-z0-9][a-z0-9_-]{0,63}\/chat$/i.test(url)) {
    let _chBody = '';
    for await (const chunk of req) {
      _chBody += chunk;
      if (_chBody.length > 65536) {
        req.destroy();
        break;
      }
    }
    try {
      const _chOrgName = decodeURIComponent(url.split('/')[3]);
      if (_chOrgName.length > 64 || !/^[a-z0-9][a-z0-9_-]*$/i.test(_chOrgName)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid org name' }));
        return true;
      }
      let _chPayload = {};
      try {
        _chPayload = JSON.parse(_chBody);
      } catch (_) {}
      const _chText = String(_chPayload.text || '')
        .trim()
        .slice(0, 4096);
      if (!_chText) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'text is required' }));
        return true;
      }
      const _chQs = new URL(req.url, 'http://localhost').searchParams;
      const _chServerRoot = path.resolve(_chQs.get('dir') || ctx.projectDir || process.cwd());
      const _chRoot = ctx._resolveOrgProjectDir(_chOrgName, _chServerRoot) || _chServerRoot;
      const _chMonoDir = ctx._getGitMonomindDir(_chRoot) || path.join(_chRoot, '.monomind');
      const _chRunId =
        ctx.activeOrgRuns.get(_chOrgName) || ctx._getActiveRunId(_chOrgName, _chRoot);
      // Deliver to the target role (default: the root role) — live into its
      // mailbox, or queued in the org's inbox for its next run.
      let _chRoles = [];
      try {
        const _chCfg = JSON.parse(
          fs.readFileSync(path.join(_chRoot, '.monomind', 'orgs', `${_chOrgName}.json`), 'utf8'),
        );
        if (Array.isArray(_chCfg.roles)) _chRoles = _chCfg.roles;
      } catch (_) {}
      const _chTargetRole =
        typeof _chPayload.role === 'string' && _chPayload.role
          ? _chRoles.find((r) => r.id === _chPayload.role)?.id
          : (_chRoles.find((r) => !r.reports_to) || _chRoles[0])?.id;
      if (!_chTargetRole) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: false,
            error: _chPayload.role
              ? `org "${_chOrgName}" has no role "${_chPayload.role}"`
              : `org "${_chOrgName}" has no role to receive it`,
          }),
        );
        return true;
      }
      let _chDelivery;
      try {
        _chDelivery = (await hil.sendHumanMessage(_chRoot, _chOrgName, _chTargetRole, _chText))
          .delivery;
      } catch (err) {
        const { status, error } = hil.hilErrorStatus(err);
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error }));
        return true;
      }
      const _chEvent = {
        type: 'user:message',
        org: _chOrgName,
        runId: _chRunId || null,
        text: _chText,
        ts: Date.now(),
      };
      // Write to run JSONL if active run exists
      if (_chRunId) {
        const _chRunFile = path.join(_chMonoDir, 'orgs', _chOrgName, 'runs', `${_chRunId}.jsonl`);
        if (fs.existsSync(_chRunFile))
          await ctx.appendToFile(_chRunFile, `${JSON.stringify(_chEvent)}\n`);
      }
      // Broadcast to SSE stream clients
      ctx.broadcastMm(_chEvent);
      const _chFwdClients = ctx.runStreamClients.get(_chOrgName);
      if (_chFwdClients && _chFwdClients.size > 0) {
        const _chLine = `data: ${JSON.stringify(_chEvent)}\n\n`;
        for (const _cl of _chFwdClients) {
          try {
            _cl.write(_chLine);
          } catch (_) {
            _chFwdClients.delete(_cl);
          }
        }
      }
      res.writeHead(200, {
        'Content-Type': 'application/json',
        ...(corsOrigin ? { 'Access-Control-Allow-Origin': corsOrigin } : {}),
      });
      res.end(
        JSON.stringify({
          ok: true,
          delivered: _chDelivery === 'live',
          delivery: _chDelivery,
          role: _chTargetRole,
        }),
      );
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return true;
  }
  return false;
}
