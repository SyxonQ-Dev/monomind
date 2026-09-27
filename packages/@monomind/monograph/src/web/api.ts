import { resolve } from 'node:path';
import type Database from 'better-sqlite3';
import type { Application } from 'express';
import {
  getServerInfo,
  queryCluster,
  queryClusters,
  queryGraphData,
  queryGrep,
  queryNode,
  queryProcess,
  queryProcessesList,
  querySearch,
  queryStats,
  readFileContent,
  streamGraph,
} from './api-queries.js';
import { globalJobRegistry } from './async-jobs.js';

// File-size sweep: query logic and types split into api-queries.ts. This file
// remains the entry point and re-exports everything that used to live here so
// every existing import keeps working.
export type {
  ApiEdge,
  ApiNode,
  ClusterDetail,
  ClusterSummary,
  FileContent,
  FileLine,
  GraphData,
  GrepResult,
  NodeDetail,
  ProcessSummary,
  ServerInfo,
  StatsData,
} from './api-queries.js';
export {
  getServerInfo,
  queryCluster,
  queryClusters,
  queryGraphData,
  queryGrep,
  queryNode,
  queryProcess,
  queryProcessesList,
  querySearch,
  queryStats,
  readFileContent,
  rowToApiNode,
  streamGraph,
} from './api-queries.js';

// ── Route setup ───────────────────────────────────────────────────────────────

