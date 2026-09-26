import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// forwarder.js is compiled from orgrt/forwarder.ts (dist/src/orgrt/forwarder.js
// sits alongside this file's own compiled dist/src/ui/routes-org.mjs after
// build; under vitest the .js specifier resolves straight to the .ts source,
// same as every other cross-reference in this codebase). translate()/
// companionEvents() are pure — no filesystem or process side effects — so
// importing them here doesn't pull in attachForwarder's spawn/heal logic.
import { companionEvents, translate } from '../orgrt/forwarder.js';
import * as hil from './org-hil.mjs';
import { handleOrgAgentRoutes } from './routes-org-agents.mjs';
import { handleOrgApprovalRoutes } from './routes-org-approvals.mjs';
import { handleOrgConfigRoutes } from './routes-org-config.mjs';
import { handleOrgPlanningRoutes } from './routes-org-planning.mjs';
import { handleOrgStatusRoutes } from './routes-org-status.mjs';
import { getMmClientCount } from './sse-manager.mjs';

export async function handleOrgRoutes(req, res, url, corsOrigin, ctx) {
  if (await handleOrgConfigRoutes(req, res, url, corsOrigin, ctx)) return true;
  if (await handleOrgAgentRoutes(req, res, url, corsOrigin, ctx)) return true;
  if (await handleOrgStatusRoutes(req, res, url, corsOrigin, ctx)) return true;
  if (await handleOrgApprovalRoutes(req, res, url, corsOrigin, ctx)) return true;
  if (await handleOrgPlanningRoutes(req, res, url, corsOrigin, ctx)) return true;

  // GET /api/org/:name/files — all files related to an org
  if (req.method === 'GET' && url.match(/^\/api\/org\/[a-z0-9][a-z0-9_-]{0,63}\/files$/i)) {
    try {
      const orgName = decodeURIComponent(url.split('/')[3]);
      if (orgName.length > 64 || !/^[a-z0-9][a-z0-9_-]*$/i.test(orgName)) {
        res.writeHead(400);
        res.end('{"error":"Invalid org name"}');
        return true;
      }
      const _filesQs = new URL(req.url, 'http://localhost').searchParams;
      const d = path.resolve(_filesQs.get('dir') || ctx.projectDir || process.cwd());
      const orgsDir = path.join(d, '.monomind', 'orgs');
      const files = [];
      const seen = new Set();
      const addFile = (fp, type) => {
        if (seen.has(fp)) return;
        seen.add(fp);
        try {
          const st = fs.statSync(fp);
          files.push({
            name: path.basename(fp),
            path: fp,
            type,
            size: st.size,
            mtime: st.mtime.toISOString(),
          });
        } catch (_) {}
      };
      addFile(path.join(orgsDir, `${orgName}.json`), 'config');
      for (const s of [
        '-state',
        '-approvals',
        '-goals',
        '-routines',
        '-projects',
        '-members',
        '-issues',
        '-threads',
        '-budgets',
      ]) {
        const fp = path.join(orgsDir, `${orgName + s}.json`);
        if (fs.existsSync(fp)) addFile(fp, s.slice(1));
      }
      const walkDir = (dir, depth) => {
        if (depth > 3) return;
        let entries;
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch (_) {
          return;
        }
        for (const e of entries) {
          if (e.name.startsWith('.')) continue;
          const fp = path.join(dir, e.name);
          if (e.isDirectory()) walkDir(fp, depth + 1);
          else addFile(fp, 'generated');
        }
      };
      const orgWorkDir = path.join(orgsDir, orgName);
      if (fs.existsSync(orgWorkDir)) walkDir(orgWorkDir, 0);
      let orgCfg = null;
      try {
        orgCfg = JSON.parse(fs.readFileSync(path.join(orgsDir, `${orgName}.json`), 'utf8'));
      } catch (_) {}
      if (orgCfg && Array.isArray(orgCfg.roles)) {
        const agentsDir = path.join(d, '.claude', 'agents');
        const walkAgents = (dir) => {
          let entries;
          try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
          } catch (_) {
            return;
          }
          for (const e of entries) {
            if (e.isDirectory()) {
              walkAgents(path.join(dir, e.name));
              continue;
            }
            if (!e.name.endsWith('.md')) continue;
            const fp = path.join(dir, e.name);
            const base = e.name.replace('.md', '').toLowerCase();
            if (
              orgCfg.roles.some(
                (r) =>
                  base === (r.id || '').toLowerCase() ||
                  base === (r.agent_type || '').toLowerCase() ||
                  (r.instructions_file || '').endsWith(e.name),
              )
            )
              addFile(fp, 'agent-definition');
          }
        };
        if (fs.existsSync(agentsDir)) walkAgents(agentsDir);
      }
      files.sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
      res.writeHead(200, {
        'Content-Type': 'application/json',
        ...(corsOrigin ? { 'Access-Control-Allow-Origin': corsOrigin } : {}),
        'Cache-Control': 'no-cache',
      });
      res.end(JSON.stringify(files));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
    return true;
  }

  // GET /api/file-content — return raw text content of a .monomind file
  if (req.method === 'GET' && url === '/api/file-content') {
    try {
      const _fcQs = new URL(req.url, 'http://localhost').searchParams;
      const rawPath = _fcQs.get('path');
      const baseDir = path.resolve(_fcQs.get('dir') || ctx.projectDir || process.cwd());
      if (!rawPath) {
        res.writeHead(400);
        res.end('Missing path');
        return true;
      }
      const resolved = path.resolve(rawPath);
      // Security: must be inside .monomind of the project dir
      const monomindDir = path.join(baseDir, '.monomind');
      if (!resolved.startsWith(monomindDir + path.sep) && resolved !== monomindDir) {
        res.writeHead(403);
        res.end('Forbidden');
        return true;
      }
      if (!fs.existsSync(resolved)) {
        res.writeHead(404);
        res.end('Not found');
        return true;
      }
      const stat = fs.statSync(resolved);
      if (!stat.isFile()) {
        res.writeHead(400);
        res.end('Not a file');
        return true;
      }
      if (stat.size > 524288) {
        res.writeHead(413);
        res.end('File too large');
        return true;
      }
      const _fcMime = ctx._detectMimeType(resolved);
      if (_fcMime.startsWith('image/')) {
        res.writeHead(200, {
          'Content-Type': _fcMime,
          ...(corsOrigin ? { 'Access-Control-Allow-Origin': corsOrigin } : {}),
        });
        res.end(fs.readFileSync(resolved));
        return true;
      }
      const content = fs.readFileSync(resolved, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        ...(corsOrigin ? { 'Access-Control-Allow-Origin': corsOrigin } : {}),
      });
      res.end(content);
    } catch (_) {
      res.writeHead(500);
      res.end('Internal error');
    }
    return true;
  }

  // DELETE /api/orgs/:name — delete an org config and all associated data files
  if (req.method === 'DELETE' && url.match(/^\/api\/orgs\/[a-z0-9][a-z0-9_-]{0,63}(\?.*)?$/i)) {
    try {
      const orgName = decodeURIComponent(url.split('/')[3].split('?')[0]);
      if (orgName.length > 64 || !/^[a-z0-9][a-z0-9_-]*$/i.test(orgName)) {
        res.writeHead(400);
        res.end('Invalid org name');
        return true;
      }
      const _delOrgQs = new URL(req.url, 'http://localhost').searchParams;
      const orgsDir = path.join(
        path.resolve(_delOrgQs.get('dir') || ctx.projectDir || process.cwd()),
        '.monomind',
        'orgs',
      );
      const configFile = path.join(orgsDir, `${orgName}.json`);
      const v1ConfigFile = path.join(orgsDir, `${orgName}.v1.json`);
      if (!fs.existsSync(configFile) && !fs.existsSync(v1ConfigFile)) {
        res.writeHead(404);
        res.end('{"error":"org not found"}');
        return true;
      }
      // Remove all org-associated files (config + state + data)
      try {
        if (fs.existsSync(v1ConfigFile)) fs.unlinkSync(v1ConfigFile);
      } catch (_) {}
      const suffixes = [
        '',
        '-state',
        '-goals',
        '-routines',
        '-approvals',
        '-activity',
        '-issues',
        '-members',
        '-projects',
        '-workspaces',
        '-worktrees',
        '-environments',
        '-plugins',
        '-adapters',
        '-budgets',
        '-threads',
        '-secrets',
        '-join-requests',
        '-bootstrap',
        '-project-workspaces',
        '-approval-comments',
        '-skills',
      ];
      for (const suf of suffixes) {
        const f = path.join(orgsDir, `${orgName}${suf}.json`);
        try {
          if (fs.existsSync(f)) fs.unlinkSync(f);
        } catch (_) {}
        const fjsonl = path.join(orgsDir, `${orgName}${suf}.jsonl`);
        try {
          if (fs.existsSync(fjsonl)) fs.unlinkSync(fjsonl);
        } catch (_) {}
      }
      // Remove stop file if present
      try {
        fs.unlinkSync(path.join(orgsDir, '.stops', `${orgName}.stop`));
      } catch (_) {}
      // Remove org subdirectory under .monomind/orgs/ (legacy flat-file location)
      try {
        const orgWorkDir = path.join(orgsDir, orgName);
        if (fs.existsSync(orgWorkDir)) fs.rmSync(orgWorkDir, { recursive: true, force: true });
      } catch (_) {}
      // Remove org subdirectory under git-safe location (.git/monomind/orgs/<name>/) so run
      // files written by the worktree-aware path (feat 880f034e) are also cleaned up on delete
      try {
        const _delWorkDir = path.resolve(_delOrgQs.get('dir') || ctx.projectDir || process.cwd());
        const _delGitMonoDir = ctx._getGitMonomindDir(_delWorkDir);
        if (_delGitMonoDir) {
          const gitOrgDir = path.join(_delGitMonoDir, 'orgs', orgName);
          if (fs.existsSync(gitOrgDir)) fs.rmSync(gitOrgDir, { recursive: true, force: true });
        }
      } catch (_) {}
      // Remove loop prompt file if present (created for scheduled orgs by createorg)
      try {
        const lpf = path.join(
          path.resolve(ctx.projectDir || process.cwd()),
          '.monomind',
          'loops',
          `${orgName}.md`,
        );
        if (fs.existsSync(lpf)) fs.unlinkSync(lpf);
      } catch (_) {}
      // Emit org:delete event
      const deleteEvent = { type: 'org:delete', org: orgName, ts: Date.now() };
      ctx
        .appendToFile(
          path.join(ctx.projectDir || process.cwd(), 'data', 'mastermind-events.jsonl'),
          `${JSON.stringify(deleteEvent)}\n`,
        )
        .catch(() => {});
      ctx.broadcastMm(deleteEvent);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        ...(corsOrigin ? { 'Access-Control-Allow-Origin': corsOrigin } : {}),
      });
      res.end('{"ok":true}');
    } catch (_) {
      res.writeHead(500);
      res.end('{}');
    }
    return true;
  }

  // POST /api/orgs/:name/stop — send stop signal to a running org
  if (req.method === 'POST' && url.match(/^\/api\/orgs\/[a-z0-9][a-z0-9_-]{0,63}\/stop$/i)) {
    try {
      const orgName = decodeURIComponent(url.split('/')[3]);
      if (orgName.length > 64 || !/^[a-z0-9][a-z0-9_-]*$/i.test(orgName)) {
        res.writeHead(400);
        res.end('Invalid org name');
        return true;
      }
      const _stopOrgQs = new URL(req.url, 'http://localhost').searchParams;
      const _stopOrgBase = path.resolve(_stopOrgQs.get('dir') || ctx.projectDir || process.cwd());
      const stopEvent = { type: 'org:stop', org: orgName, ts: Date.now() };
      const dataDir = path.join(_stopOrgBase, 'data');
      try {
        fs.mkdirSync(dataDir, { recursive: true });
      } catch (_) {}
      ctx
        .appendToFile(
          path.join(dataDir, 'mastermind-events.jsonl'),
          `${JSON.stringify(stopEvent)}\n`,
        )
        .catch(() => {});
      // Write stop marker file at the path the REAL stop mechanisms poll:
      // `org run`'s own poll loop and `org serve`'s pollStopfiles() both watch
      // .monomind/orgs/<name>/stop (see clearStopfile/stopAction/pollStopfiles in
      // commands/org.ts) — NOT .monomind/orgs/.stops/<name>.stop, which nothing
      // in the CLI/daemon ever reads.
      try {
        const stopDir = path.join(_stopOrgBase, '.monomind', 'orgs', orgName);
        fs.mkdirSync(stopDir, { recursive: true });
        fs.writeFileSync(path.join(stopDir, 'stop'), new Date().toISOString());
      } catch (_) {}
      ctx.broadcastMm(stopEvent);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        ...(corsOrigin ? { 'Access-Control-Allow-Origin': corsOrigin } : {}),
      });
      res.end('{"ok":true}');
    } catch (_) {
      res.writeHead(500);
      res.end('{}');
    }
    return true;
  }

  // POST /api/orgs/:name/copy — copy org config to another project directory
  if (req.method === 'POST' && url.match(/^\/api\/orgs\/[a-z0-9][a-z0-9_-]{0,63}\/copy$/i)) {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 2097152) {
        req.destroy();
        break;
      }
    }
    try {
      const orgName = decodeURIComponent(url.split('/')[3]);
      if (orgName.length > 64 || !/^[a-z0-9][a-z0-9_-]*$/i.test(orgName)) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid org name' }));
        return true;
      }
      let payload = {};
      try {
        payload = JSON.parse(body);
      } catch (_) {}
      const destination = payload.destination ? String(payload.destination).trim() : '';
      if (!destination) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'destination is required' }));
        return true;
      }
      if (!path.isAbsolute(destination)) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'destination must be an absolute path' }));
        return true;
      }
      const _copyOrgQs = new URL(req.url, 'http://localhost').searchParams;
      const srcOrgsDir = path.join(
        path.resolve(_copyOrgQs.get('dir') || ctx.projectDir || process.cwd()),
        '.monomind',
        'orgs',
      );
      const srcFile = path.join(srcOrgsDir, `${orgName}.json`);
      if (!fs.existsSync(srcFile)) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'org not found' }));
        return true;
      }
      const destOrgsDir = path.join(path.resolve(destination), '.monomind', 'orgs');
      try {
        fs.mkdirSync(destOrgsDir, { recursive: true });
      } catch (_) {}
      const destFile = path.join(destOrgsDir, `${orgName}.json`);
      fs.copyFileSync(srcFile, destFile);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        ...(corsOrigin ? { 'Access-Control-Allow-Origin': corsOrigin } : {}),
      });
      res.end(JSON.stringify({ ok: true, destFile }));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: String(e.message || e) }));
    }
    return true;
  }

  // GET /api/org/:name/runs — list structured run files for an org
  if (req.method === 'GET' && /^\/api\/org\/[a-z0-9][a-z0-9_-]{0,63}\/runs(\?.*)?$/i.test(url)) {
    try {
      const _rQs = new URL(req.url, 'http://localhost').searchParams;
      const _rOrgName = decodeURIComponent(url.split('/')[3] || '');
      if (_rOrgName.length > 64 || !/^[a-z0-9][a-z0-9_-]*$/i.test(_rOrgName)) {
        res.writeHead(400);
        res.end('{"error":"Invalid org name"}');
        return true;
      }
      const _rExplicitDir = _rQs.get('dir');
      const _rServerRoot = path.resolve(_rExplicitDir || ctx.projectDir || process.cwd());
      // Search across known projects (same logic as /api/orgs) unless explicit dir given
      const _rProjDirs = new Set([_rServerRoot]);
      if (!_rExplicitDir) {
        try {
          const _rKnown = JSON.parse(
            fs.readFileSync(path.join(_rServerRoot, 'data', 'known-projects.json'), 'utf8'),
          );
          _rKnown.forEach((p) => _rProjDirs.add(p));
        } catch (_) {}
      }
      const _rSeenFiles = new Set();
      const runs = [];
      const _parseRun = (filePath, f) => {
        try {
          const raw = fs.readFileSync(filePath, 'utf8');
          const allLines = raw.split('\n').filter(Boolean);
          const parse = (l) => {
            try {
              return JSON.parse(l);
            } catch {
              return null;
            }
          };
          // Merge .warm.jsonl (promoted pre-complete events) for accurate event count + metadata
          const warmFile = filePath.replace(/\.jsonl$/, '.warm.jsonl');
          let warmLines = [];
          let warmEvents = [];
          try {
            if (fs.existsSync(warmFile)) {
              warmLines = fs.readFileSync(warmFile, 'utf8').split('\n').filter(Boolean);
              warmEvents = warmLines.map(parse).filter(Boolean);
            }
          } catch (_) {}
          const combinedLines = [...warmLines, ...allLines];
          const eventCount = combinedLines.length;
          const headEvents = (
            warmEvents.length ? warmEvents : allLines.map(parse).filter(Boolean)
          ).slice(0, 10);
          const _tailEvents = allLines.map(parse).filter(Boolean).slice(-5).length
            ? allLines.map(parse).filter(Boolean).slice(-5)
            : warmEvents.slice(-5);
          const first = headEvents.find((e) => e.type === 'run:start') || headEvents[0];
          const last = [...warmEvents.slice(-5), ...allLines.map(parse).filter(Boolean).slice(-3)]
            .slice()
            .reverse()
            .find((e) => e.type === 'run:complete' || e.type === 'org:complete');
          const cycles = combinedLines.filter((l) => l.includes('"org:checkpoint"')).length;
          const lastEvent =
            allLines.map(parse).filter(Boolean).slice(-1)[0] || warmEvents.slice(-1)[0];
          const ageMs = lastEvent?.ts ? Date.now() - lastEvent.ts : Infinity;
          const isStale = !last && ageMs > 30 * 60 * 1000;
          const firstBossComms = headEvents.find(
            (e) => e.type === 'org:comms' && (e.from === 'boss' || e.role === 'boss') && e.msg,
          );
          const derivedGoal = first?.goal || firstBossComms?.msg?.slice(0, 80) || '';
          return {
            runId: f.replace(/\.warm\.jsonl$|\.jsonl$/, ''),
            startedAt: first?.ts || 0,
            endedAt: last?.ts || 0,
            status: last ? 'complete' : isStale ? 'stale' : 'running',
            eventCount,
            cycleCount: cycles,
            goal: derivedGoal,
            bossRole: first?.bossRole || '',
          };
        } catch (_) {
          return null;
        }
      };
      // Org Runtime v2 (#238): each run's raw BusEvents live under a
      // per-run directory named for the run itself — orgs/<org>/<runId>/bus.jsonl
      // — never the flat orgs/<org>/runs/<runId>.jsonl layout _parseRun above
      // expects. Translate through the same translate()/companionEvents()
      // forwarder.ts uses for the live view, so historical and live event
      // shapes always match.
      const _parseV2RunDir = (orgDir, runId) => {
        try {
          const busFile = path.join(orgDir, runId, 'bus.jsonl');
          if (!fs.existsSync(busFile)) return null;
          const raw = fs
            .readFileSync(busFile, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((l) => {
              try {
                return JSON.parse(l);
              } catch {
                return null;
              }
            })
            .filter(Boolean);
          if (!raw.length) return null;
          const translated = raw.flatMap((e) => [...companionEvents(e), translate(e)]);
          const done = translated.find(
            (e) => e.type === 'session:complete' || e.type === 'org:complete',
          );
          const start = translated.find((e) => e.type === 'org:start');
          const firstComms = translated.find((e) => e.type === 'org:comms' && e.msg);
          return {
            runId,
            startedAt: raw[0]?.ts || 0,
            endedAt: done?.ts || 0,
            status: done ? 'complete' : 'running',
            eventCount: raw.length,
            cycleCount: translated.filter((e) => e.type === 'org:checkpoint').length,
            goal: start?.goal || firstComms?.msg?.slice(0, 80) || '',
            bossRole: '',
          };
        } catch (_) {
          return null;
        }
      };
      for (const _rpd of _rProjDirs) {
        // Check both .monomind and .git/monomind locations
        const _rMonoDir = ctx._getGitMonomindDir(_rpd) || path.join(_rpd, '.monomind');
        const _rOrgDirs = [path.join(_rMonoDir, 'orgs', _rOrgName)];
        if (_rMonoDir !== path.join(_rpd, '.monomind'))
          _rOrgDirs.push(path.join(_rpd, '.monomind', 'orgs', _rOrgName));
        for (const _rOrgDir of _rOrgDirs) {
          if (!fs.existsSync(_rOrgDir)) continue;
          const runDirs = fs
            .readdirSync(_rOrgDir)
            .filter(
              (d) => d.startsWith('run-') && fs.statSync(path.join(_rOrgDir, d)).isDirectory(),
            )
            .sort()
            .reverse();
          for (const runId of runDirs.slice(0, 50)) {
            if (_rSeenFiles.has(runId)) continue;
            const r = _parseV2RunDir(_rOrgDir, runId);
            if (!r) continue;
            _rSeenFiles.add(runId);
            runs.push(r);
          }
        }
        const _rSearchDirs = [path.join(_rMonoDir, 'orgs', _rOrgName, 'runs')];
        if (_rMonoDir !== path.join(_rpd, '.monomind'))
          _rSearchDirs.push(path.join(_rpd, '.monomind', 'orgs', _rOrgName, 'runs'));
        for (const _rDir of _rSearchDirs) {
          if (!fs.existsSync(_rDir)) continue;
          // Include .warm.jsonl — completed runs are renamed hot→warm on org:complete and
          // must stay visible in the chat history dropdown.
          const files = fs
            .readdirSync(_rDir)
            .filter(
              (f) =>
                f.endsWith('.jsonl') &&
                !f.startsWith('._') &&
                !f.endsWith('.convs.jsonl') &&
                !f.endsWith('.cold.jsonl'),
            )
            .sort()
            .reverse();
          for (const f of files.slice(0, 50)) {
            const _rFileId = f.replace(/\.warm\.jsonl$|\.jsonl$/, '');
            if (_rSeenFiles.has(_rFileId)) continue;
            _rSeenFiles.add(_rFileId);
            const r = _parseRun(path.join(_rDir, f), f);
            if (r) runs.push(r);
          }
        }
      }
      runs.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
      // Threads fallback: if no run files found, synthesize a run from the org threads file
      // so orgs whose boss never emitted runId-tagged events still show in the chat dropdown.
      if (runs.length === 0) {
        for (const _rpd of _rProjDirs) {
          const _tf = path.join(_rpd, '.monomind', 'orgs', `${_rOrgName}-threads.jsonl`);
          if (!fs.existsSync(_tf)) continue;
          const _tLines = fs.readFileSync(_tf, 'utf8').split('\n').filter(Boolean);
          if (!_tLines.length) continue;
          const _tEvs = _tLines
            .map((l) => {
              try {
                return JSON.parse(l);
              } catch {
                return null;
              }
            })
            .filter(Boolean);
          if (!_tEvs.length) continue;
          const _firstTs = _tEvs[0].ts
            ? typeof _tEvs[0].ts === 'number'
              ? _tEvs[0].ts
              : new Date(_tEvs[0].ts).getTime()
            : Date.now();
          const _lastTs = _tEvs[_tEvs.length - 1].ts
            ? typeof _tEvs[_tEvs.length - 1].ts === 'number'
              ? _tEvs[_tEvs.length - 1].ts
              : new Date(_tEvs[_tEvs.length - 1].ts).getTime()
            : _firstTs;
          runs.push({
            id: `threads-${_rOrgName}`,
            orgName: _rOrgName,
            goal: `${_rOrgName} threads`,
            status: 'complete',
            startedAt: _firstTs,
            endedAt: _lastTs,
            eventCount: _tEvs.length,
            _threadsFile: _tf,
          });
          break;
        }
      }
      res.writeHead(200, {
        'Content-Type': 'application/json',
        ...(corsOrigin ? { 'Access-Control-Allow-Origin': corsOrigin } : {}),
        'Cache-Control': 'no-cache',
      });
      res.end(JSON.stringify(runs));
    } catch (_) {
      res.writeHead(500);
      res.end('[]');
    }
    return true;
  }

  // GET /api/org/:name/runs/:runId — get all events for a specific run
  if (
    req.method === 'GET' &&
    /^\/api\/org\/[a-z0-9][a-z0-9_-]{0,63}\/runs\/[a-z0-9][a-z0-9_-]{0,79}(\?.*)?$/i.test(url)
  ) {
    try {
      const _rvQs = new URL(req.url, 'http://localhost').searchParams;
      const _rvParts = url.replace(/\?.*$/, '').split('/');
      const _rvOrgName = decodeURIComponent(_rvParts[3] || '');
      const _rvRunId = decodeURIComponent(_rvParts[5] || '');
      if (
        _rvOrgName.length > 64 ||
        !/^[a-z0-9][a-z0-9_-]*$/i.test(_rvOrgName) ||
        _rvRunId.length > 80 ||
        !/^[a-z0-9][a-z0-9_-]*$/i.test(_rvRunId)
      ) {
        res.writeHead(400);
        res.end('{"error":"Invalid org or run id"}');
        return true;
      }
      const _rvExplicitDir = _rvQs.get('dir');
      const _rvServerRoot = path.resolve(_rvExplicitDir || ctx.projectDir || process.cwd());
      // Threads fallback: threads-${orgName} is a synthetic runId served from threads file
      if (_rvRunId === `threads-${_rvOrgName}`) {
        const _rvProjDirsT = new Set([_rvServerRoot]);
        if (!_rvExplicitDir) {
          try {
            JSON.parse(
              fs.readFileSync(path.join(_rvServerRoot, 'data', 'known-projects.json'), 'utf8'),
            ).forEach((p) => _rvProjDirsT.add(p));
          } catch (_) {}
        }
        for (const _rvpd of _rvProjDirsT) {
          const _tf = path.join(_rvpd, '.monomind', 'orgs', `${_rvOrgName}-threads.jsonl`);
          if (!fs.existsSync(_tf)) continue;
          const _tLines = fs.readFileSync(_tf, 'utf8').split('\n').filter(Boolean);
          const _tEvs = _tLines
            .map((l) => {
              try {
                const e = JSON.parse(l);
                return {
                  type: 'org:comms',
                  from: e.role || e.from || 'agent',
                  to: e.to || 'all',
                  msg: e.message || e.msg || '',
                  ts: e.ts
                    ? typeof e.ts === 'number'
                      ? e.ts
                      : new Date(e.ts).getTime()
                    : Date.now(),
                  org: _rvOrgName,
                  runId: _rvRunId,
                };
              } catch {
                return null;
              }
            })
            .filter(Boolean);
          res.writeHead(200, {
            'Content-Type': 'application/json',
            ...(corsOrigin ? { 'Access-Control-Allow-Origin': corsOrigin } : {}),
          });
          res.end(JSON.stringify(_tEvs));
          return true;
        }
        res.writeHead(404);
        res.end('{"error":"threads file not found"}');
        return true;
      }
      // Search across known projects
      const _rvProjDirs = new Set([_rvServerRoot]);
      if (!_rvExplicitDir) {
        try {
          JSON.parse(
            fs.readFileSync(path.join(_rvServerRoot, 'data', 'known-projects.json'), 'utf8'),
          ).forEach((p) => _rvProjDirs.add(p));
        } catch (_) {}
      }
      // Org Runtime v2 (#238): try the per-run-directory bus.jsonl layout
      // first — orgs/<org>/<runId>/bus.jsonl — translated to the same
      // dashboard vocabulary the live view gets from forwarder.ts, before
      // falling back to the v1 flat orgs/<org>/runs/<runId>.jsonl lookup
      // below (v1 files are already stored pre-translated).
      for (const _rvpd of _rvProjDirs) {
        const _rvMonoDir = ctx._getGitMonomindDir(_rvpd) || path.join(_rvpd, '.monomind');
        const _v2Candidates = [path.join(_rvMonoDir, 'orgs', _rvOrgName, _rvRunId, 'bus.jsonl')];
        if (_rvMonoDir !== path.join(_rvpd, '.monomind'))
          _v2Candidates.push(
            path.join(_rvpd, '.monomind', 'orgs', _rvOrgName, _rvRunId, 'bus.jsonl'),
          );
        for (const _v2File of _v2Candidates) {
          if (!fs.existsSync(_v2File)) continue;
          const raw = fs
            .readFileSync(_v2File, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((l) => {
              try {
                return JSON.parse(l);
              } catch {
                return null;
              }
            })
            .filter(Boolean);
          const events = raw.flatMap((e) => [...companionEvents(e), translate(e)]);
          events.sort((a, b) => (a.ts || 0) - (b.ts || 0));
          res.writeHead(200, {
            'Content-Type': 'application/json',
            ...(corsOrigin ? { 'Access-Control-Allow-Origin': corsOrigin } : {}),
            'Cache-Control': 'no-cache',
          });
          res.end(JSON.stringify(events));
          return true;
        }
      }
      let _rvFile = null;
      for (const _rvpd of _rvProjDirs) {
        const _rvMonoDir = ctx._getGitMonomindDir(_rvpd) || path.join(_rvpd, '.monomind');
        const _candidates = [
          path.join(_rvMonoDir, 'orgs', _rvOrgName, 'runs', `${_rvRunId}.jsonl`),
          path.join(_rvMonoDir, 'orgs', _rvOrgName, 'runs', `${_rvRunId}.warm.jsonl`),
        ];
        if (_rvMonoDir !== path.join(_rvpd, '.monomind')) {
          _candidates.push(
            path.join(_rvpd, '.monomind', 'orgs', _rvOrgName, 'runs', `${_rvRunId}.jsonl`),
          );
          _candidates.push(
            path.join(_rvpd, '.monomind', 'orgs', _rvOrgName, 'runs', `${_rvRunId}.warm.jsonl`),
          );
        }
        for (const c of _candidates) {
          if (fs.existsSync(c)) {
            _rvFile = c;
            break;
          }
        }
        if (_rvFile) break;
      }
      if (!_rvFile) {
        res.writeHead(404);
        res.end('{"error":"run not found"}');
        return true;
      }
      const _parseLines = (p) => {
        try {
          return fs
            .readFileSync(p, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((l) => {
              try {
                return JSON.parse(l);
              } catch {
                return null;
              }
            })
            .filter(Boolean);
        } catch {
          return [];
        }
      };
      const events = _parseLines(_rvFile);
      // Merge .warm.jsonl (pre-run:complete events, including org:comms) if it exists.
      // When run:complete fires, the hot .jsonl is renamed to .warm.jsonl so all pre-complete
      // events live there. The current .jsonl then only holds post-complete events (e.g. org:stop).
      const _rvWarmFile = _rvFile.endsWith('.warm.jsonl')
        ? _rvFile
        : _rvFile.replace(/\.jsonl$/, '.warm.jsonl');
      if (_rvWarmFile !== _rvFile && fs.existsSync(_rvWarmFile)) {
        events.push(..._parseLines(_rvWarmFile));
      }
      // For in-progress runs (no .warm.jsonl), org:comms also go to .convs.jsonl (stripped form).
      // They're already in .jsonl as full events, so .convs.jsonl would duplicate — skip it.
      events.sort((a, b) => (a.ts || 0) - (b.ts || 0));
      res.writeHead(200, {
        'Content-Type': 'application/json',
        ...(corsOrigin ? { 'Access-Control-Allow-Origin': corsOrigin } : {}),
        'Cache-Control': 'no-cache',
      });
      res.end(JSON.stringify(events));
    } catch (_) {
      res.writeHead(500);
      res.end('[]');
    }
    return true;
  }

  // GET /api/org/:name/artifact — serve file content for chat "View" button
  if (req.method === 'GET' && /^\/api\/org\/[^/]+\/artifact/.test(url)) {
    try {
      const _artOrgName = decodeURIComponent(url.split('/')[3] || '');
      if (_artOrgName.length > 64 || !/^[a-z0-9][a-z0-9_-]*$/i.test(_artOrgName)) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid org name' }));
        return true;
      }
      const _artQp = new URL(`http://x${req.url}`).searchParams;
      const _rawPath = _artQp.get('path');
      if (!_rawPath) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'path required' }));
        return true;
      }
      const _filePath = path.resolve(decodeURIComponent(_rawPath));
      // Security: this endpoint used to allow reads anywhere under the project
      // root or any data/known-projects.json entry — letting any dashboard
      // client read .env, .git/config, or other arbitrary project files.
      // Restrict it, like /api/file-content above, to this org's own
      // .monomind/orgs/<name>/ directory — never outside .monomind.
      const _artBaseDir = path.resolve(_artQp.get('dir') || ctx.projectDir || process.cwd());
      const _artProjDir = ctx._resolveOrgProjectDir(_artOrgName, _artBaseDir) || _artBaseDir;
      const _artMonoDir =
        ctx._getGitMonomindDir(_artProjDir) || path.join(_artProjDir, '.monomind');
      const _artOrgDir = path.join(_artMonoDir, 'orgs', _artOrgName);
      const _safe = _filePath === _artOrgDir || _filePath.startsWith(_artOrgDir + path.sep);
      if (!_safe) {
        res.writeHead(403);
        res.end(JSON.stringify({ error: 'path not allowed' }));
        return true;
      }
      if (!fs.existsSync(_filePath)) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'file not found' }));
        return true;
      }
      const _mime = ctx._detectMimeType(_filePath);
      const _size = fs.statSync(_filePath).size;
      // Reject files >2MB to avoid blocking the event loop
      if (_size > 2 * 1024 * 1024) {
        res.writeHead(413);
        res.end(JSON.stringify({ error: 'file too large', size: _size }));
        return true;
      }
      if (!_mime.startsWith('text/') && _mime !== 'application/json') {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          ...(corsOrigin ? { 'Access-Control-Allow-Origin': corsOrigin } : {}),
        });
        res.end(JSON.stringify({ binary: true, mimeType: _mime, size: _size }));
        return true;
      }
      const _content = fs.readFileSync(_filePath, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'application/json',
        ...(corsOrigin ? { 'Access-Control-Allow-Origin': corsOrigin } : {}),
      });
      res.end(JSON.stringify({ content: _content, mimeType: _mime, size: _size }));
    } catch (_e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'read failed' }));
    }
    return true;
  }

  // ------------------------------------------------- Mastermind event system
  // POST /api/mastermind/event — ingest event from mastermind skill
  if (req.method === 'POST' && url === '/api/mastermind/event') {
    await ctx.handleMastermindEvent(req, res, corsOrigin);
    return true;
  }

  // GET /api/mastermind-stream — SSE for real-time events
  if (req.method === 'GET' && url === '/api/mastermind-stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      ...(corsOrigin ? { 'Access-Control-Allow-Origin': corsOrigin } : {}),
    });
    res.write(': connected\n\n');
    ctx.addMmClient(res);
    // Replay last 50 events from disk (use ?project= param if provided)
    try {
      const _sseQp = new URL(`http://x${req.url}`).searchParams;
      const _sseProj = _sseQp.get('project');
      const root2 = _sseProj || ctx.projectDir || process.cwd();
      const evFile = path.join(root2, 'data', 'mastermind-events.jsonl');
      const lines = fs.readFileSync(evFile, 'utf8').trim().split('\n').filter(Boolean).slice(-50);
      for (const l of lines) res.write(`data: ${l}\n\n`);
    } catch (_) {}
    const ka = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch (_) {
        clearInterval(ka);
        ctx.removeMmClient(res);
      }
    }, 20000);
    req.on('close', () => {
      ctx.removeMmClient(res);
      clearInterval(ka);
    });
    return true;
  }

  // GET /api/mastermind/sessions
  if (req.method === 'GET' && url.startsWith('/api/mastermind/sessions')) {
    try {
      const qp = new URL(`http://x${req.url}`).searchParams;
      const filterProject = qp.get('project');
      const limitParam = Math.min(parseInt(qp.get('limit') || '200', 10) || 200, 500);
      const serverRoot = ctx.projectDir || process.cwd();
      // Collect all project dirs to aggregate
      const projectDirs = new Set([serverRoot]);
      try {
        const known = JSON.parse(
          fs.readFileSync(path.join(serverRoot, 'data', 'known-projects.json'), 'utf8'),
        );
        known.forEach((p) => projectDirs.add(p));
      } catch (_) {}
      let allSessions = [];
      for (const pd of projectDirs) {
        if (filterProject && pd !== filterProject) continue;
        const sessDir = path.join(pd, 'data', 'sessions');
        const indexFile = path.join(sessDir, '_index.json');
        // ── New format: per-session JSONL + _index.json ──
        if (fs.existsSync(indexFile)) {
          try {
            const idx = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
            const top = idx.slice(0, limitParam);
            for (const entry of top) {
              const _sid = String(entry.id || '').trim();
              if (!_sid || !ctx.SESSION_ID_RE.test(_sid)) continue;
              let events = [];
              try {
                const jl = fs.readFileSync(path.join(sessDir, `${_sid}.jsonl`), 'utf8');
                events = jl
                  .trim()
                  .split('\n')
                  .filter(Boolean)
                  .map((l) => {
                    try {
                      return JSON.parse(l);
                    } catch {
                      return null;
                    }
                  })
                  .filter(Boolean);
              } catch (_) {}
              allSessions.push({ ...entry, events, project: pd });
            }
          } catch (_) {}
        } else {
          // ── Legacy fallback: mastermind-sessions.json ──
          const f = path.join(pd, 'data', 'mastermind-sessions.json');
          if (fs.existsSync(f)) {
            try {
              const s = JSON.parse(fs.readFileSync(f, 'utf8'));
              s.forEach((sess) => {
                if (!sess.project) sess.project = pd;
              });
              allSessions = allSessions.concat(s);
            } catch (_) {}
          }
        }
      }
      allSessions.sort((a, b) => (b.ts || b.startedAt || 0) - (a.ts || a.startedAt || 0));
      res.writeHead(200, {
        'Content-Type': 'application/json',
        ...(corsOrigin ? { 'Access-Control-Allow-Origin': corsOrigin } : {}),
      });
      res.end(JSON.stringify(allSessions.slice(0, limitParam)));
    } catch (_) {
      res.writeHead(200);
      res.end('[]');
    }
    return true;
  }

  // GET /api/mastermind/session/:id/trace — human-readable markdown trace
  if (req.method === 'GET' && url.match(/^\/api\/mastermind\/session\/[^/]+\/trace$/)) {
    try {
      const sid = url.split('/')[4];
      const sessFile = path.join(
        ctx.projectDir || process.cwd(),
        'data',
        'sessions',
        `${sid}.json`,
      );
      let s = null;
      if (fs.existsSync(sessFile)) {
        s = JSON.parse(fs.readFileSync(sessFile, 'utf8'));
      } else {
        const f = path.join(ctx.projectDir || process.cwd(), 'data', 'mastermind-sessions.json');
        const sessions = JSON.parse(fs.readFileSync(f, 'utf8'));
        s = sessions.find((x) => x.id === sid);
      }
      if (!s) {
        res.writeHead(404);
        res.end('Session not found');
        return true;
      }
      const fmt = (ts) => `${new Date(ts).toISOString().replace('T', ' ').slice(0, 19)} UTC`;
      const lines = [
        `# Mastermind Session Trace: ${s.id}`,
        ``,
        `**Prompt:** ${s.prompt || '(none)'}`,
        `**Status:** ${s.status}`,
        `**Started:** ${fmt(s.ts)}`,
        s.endTs ? `**Ended:** ${fmt(s.endTs)}` : '',
        `**Domains:** ${(s.domains || []).join(', ') || '(none yet)'}`,
        ``,
      ];
      for (const ev of s.events || []) {
        const t = fmt(ev.ts);
        if (ev.type === 'session:start')
          lines.push(`\`${t}\` **SESSION START** — prompt: "${ev.prompt || ''}"`);
        else if (ev.type === 'domain:dispatch')
          lines.push(`\`${t}\` **DOMAIN DISPATCH** → \`${ev.domain}\` — ${ev.cmd || ''}`);
        else if (ev.type === 'agent:spawn')
          lines.push(
            `\`${t}\` **AGENT SPAWN** [\`${ev.domain}\`] → agent: \`${ev.agent}\` — ${ev.task || ''}`,
          );
        else if (ev.type === 'intercom')
          lines.push(`\`${t}\` **INTERCOM** \`${ev.from}\` → \`${ev.to}\`: ${ev.msg || ''}`);
        else if (ev.type === 'domain:complete')
          lines.push(
            `\`${t}\` **DOMAIN COMPLETE** [\`${ev.domain}\`] status: ${ev.status}${ev.artifacts?.length ? ` — artifacts: ${ev.artifacts.join(', ')}` : ''}`,
          );
        else if (ev.type === 'session:complete')
          lines.push(
            `\`${t}\` **SESSION COMPLETE** — status: ${ev.status}, domains: ${(ev.domains || []).join(', ')}`,
          );
        else lines.push(`\`${t}\` ${ev.type} ${JSON.stringify(ev)}`);
      }
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        ...(corsOrigin ? { 'Access-Control-Allow-Origin': corsOrigin } : {}),
      });
      res.end(lines.join('\n'));
    } catch (_) {
      res.writeHead(500);
      res.end('Error');
    }
    return true;
  }

  // GET /api/mastermind/session/:id
  if (req.method === 'GET' && url.startsWith('/api/mastermind/session/')) {
    try {
      const sid = url.slice('/api/mastermind/session/'.length);
      // Check individual session file first
      const sessFile = path.join(
        ctx.projectDir || process.cwd(),
        'data',
        'sessions',
        `${sid}.json`,
      );
      if (fs.existsSync(sessFile)) {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          ...(corsOrigin ? { 'Access-Control-Allow-Origin': corsOrigin } : {}),
        });
        res.end(fs.readFileSync(sessFile, 'utf8'));
        return true;
      }
      const f = path.join(ctx.projectDir || process.cwd(), 'data', 'mastermind-sessions.json');
      const sessions = JSON.parse(fs.readFileSync(f, 'utf8'));
      const s = sessions.find((x) => x.id === sid);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        ...(corsOrigin ? { 'Access-Control-Allow-Origin': corsOrigin } : {}),
      });
      res.end(JSON.stringify(s || null));
    } catch (_) {
      res.writeHead(200);
      res.end('null');
    }
    return true;
  }

  // -------------------------------------------------------- GET /mastermind
  if (req.method === 'GET' && url === '/mastermind') {
    // Serve local file if present (dev), otherwise fall back to bundled HTML
    const root = ctx.projectDir || process.cwd();
    const htmlPath = path.join(root, 'docs', 'mastermind-diagram.html');
    let html = ctx.MASTERMIND_DIAGRAM_HTML;
    try {
      html = fs.readFileSync(htmlPath, 'utf8');
    } catch (_) {}
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return true;
  }

  // ----------------------------------------------------------- GET /orgs
  if (req.method === 'GET' && url === '/orgs') {
    try {
      const htmlPath = path.join(ctx.__dirname, 'orgs.html');
      let html = fs.readFileSync(htmlPath, 'utf8');
      // Inject this process's auth credential the same way GET / does for
      // dashboard.html — orgs.html's fetch() calls hit the same now
      // default-closed /api/* routes and need a way to know the token.
      html = html.replace(
        '<head>',
        `<head>\n<meta name="mm-token" content="${ctx.dashboardAuthValue}">`,
      );
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      });
      res.end(html);
    } catch (err) {
      res.writeHead(404);
      res.end(`orgs.html not found: ${err.message}`);
    }
    return true;
  }

  // ------------------------------------------------ GET /orgs-files.js
  // Files-tab + diff-view script, split out of orgs.html (see orgs.html's
  // script-src comment). Not a generic static handler — this UI serves each
  // sibling asset via its own hardcoded route, same as GET /orgs above.
  if (req.method === 'GET' && url === '/orgs-files.js') {
    try {
      const jsPath = path.join(ctx.__dirname, 'orgs-files.js');
      const js = fs.readFileSync(jsPath, 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      res.end(js);
    } catch (err) {
      res.writeHead(404);
      res.end(`orgs-files.js not found: ${err.message}`);
    }
    return true;
  }

  // GET /api/mastermind/loops — list all active loop state files
  if (req.method === 'GET' && url === '/api/mastermind/loops') {
    try {
      const loopsDir = path.join(ctx.projectDir || process.cwd(), '.monomind', 'loops');
      const loops = [];
      if (fs.existsSync(loopsDir)) {
        const files = fs
          .readdirSync(loopsDir)
          .filter((f) => f.endsWith('.json') && !f.includes('-hil'));
        for (const f of files) {
          try {
            const d = JSON.parse(fs.readFileSync(path.join(loopsDir, f), 'utf8'));
            loops.push(d);
          } catch (_) {}
        }
      }
      loops.sort((a, b) => (b.lastRunAt || 0) - (a.lastRunAt || 0));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ loops }));
    } catch (_) {
      res.writeHead(500);
      res.end('{"loops":[]}');
    }
    return true;
  }

  // GET /api/status — live system snapshot for dashboard polling
  if (req.method === 'GET' && url === '/api/status') {
    try {
      const root = ctx.projectDir || process.cwd();
      // Active org runs: { orgName -> runId }
      const orgRuns = {};
      ctx.activeOrgRuns.forEach((runId, org) => {
        orgRuns[org] = runId;
      });
      // Recent events (last 10)
      let recentEvents = [];
      try {
        const evPath = path.join(root, 'data', 'mastermind-events.jsonl');
        const lines = fs
          .readFileSync(evPath, 'utf8')
          .split('\n')
          .filter((l) => l.trim())
          .slice(-10);
        recentEvents = lines
          .map((l) => {
            try {
              return JSON.parse(l);
            } catch (_) {
              return null;
            }
          })
          .filter(Boolean);
      } catch (_) {}
      res.writeHead(200, {
        'Content-Type': 'application/json',
        ...(corsOrigin ? { 'Access-Control-Allow-Origin': corsOrigin } : {}),
      });
      res.end(
        JSON.stringify({
          ts: Date.now(),
          pid: process.pid,
          uptime: process.uptime(),
          dir: root,
          sseClients: getMmClientCount(),
          activeOrgs: Object.keys(orgRuns).length,
          orgRuns,
          recentEvents,
        }),
      );
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return true;
  }

  // GET /api/orgs/:name/runs/current — events from the active run file for an org
  if (req.method === 'GET' && /^\/api\/orgs\/[^/]+\/runs\/current$/.test(url)) {
    try {
      const orgName = decodeURIComponent(url.split('/')[3]);
      const _curQs = new URL(req.url, 'http://localhost').searchParams;
      const root = path.resolve(_curQs.get('dir') || ctx.projectDir || process.cwd());
      // Validate orgName
      if (!orgName || orgName.length > 64 || !/^[a-z0-9][a-z0-9_-]*$/i.test(orgName)) {
        res.writeHead(400);
        res.end('{"error":"invalid org name"}');
        return true;
      }
      const runId = ctx.activeOrgRuns.get(orgName);
      const monoDir = ctx._getGitMonomindDir(root) || path.join(root, '.monomind');
      // Try active run first, then fall back to most recent run file.
      // Org Runtime v2 (#238): the active run's own events live under
      // orgs/<org>/<runId>/bus.jsonl, never the v1 flat orgs/<org>/runs/
      // layout — check that shape (and translate it) before the v1 lookup.
      let runFile = null;
      let isV2 = false;
      if (runId) {
        const v2Candidate = path.join(monoDir, 'orgs', orgName, runId, 'bus.jsonl');
        if (fs.existsSync(v2Candidate)) {
          runFile = v2Candidate;
          isV2 = true;
        } else {
          const candidate = path.join(monoDir, 'orgs', orgName, 'runs', `${runId}.jsonl`);
          if (fs.existsSync(candidate)) runFile = candidate;
        }
      }
      if (!runFile) {
        const orgDir = path.join(monoDir, 'orgs', orgName);
        const runDirs = fs.existsSync(orgDir)
          ? fs
              .readdirSync(orgDir)
              .filter(
                (d) => d.startsWith('run-') && fs.existsSync(path.join(orgDir, d, 'bus.jsonl')),
              )
              .sort()
              .reverse()
          : [];
        if (runDirs.length) {
          runFile = path.join(orgDir, runDirs[0], 'bus.jsonl');
          isV2 = true;
        }
      }
      if (!runFile) {
        const runsDir = path.join(monoDir, 'orgs', orgName, 'runs');
        if (fs.existsSync(runsDir)) {
          const files = fs
            .readdirSync(runsDir)
            .filter((f) => f.endsWith('.jsonl') && !f.startsWith('._'));
          if (files.length) {
            files.sort();
            runFile = path.join(runsDir, files[files.length - 1]);
          }
        }
      }
      if (!runFile) {
        res.writeHead(404);
        res.end('{"events":[],"runId":null}');
        return true;
      }
      const detectedRunId = isV2
        ? path.basename(path.dirname(runFile))
        : path.basename(runFile, '.jsonl');
      const lines = fs
        .readFileSync(runFile, 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .slice(-100);
      const rawEvents = lines
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch (_) {
            return null;
          }
        })
        .filter(Boolean);
      // v1's stored events are already dashboard-native; v2's raw BusEvents
      // need the same translate()/companionEvents() pass the live view gets.
      const events = isV2
        ? rawEvents.flatMap((e) => [...companionEvents(e), translate(e)])
        : rawEvents;
      res.writeHead(200, {
        'Content-Type': 'application/json',
        ...(corsOrigin ? { 'Access-Control-Allow-Origin': corsOrigin } : {}),
      });
      res.end(
        JSON.stringify({ runId: detectedRunId, events, active: ctx.activeOrgRuns.has(orgName) }),
      );
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    }
    return true;
  }

  // GET /api/orgs/:name/history — per-run outcome summaries (history.jsonl, newest first)
  if (req.method === 'GET' && /^\/api\/orgs\/[^/]+\/history$/.test(url)) {
    try {
      const orgName = decodeURIComponent(url.split('/')[3]);
      const _histQs = new URL(req.url, 'http://localhost').searchParams;
      const root = path.resolve(_histQs.get('dir') || ctx.projectDir || process.cwd());
      if (!orgName || orgName.length > 64 || !/^[a-z0-9][a-z0-9_-]*$/i.test(orgName)) {
        res.writeHead(400);
        res.end('{"error":"invalid org name"}');
        return true;
      }
      const monoDir = ctx._getGitMonomindDir(root) || path.join(root, '.monomind');
      const histFile = path.join(monoDir, 'orgs', orgName, 'history.jsonl');
      let runs = [];
      if (fs.existsSync(histFile)) {
        runs = fs
          .readFileSync(histFile, 'utf8')
          .split('\n')
          .filter((l) => l.trim())
          .map((l) => {
            try {
              return JSON.parse(l);
            } catch (_) {
              return null;
            }
          })
          .filter(Boolean)
          .reverse()
          .slice(0, 50);
      }
      res.writeHead(200, {
        'Content-Type': 'application/json',
        ...(corsOrigin ? { 'Access-Control-Allow-Origin': corsOrigin } : {}),
      });
      res.end(JSON.stringify({ runs }));
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    }
    return true;
  }

  // GET /api/orgs/:name/memory — org knowledge-graph stats + glossary + rules
  if (req.method === 'GET' && /^\/api\/orgs\/[^/]+\/memory$/.test(url)) {
    try {
      const orgName = decodeURIComponent(url.split('/')[3]);
      const _memQs = new URL(req.url, 'http://localhost').searchParams;
      const root = path.resolve(_memQs.get('dir') || ctx.projectDir || process.cwd());
      if (!orgName || orgName.length > 64 || !/^[a-z0-9][a-z0-9_-]*$/i.test(orgName)) {
        res.writeHead(400);
        res.end('{"error":"invalid org name"}');
        return true;
      }
      const monoDir = ctx._getGitMonomindDir(root) || path.join(root, '.monomind');
      const dbPath = path.join(monoDir, 'org-memory');
      if (!fs.existsSync(dbPath)) {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          ...(corsOrigin ? { 'Access-Control-Allow-Origin': corsOrigin } : {}),
        });
        res.end(JSON.stringify({ nodes: 0, edges: 0, rules: 0, glossary: [], ruleTexts: [] }));
        return true;
      }
      const kg = await import('../memory/memory-kg.js');
      const [stats, glossary, ruleList] = await Promise.all([
        kg.kgStats({ dbPath }),
        kg.kgGlossary({ dbPath, limit: 12 }),
        kg.kgListRules({ dbPath, limit: 10 }),
      ]);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        ...(corsOrigin ? { 'Access-Control-Allow-Origin': corsOrigin } : {}),
      });
      res.end(
        JSON.stringify({
          ...stats,
          glossary,
          ruleTexts: ruleList.map((r) => r.rule.slice(0, 200)),
        }),
      );
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    }
    return true;
  }

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
