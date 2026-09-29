/**
 * Statusline script section: knowledge, trigger, daemon, hook-latency, graph,
 * loop, HIL and monograph stats collectors.
 * Spliced verbatim into generateStatuslineScript() output.
 */

export const STATUSLINE_STATS_SECTION = `// ── Knowledge & trigger stats (Tasks 28 + 32) ────────────────────
function getKnowledgeStats() {
  const chunksPath = path.join(CWD, '.monomind', 'knowledge', 'chunks.jsonl');
  const skillsPath = path.join(CWD, '.monomind', 'skills.jsonl');
  let chunks = 0, skills = 0;
  try {
    const chunksStat = safeStat(chunksPath);
    if (chunksStat && chunksStat.size <= MAX_JSON_READ_BYTES) {
      chunks = fs.readFileSync(chunksPath, 'utf-8').split('\\n').filter(Boolean).length;
    }
  } catch (err) { if (process.env.MONOMIND_DEBUG) console.error('[statusline]', err); /* ignore */ }
  try {
    const skillsStat = safeStat(skillsPath);
    if (skillsStat && skillsStat.size <= MAX_JSON_READ_BYTES) {
      skills = fs.readFileSync(skillsPath, 'utf-8').split('\\n').filter(Boolean).length;
    }
  } catch (err) { if (process.env.MONOMIND_DEBUG) console.error('[statusline]', err); /* ignore */ }
  return { chunks, skills };
}

// Document / knowledge stats — docs indexed + chunks + memory entries
function getDocStats() {
  const docPath    = path.join(CWD, '.monomind', 'knowledge', 'doc-metadata.jsonl');
  const chunksPath = path.join(CWD, '.monomind', 'knowledge', 'chunks.jsonl');
  const memDbPath  = path.join(CWD, '.monomind', 'memory', 'memory.db');
  let docs = 0, chunks = 0, memories = 0, exists = false;
  try {
    const ds = safeStat(docPath);
    if (ds && ds.size > 0 && ds.size <= MAX_JSON_READ_BYTES) {
      docs = fs.readFileSync(docPath, 'utf-8').split('\\n').filter(Boolean).length;
      exists = true;
    }
  } catch (err) { if (process.env.MONOMIND_DEBUG) console.error('[statusline]', err); /* ignore */ }
  try {
    const cs = safeStat(chunksPath);
    if (cs && cs.size > 0 && cs.size <= MAX_JSON_READ_BYTES) {
      chunks = fs.readFileSync(chunksPath, 'utf-8').split('\\n').filter(Boolean).length;
      exists = true;
    }
  } catch (err) { if (process.env.MONOMIND_DEBUG) console.error('[statusline]', err); /* ignore */ }
  try {
    if (fs.existsSync(memDbPath)) {
      const result = spawnSync('sqlite3', [memDbPath, 'SELECT COUNT(*) FROM memory_entries;'], { encoding: 'utf-8', timeout: 1000 });
      const n = parseInt((result.stdout || '').trim(), 10) || 0;
      if (n > 0) { memories = n; exists = true; }
    }
  } catch (err) { if (process.env.MONOMIND_DEBUG) console.error('[statusline]', err); /* ignore */ }
  return { docs, chunks, memories, exists };
}

function getTriggerStats() {
  const indexPath = path.join(CWD, '.monomind', 'trigger-index.json');
  try {
    const idxStat = safeStat(indexPath);
    if (!idxStat || idxStat.size > MAX_JSON_READ_BYTES) return { triggers: 0, agents: 0 };
    const raw = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    const idx = raw.index || raw;
    const triggers = Object.keys(idx).length;
    const agents = Object.values(idx).flat().length;
    return { triggers, agents };
  } catch (err) { if (process.env.MONOMIND_DEBUG) console.error('[statusline]', err); return { triggers: 0, agents: 0 }; }
}

// Daemon worker alerts — security-audit, testgaps, benchmark. Fast: single
// stat + JSON.parse per file (files are small, KB-scale), skip entirely when
// the worker hasn't run yet (no metrics dir / file) so cold projects pay
// zero cost beyond the existsSync check.
function getDaemonAlerts() {
  const metricsDir = path.join(CWD, '.monomind', 'metrics');
  const out = { security: null, testgaps: null, benchmark: null };
  if (!fs.existsSync(metricsDir)) return out;

  const audit = readJSON(path.join(metricsDir, 'security-audit.json'));
  if (audit) {
    const riskLevel = (audit.riskLevel || 'low').toLowerCase();
    const findings = (audit.recommendations || []).length + (audit.priorityScanTargets || []).length;
    out.security = { riskLevel, findings };
  }

  const gaps = readJSON(path.join(metricsDir, 'testgaps.json'));
  if (gaps) {
    const gapList = Array.isArray(gaps.gaps) ? gaps.gaps : [];
    const uncovered = gaps.uncoveredCount ?? gapList.length;
    if (uncovered > 0 || gapList.length > 0) out.testgaps = { uncovered };
  }

  const bench = readJSON(path.join(metricsDir, 'benchmark.json'));
  if (bench?.benchmarks) {
    const heapMB = bench.benchmarks.memoryUsage ? Math.floor(bench.benchmarks.memoryUsage.heapUsed / 1024 / 1024) : null;
    const uptimeMin = bench.benchmarks.uptime ? Math.floor(bench.benchmarks.uptime / 60) : null;
    out.benchmark = { heapMB, uptimeMin, timestamp: bench.timestamp };
  }

  return out;
}

// Hook latency — surface slow per-prompt hooks in the statusline.
function getHookLatency() {
  const p = path.join(CWD, '.monomind', 'metrics', 'hook-latency.json');
  try {
    const latStat = safeStat(p);
    if (!latStat || latStat.size > MAX_JSON_READ_BYTES) return null;
    const d = JSON.parse(fs.readFileSync(p, 'utf-8'));
    const perPrompt = ['route'];
    let totalMs = 0; let count = 0;
    for (const h of perPrompt) {
      if (d[h] && d[h].mean) { totalMs += d[h].mean; count++; }
    }
    if (count === 0) return null;
    let slowest = null;
    for (const k of Object.keys(d)) {
      if (k === 'lastUpdated' || !d[k] || typeof d[k] !== 'object') continue;
      if (!slowest || d[k].mean > slowest.mean) slowest = { name: k, mean: d[k].mean };
    }
    return { perPromptMs: totalMs, slowest: slowest };
  } catch (err) { if (process.env.MONOMIND_DEBUG) console.error('[statusline]', err); return null; }
}

// Graph usage telemetry — counts ALL graph wins (MCP calls + silent assists)
// vs greps that got no graph help.
function getGraphUsage() {
  const usagePath = path.join(CWD, '.monomind', 'metrics', 'graph-usage.json');
  try {
    const usageStat = safeStat(usagePath);
    if (!usageStat || usageStat.size > MAX_JSON_READ_BYTES) return null;
    const d = JSON.parse(fs.readFileSync(usagePath, 'utf-8'));
    const graphWins = (d.monograph_call || 0) + (d.preresolve_hit || 0)
                    + (d.graph_assist_search || 0) + (d.graph_assist_neighbors || 0);
    const searches = (d.grep_call || 0) + (d.glob_call || 0)
                   + (d.bash_grep_call || 0) + (d.bash_find_call || 0);
    const total = graphWins + searches + (d.preresolve_miss || 0);
    if (total === 0) return null;
    return { graphWins: graphWins, searches: searches, pct: Math.round((graphWins / total) * 100), hints: d.graph_assist_search || 0 };
  } catch (err) { if (process.env.MONOMIND_DEBUG) console.error('[statusline]', err); return null; }
}

// Graph freshness — compare last build time vs commits since
function getGraphFreshness() {
  const lockPath = path.join(CWD, '.monomind', 'graph', '.rebuild-lock');
  const dbPath   = path.join(CWD, '.monomind', 'monograph.db');
  let buildMs = 0;
  try {
    const lockStat = safeStat(lockPath);
    const dbStat   = safeStat(dbPath);
    buildMs = Math.max(lockStat?.mtimeMs || 0, dbStat?.mtimeMs || 0);
  } catch (err) { if (process.env.MONOMIND_DEBUG) console.error('[statusline]', err); /* ignore */ }
  if (!buildMs) return { commitsBehind: -1, stale: true, fresh: false };
  const buildIso = new Date(buildMs).toISOString();
  const out = safeExec(\`git rev-list --count --since='\${buildIso}' HEAD 2>/dev/null\`, 1500);
  const commitsBehind = parseInt(out, 10) || 0;
  return { commitsBehind, stale: commitsBehind > 5, fresh: commitsBehind === 0 };
}

// Active loops — scan .monomind/loops/*.json, skip stale (>6h)
function getLoopStatus() {
  const loopsDir = path.join(CWD, '.monomind', 'loops');
  if (!fs.existsSync(loopsDir)) return { count: 0, loops: [] };
  const STALE_MS = 6 * 60 * 60 * 1000;
  const now = Date.now();
  const loops = [];
  try {
    const files = fs.readdirSync(loopsDir).filter(f =>
      f.endsWith('.json') && !f.includes('-hil') && !f.endsWith('.stop'));
    for (const f of files) {
      const d = readJSON(path.join(loopsDir, f));
      if (!d || !d.command) continue;
      const last = d.lastRunAt || d.nextRunAt || d.startedAt || 0;
      if (last && (now - last) > STALE_MS) continue;
      loops.push({
        cmd: String(d.command).replace(/^\\//,''),
        type: d.type || 'repeat',
        rep: d.currentRep || 0,
        max: d.maxReps || 0,
        status: d.status || 'running',
      });
    }
  } catch (err) { if (process.env.MONOMIND_DEBUG) console.error('[statusline]', err); /* ignore */ }
  return { count: loops.length, loops };
}

// HIL pending — count <id>-hil.md files with no human response yet
function getHILPending() {
  const loopsDir = path.join(CWD, '.monomind', 'loops');
  if (!fs.existsSync(loopsDir)) return { pending: 0 };
  let pending = 0;
  try {
    const files = fs.readdirSync(loopsDir).filter(f => f.endsWith('-hil.md'));
    for (const f of files) {
      try {
        const hilPath = path.join(loopsDir, f);
        const hilStat = safeStat(hilPath);
        if (!hilStat || hilStat.size > 512 * 1024) continue; // skip > 512 KB
        const txt = fs.readFileSync(hilPath, 'utf-8');
        const answered = /^[ \\t]*>[ \\t]+\\S/m.test(txt);
        if (!answered) pending++;
      } catch (err) { if (process.env.MONOMIND_DEBUG) console.error('[statusline]', err); /* ignore */ }
    }
  } catch (err) { if (process.env.MONOMIND_DEBUG) console.error('[statusline]', err); /* ignore */ }
  return { pending };
}

// Monograph knowledge graph stats
// Sources, in priority order:
//   1. .monomind/graph/stats.json     — explicit cached stats
//   2. .monomind/monograph.db         — live SQLite (read counts via sqlite3)
//   3. .monomind/graph/graph.json     — legacy JSON dump
function getMonographStats() {
  const statsPath = path.join(CWD, '.monomind', 'graph', 'stats.json');
  const dbPath    = path.join(CWD, '.monomind', 'monograph.db');
  const graphPath = path.join(CWD, '.monomind', 'graph', 'graph.json');

  try {
    const s = readJSON(statsPath);
    if (s && s.nodes !== undefined) return { nodes: s.nodes, edges: s.edges || 0, exists: true };
  } catch (err) { if (process.env.MONOMIND_DEBUG) console.error('[statusline]', err); /* ignore */ }

  try {
    if (fs.existsSync(dbPath)) {
      const out = safeExec(\`sqlite3 "\${dbPath}" "SELECT (SELECT COUNT(*) FROM nodes), (SELECT COUNT(*) FROM edges);"\`, 1000);
      if (out) {
        const [n, e] = out.split('|').map(v => parseInt(v, 10) || 0);
        if (n > 0) return { nodes: n, edges: e, exists: true };
      }
    }
  } catch (err) { if (process.env.MONOMIND_DEBUG) console.error('[statusline]', err); /* ignore */ }

  try {
    const stat = safeStat(graphPath);
    if (stat && stat.size < 10 * 1024 * 1024) {
      const g = JSON.parse(fs.readFileSync(graphPath, 'utf-8'));
      const nodes = Array.isArray(g.nodes) ? g.nodes.length : 0;
      const edges = (Array.isArray(g.edges) ? g.edges : (Array.isArray(g.links) ? g.links : [])).length;
      return { nodes, edges, exists: true };
    }
  } catch (err) { if (process.env.MONOMIND_DEBUG) console.error('[statusline]', err); /* ignore */ }
  return { nodes: 0, edges: 0, exists: false };
}

// V4: how many commits is the monograph behind HEAD?
// Reads last_commit_hash from index_meta in the SQLite DB and runs
// git rev-list --count <last>..HEAD. Returns null when the DB is
// missing, the meta row is absent, or git is unavailable.
function getGraphStaleness() {
  const dbPath = path.join(CWD, '.monomind', 'monograph.db');
  if (!fs.existsSync(dbPath)) return null;
  try {
    // Pull the last indexed commit out of index_meta via sqlite3 (same
    // shell-out convention getMonographStats uses for node/edge counts).
    const lastCommit = safeExec(\`sqlite3 "\${dbPath}" "SELECT value FROM index_meta WHERE key = 'last_commit_hash' OR key = 'lastCommit' LIMIT 1;"\`, 1000);
    if (!lastCommit || !/^[0-9a-f]{7,40}$/i.test(lastCommit.trim())) return null;
    const out = safeExec(\`git rev-list --count \${lastCommit.trim()}..HEAD\`, 1500);
    if (!out) return null;
    const n = parseInt(out.trim(), 10);
    return Number.isFinite(n) ? { commitsBehind: n, lastCommit: lastCommit.trim() } : null;
  } catch (err) {
    if (process.env.MONOMIND_DEBUG) console.error('[statusline]', err);
    return null;
  }
}

function getSIBudget() {
  const SI_LIMIT = 1500;
  const siPath = path.join(CWD, '.agents', 'shared_instructions.md');
  try {
    const siStat = safeStat(siPath);
    if (!siStat) return null;
    if (siStat.size > 2 * 1024 * 1024) return null; // skip > 2 MB
    const len = fs.readFileSync(siPath, 'utf-8').length;
    return { len, pct: Math.round((len / SI_LIMIT) * 100), limit: SI_LIMIT };
  } catch (err) { if (process.env.MONOMIND_DEBUG) console.error('[statusline]', err); return null; }
}

`;