export function setupApiRoutes(app: Application, db: Database.Database): void {
  app.get('/api/graph', (req, res) => {
    try {
      if (req.query.stream === 'true') {
        res.setHeader('Content-Type', 'application/x-ndjson');
        streamGraph(db, (record) => {
          res.write(`${JSON.stringify(record)}\n`);
        })
          .then(() => res.end())
          .catch(() => res.end());
        return;
      }
      res.json(queryGraphData(db));
    } catch (err) {
      console.error('[api error]', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.get('/api/nodes/:id', (req, res) => {
    try {
      const detail = queryNode(db, req.params.id ?? '');
      if (!detail.node) {
        res.status(404).json({ error: 'Node not found' });
        return;
      }
      res.json(detail);
    } catch (err) {
      console.error('[api error]', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.get('/api/search', (req, res) => {
    try {
      const q = (req.query.q as string | undefined) ?? '';
      if (!q.trim()) {
        res.json([]);
        return;
      }
      res.json(querySearch(db, q));
    } catch (err) {
      console.error('[api error]', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.get('/api/stats', (_req, res) => {
    try {
      res.json(queryStats(db));
    } catch (err) {
      console.error('[api error]', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.get('/api/file', (req, res) => {
    try {
      const filePath = (req.query.path as string | undefined) ?? '';
      if (!filePath) {
        res.status(400).json({ error: 'path query param required' });
        return;
      }
      // Only serve files that are indexed in the graph DB to prevent arbitrary file read.
      const resolvedPath = resolve(filePath);
      const tracked = db
        .prepare('SELECT 1 FROM nodes WHERE file_path = ? LIMIT 1')
        .get(resolvedPath);
      if (!tracked) {
        // Also accept the path as stored (may be relative or use different separators)
        const trackedRelative = db
          .prepare('SELECT 1 FROM nodes WHERE file_path = ? LIMIT 1')
          .get(filePath);
        if (!trackedRelative) {
          res.status(403).json({ error: 'File not indexed in graph' });
          return;
        }
      }
      const startLine = req.query.start ? parseInt(req.query.start as string, 10) : undefined;
      const endLine = req.query.end ? parseInt(req.query.end as string, 10) : undefined;
      if (startLine !== undefined && Number.isNaN(startLine)) {
        res.status(400).json({ error: 'start must be a positive integer' });
        return;
      }
      if (endLine !== undefined && Number.isNaN(endLine)) {
        res.status(400).json({ error: 'end must be a positive integer' });
        return;
      }
      res.json(readFileContent(resolvedPath, startLine, endLine));
    } catch (err) {
      console.error('[api/file]', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Async analyze job API
  app.post('/api/analyze', (req, res) => {
    const { repoPath, codeOnly, force } = req.body as {
      repoPath?: string;
      codeOnly?: boolean;
      force?: boolean;
    };
    if (!repoPath) {
      res.status(400).json({ error: 'repoPath is required' });
      return;
    }
    const job = globalJobRegistry.create('analyze', { repoPath });
    globalJobRegistry.update(job.id, { status: 'running' });

    import('../pipeline/orchestrator.js')
      .then(({ buildAsync }) => {
        buildAsync(repoPath, {
          codeOnly,
          force,
          onProgress: (p) => {
            globalJobRegistry.emitProgress(job.id, { phase: p.phase ?? '', message: p.message });
          },
        })
          .then(() => {
            globalJobRegistry.update(job.id, {
              status: 'done',
              result: { message: 'Build complete' },
            });
          })
          .catch((err) => {
            globalJobRegistry.update(job.id, { status: 'failed', result: { error: String(err) } });
          });
      })
      .catch((err) => {
        globalJobRegistry.update(job.id, { status: 'failed', result: { error: String(err) } });
      });

    res.status(202).json({ jobId: job.id });
  });

  app.get('/api/jobs/:id', (req, res) => {
    const job = globalJobRegistry.get(req.params.id ?? '');
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    res.json(job);
  });

  app.delete('/api/jobs/:id', (req, res) => {
    const ok = globalJobRegistry.cancel(req.params.id ?? '');
    if (!ok) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    res.json({ cancelled: true });
  });

  app.get('/api/grep', (req, res) => {
    try {
      const pattern = (req.query.q as string | undefined) ?? '';
      const caseSensitive = req.query.case === 'true';
      res.json(queryGrep(db, pattern, caseSensitive));
    } catch (err) {
      console.error('[api error]', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // SSE progress stream for a job
  app.get('/api/jobs/:id/progress', (req, res) => {
    const jobId = req.params.id ?? '';
    const job = globalJobRegistry.get(jobId);
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // Send existing progress events
    for (const evt of globalJobRegistry.getProgress(jobId)) {
      res.write(`data: ${JSON.stringify(evt)}\n\n`);
    }

    // Poll for new events until job is done
    let lastSent = globalJobRegistry.getProgress(jobId).length;
    const interval = setInterval(() => {
      const current = globalJobRegistry.get(jobId);
      if (!current) {
        clearInterval(interval);
        res.end();
        return;
      }

      const all = globalJobRegistry.getProgress(jobId);
      for (let i = lastSent; i < all.length; i++) {
        res.write(`data: ${JSON.stringify(all[i])}\n\n`);
      }
      lastSent = all.length;

      if (
        current.status === 'done' ||
        current.status === 'failed' ||
        current.status === 'cancelled'
      ) {
        res.write(`data: ${JSON.stringify({ phase: 'complete', status: current.status })}\n\n`);
        clearInterval(interval);
        res.end();
      }
    }, 500);

    req.on('close', () => clearInterval(interval));
  });

  app.get('/api/clusters', (_req, res) => {
    try {
      res.json(queryClusters(db));
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get('/api/cluster', (req, res) => {
    try {
      const name = (req.query.name as string | undefined) ?? '';
      if (!name) {
        res.status(400).json({ error: 'name required' });
        return;
      }
      const result = queryCluster(db, name);
      if (!result) {
        res.status(404).json({ error: 'Cluster not found' });
        return;
      }
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get('/api/processes', (_req, res) => {
    try {
      res.json(queryProcessesList(db));
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get('/api/process', (req, res) => {
    try {
      const name = (req.query.name as string | undefined) ?? '';
      if (!name) {
        res.status(400).json({ error: 'name required' });
        return;
      }
      const result = queryProcess(db, name);
      if (!result) {
        res.status(404).json({ error: 'Process not found' });
        return;
      }
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get('/api/info', (_req, res) => {
    res.json(getServerInfo());
  });

  app.get('/api/heartbeat', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const interval = setInterval(() => {
      res.write(`data: ${JSON.stringify({ ts: Date.now() })}\n\n`);
    }, 15000);

    // Send immediate heartbeat
    res.write(`data: ${JSON.stringify({ ts: Date.now() })}\n\n`);
    req.on('close', () => clearInterval(interval));
  });
}
