import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { countJSONLLines, fileStat, listDir, readJSON, readJSONL } from './collector-helpers.mjs';

function collectHooks(projectDir) {
  const base = path.join(projectDir, '.monomind');
  const lastRoute = readJSON(path.join(base, 'last-route.json')) || {};
  const feedback = readJSONL(path.join(base, 'routing-feedback.jsonl'), 10);

  const workerDispatchDir = path.join(base, 'worker-dispatch');
  const workerDispatch = listDir(workerDispatchDir).filter(
    (f) => f.startsWith('pending-') && f.endsWith('.json'),
  );

  return { lastRoute, feedback, workerDispatch };
}

function collectKnowledge(projectDir) {
  const base = path.join(projectDir, '.monomind');
  const chunksPath = path.join(base, 'knowledge', 'chunks.jsonl');
  const skillsPath = path.join(base, 'skills.jsonl');

  // Read chunks.jsonl once; derive count and recent slice together
  let chunks = 0;
  let recent = [];
  try {
    const raw = fs.readFileSync(chunksPath, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    chunks = lines.length;
    recent = lines
      .slice(-5)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {}
  const skills = countJSONLLines(skillsPath);

  return { chunks, skills, recent };
}

function collectMetrics(projectDir) {
  const base = path.join(projectDir, '.monomind');
  const swarmActivity = readJSON(path.join(base, 'metrics', 'monoswarm-activity.json')) || {};
  const tokenSummary = readJSON(path.join(base, 'metrics', 'token-summary.json')) || {};

  // Derive routing stats from feedback log (cap at 1000 to avoid reading unbounded file)
  const feedbackAll = readJSONL(path.join(base, 'routing-feedback.jsonl'), 1000);
  const routingTotal = feedbackAll.length;
  let routingConfSum = 0,
    routingConfCount = 0;
  const agentCounts = {};
  for (const fb of feedbackAll) {
    if (fb.confidence != null) {
      routingConfSum += fb.confidence;
      routingConfCount++;
    }
    const a = fb.suggestedAgent || fb.agent;
    if (a) agentCounts[a] = (agentCounts[a] || 0) + 1;
  }
  const avgConf =
    routingConfCount > 0 ? Math.round((routingConfSum / routingConfCount) * 100) : null;
  const topAgent = Object.entries(agentCounts).sort((a, b) => b[1] - a[1])[0];

  // Worker freshness: stat the live worker output files so the frontend can
  // render freshness pills. Shape: workers: [{name, exists, ageMs}]
  const workerFiles = [
    'codebase-map',
    'security-audit',
    'performance',
    'consolidation',
    'ddd-progress',
  ];
  const now = Date.now();
  const workers = workerFiles.map((name) => {
    const s = fileStat(path.join(base, 'metrics', `${name}.json`));
    return { name, exists: !!s, ageMs: s ? Math.max(0, now - s.mtimeMs) : null };
  });

  return {
    routing: {
      total: routingTotal,
      avgConfidence: avgConf,
      topAgent: topAgent ? topAgent[0] : null,
      topAgentCount: topAgent ? topAgent[1] : null,
    },
    swarm: {
      active: swarmActivity.monoswarm?.active,
      agentCount: swarmActivity.monoswarm?.agent_count,
      lastActive: swarmActivity.timestamp || null,
    },
    tokens: {
      todayCost: tokenSummary.todayCost,
      todayCalls: tokenSummary.todayCalls,
      monthCost: tokenSummary.monthCost,
      monthCalls: tokenSummary.monthCalls,
    },
    // Live worker output (audit worker) — fields include riskLevel, recommendations
    security: readJSON(path.join(base, 'metrics', 'security-audit.json')) || {},
    workers,
  };
}

function collectTriggers(projectDir) {
  return readJSON(path.join(projectDir, '.monomind', 'trigger-index.json')) || {};
}

function collectMemoryFiles(projectDir) {
  const homeDir = os.homedir();
  const slug = path.resolve(projectDir).replace(/\//g, '-');
  const memDir = path.join(homeDir, '.claude', 'projects', slug, 'memory');
  let files = [];
  try {
    files = fs.readdirSync(memDir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md');
  } catch {}
  return files
    .map((fname) => {
      const fp = path.join(memDir, fname);
      let raw = '';
      try {
        raw = fs.readFileSync(fp, 'utf8').replace(/\r\n/g, '\n');
      } catch {}
      let name = fname.replace('.md', ''),
        description = '',
        type = 'project';
      const fm = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
      if (fm) {
        for (const line of fm[1].split('\n')) {
          const m2 = line.match(/^(\w+):\s*(.+)$/);
          if (m2) {
            if (m2[1] === 'name') name = m2[2].trim();
            if (m2[1] === 'description') description = m2[2].trim();
            if (m2[1] === 'type') type = m2[2].trim();
          }
        }
      }
      let stat = null;
      try {
        stat = fs.statSync(fp);
      } catch {}
      return { filename: fname, name, description, type, mtime: stat ? stat.mtimeMs : null };
    })
    .sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
}

// Probe candidate paths in priority order, return first existing file's stat
function _probeFile(...candidates) {
  for (const p of candidates) {
    const s = fileStat(p);
    if (s && s.size > 0) return { path: p, size: s.size };
  }
  return null;
}

function collectMemory(projectDir) {
  const d = path.resolve(projectDir);
  const monomindDir = path.join(d, '.monomind');

  // Auto-memory pattern store — array of pattern entries written by hooks
  let patternCount = 0;
  let patternsUpdated = null;
  const storePath = path.join(monomindDir, 'data', 'auto-memory-store.json');
  const store = readJSON(storePath);
  if (Array.isArray(store)) {
    patternCount = store.length;
    for (const e of store) {
      if (e && typeof e.ts === 'number' && (!patternsUpdated || e.ts > patternsUpdated))
        patternsUpdated = e.ts;
    }
  }
  if (!patternsUpdated) {
    const s = fileStat(storePath);
    if (s) patternsUpdated = s.mtimeMs;
  }

  // Episodic memory — one JSON line per episode
  let episodeCount = 0;
  let lastEpisode = null;
  try {
    const raw = fs.readFileSync(path.join(monomindDir, 'episodic', 'episodes.jsonl'), 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    episodeCount = lines.length;
    if (lines.length) {
      try {
        const last = JSON.parse(lines[lines.length - 1]);
        lastEpisode = last.ts || last.timestamp || null;
      } catch {}
    }
  } catch {}

  // Last consolidation run (consolidate worker output)
  let lastConsolidated = null;
  const consolidation = readJSON(path.join(monomindDir, 'metrics', 'consolidation.json'));
  if (consolidation?.timestamp) lastConsolidated = consolidation.timestamp;

  const files = collectMemoryFiles(projectDir);

  return {
    patternCount,
    patternsUpdated,
    episodeCount,
    lastEpisode,
    lastConsolidated,
    files,
    count: files.length,
    // Legacy keys kept for frontend backward-safety (v1 backends no longer written in v2)
    dbSize: 0,
    dbPath: null,
    hnsw: false,
    monovectorSize: 0,
    monovectorExists: false,
    monovectorPatterns: 0,
  };
}

function collectSystem() {
  return {
    nodeVersion: process.version,
    uptime: process.uptime(),
    platform: process.platform,
    memoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
  };
}

export {
  collectHooks,
  collectKnowledge,
  collectMemory,
  collectMemoryFiles,
  collectMetrics,
  collectSystem,
  collectTriggers,
};
