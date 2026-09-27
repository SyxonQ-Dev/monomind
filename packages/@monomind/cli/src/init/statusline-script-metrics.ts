/**
 * Statusline script section: system/ADR/hooks/agent/memory/test/integration/
 * session collectors plus the 256-colour palette and render helpers.
 * Spliced verbatim into generateStatuslineScript() output.
 */

export const STATUSLINE_METRICS_SECTION = `// System metrics (uses process.memoryUsage() — no shell spawn)
function getSystemMetrics() {
  const memoryMB = Math.floor(process.memoryUsage().heapUsed / 1024 / 1024);
  const learning = getLearningStats();
  const memoryStats = getMemoryStats();

  // Intelligence from learning.json
  const learningData = readJSON(path.join(CWD, '.monomind', 'metrics', 'learning.json'));
  let intelligencePct = 0;
  let contextPct = 0;

  if (learningData?.intelligence?.score !== undefined) {
    intelligencePct = Math.min(100, Math.floor(learningData.intelligence.score));
  } else {
    // Use actual vector/entry counts — 2000 entries = 100%
    const fromPatterns = learning.patterns > 0 ? Math.min(100, Math.floor(learning.patterns / 20)) : 0;
    const fromVectors = memoryStats.vectorCount > 0 ? Math.min(100, Math.floor(memoryStats.vectorCount / 20)) : 0;
    intelligencePct = Math.max(fromPatterns, fromVectors);
  }

  // Maturity fallback (pure fs checks, no git exec)
  if (intelligencePct === 0) {
    let score = 0;
    if (fs.existsSync(path.join(CWD, '.claude'))) score += 15;
    const srcDirs = ['src', 'lib', 'app', 'packages', 'v1'];
    for (const d of srcDirs) { if (fs.existsSync(path.join(CWD, d))) { score += 15; break; } }
    const testDirs = ['tests', 'test', '__tests__', 'spec'];
    for (const d of testDirs) { if (fs.existsSync(path.join(CWD, d))) { score += 10; break; } }
    const cfgFiles = ['package.json', 'tsconfig.json', 'pyproject.toml', 'Cargo.toml', 'go.mod'];
    for (const f of cfgFiles) { if (fs.existsSync(path.join(CWD, f))) { score += 5; break; } }
    intelligencePct = Math.min(100, score);
  }

  if (learningData?.sessions?.total !== undefined) {
    contextPct = Math.min(100, learningData.sessions.total * 5);
  } else {
    contextPct = Math.min(100, Math.floor(learning.sessions * 5));
  }

  // Sub-agents from file metrics (no ps aux)
  let subAgents = 0;
  const activityData = readJSON(path.join(CWD, '.monomind', 'metrics', 'monoswarm-activity.json'));
  if (activityData?.processes?.estimated_agents) {
    subAgents = activityData.processes.estimated_agents;
  }

  return { memoryMB, contextPct, intelligencePct, subAgents };
}

// ADR status (count files only — don't read contents)
function getADRStatus() {
  // Count actual ADR files first — compliance JSON may be stale
  const adrPaths = [
    path.join(CWD, 'packages', 'implementation', 'adrs'),
    path.join(CWD, 'docs', 'adrs'),
    path.join(CWD, '.monomind', 'adrs'),
  ];

  for (const adrPath of adrPaths) {
    try {
      if (fs.existsSync(adrPath)) {
        const files = fs.readdirSync(adrPath).filter(f =>
          f.endsWith('.md') && (f.startsWith('ADR-') || f.startsWith('adr-') || /^\\d{4}-/.test(f))
        );
        // Report actual count — don't guess compliance without reading files
        return { count: files.length, implemented: files.length, compliance: 0 };
      }
    } catch (err) { if (process.env.MONOMIND_DEBUG) console.error('[statusline]', err); /* ignore */ }
  }

  return { count: 0, implemented: 0, compliance: 0 };
}

// Hooks status (shared settings cache)
function getHooksStatus() {
  let enabled = 0;
  let total = 0;
  const settings = getSettings();

  if (settings?.hooks) {
    for (const category of Object.keys(settings.hooks)) {
      const matchers = settings.hooks[category];
      if (!Array.isArray(matchers)) continue;
      for (const matcher of matchers) {
        const hooks = matcher?.hooks;
        if (Array.isArray(hooks)) {
          total += hooks.length;
          enabled += hooks.length;
        }
      }
    }
  }

  try {
    const hooksDir = path.join(CWD, '.claude', 'hooks');
    if (fs.existsSync(hooksDir)) {
      const hookFiles = fs.readdirSync(hooksDir).filter(f => f.endsWith('.js') || f.endsWith('.sh')).length;
      total = Math.max(total, hookFiles);
      enabled = Math.max(enabled, hookFiles);
    }
  } catch (err) { if (process.env.MONOMIND_DEBUG) console.error('[statusline]', err); /* ignore */ }

  return { enabled, total };
}

// Active agent — reads last routing result persisted by hook-handler
function getActiveAgent() {
  const routeFile = path.join(CWD, '.monomind', 'last-route.json');
  try {
    const routeStat = safeStat(routeFile);
    if (!routeStat || routeStat.size > MAX_JSON_READ_BYTES) return null;
    const data = JSON.parse(fs.readFileSync(routeFile, 'utf-8'));
    if (!data || !data.agent) return null;

    // Stale after 30 minutes (session likely changed)
    const age = Date.now() - new Date(data.updatedAt || 0).getTime();
    if (age > 30 * 60 * 1000) return null;

    // Prefer display name if set (from load-agent), else format the slug
    const displayName = data.name || data.agent
      .replace(/-/g, ' ')
      .replace(/\\b\\w/g, c => c.toUpperCase());

    return {
      slug: data.agent,
      name: displayName,
      category: data.category || null,
      confidence: data.confidence || 0,
      activated: data.activated || false,   // true = manually loaded extras agent
    };
  } catch (err) { if (process.env.MONOMIND_DEBUG) console.error('[statusline]', err); return null; }
}

// Memory (SQLite) stats — count real entries
function getMemoryStats() {
  let vectorCount = 0;
  let dbSizeKB = 0;
  let namespaces = 0;
  let hasHnsw = false;

  // 1. Count real entries from auto-memory-store.json
  const storePath = path.join(CWD, '.monomind', 'data', 'auto-memory-store.json');
  const storeStat = safeStat(storePath);
  if (storeStat && storeStat.size <= MAX_JSON_READ_BYTES) {
    dbSizeKB += storeStat.size / 1024;
    try {
      const store = JSON.parse(fs.readFileSync(storePath, 'utf-8'));
      if (Array.isArray(store)) vectorCount += store.length;
      else if (store?.entries) vectorCount += store.entries.length;
    } catch (err) { if (process.env.MONOMIND_DEBUG) console.error('[statusline]', err); /* fall back to size estimate */ }
  }

  // 2. Count entries from ranked-context.json
  const rankedPath = path.join(CWD, '.monomind', 'data', 'ranked-context.json');
  try {
    const ranked = readJSON(rankedPath);
    if (ranked?.entries?.length > vectorCount) vectorCount = ranked.entries.length;
  } catch (err) { if (process.env.MONOMIND_DEBUG) console.error('[statusline]', err); /* ignore */ }

  // 3. Add DB file sizes
  const dbFiles = [
    path.join(CWD, 'data', 'memory.db'),
    path.join(CWD, '.monomind', 'memory.db'),
    path.join(CWD, '.swarm', 'memory.db'),
  ];
  for (const f of dbFiles) {
    const stat = safeStat(f);
    if (stat) {
      dbSizeKB += stat.size / 1024;
      namespaces++;
    }
  }

  // 4. Check for graph data
  const graphPath = path.join(CWD, 'data', 'memory.graph');
  const graphStat = safeStat(graphPath);
  if (graphStat) dbSizeKB += graphStat.size / 1024;

  // 5. HNSW index
  const hnswPaths = [
    path.join(CWD, '.swarm', 'hnsw.index'),
    path.join(CWD, '.monomind', 'hnsw.index'),
  ];
  for (const p of hnswPaths) {
    const stat = safeStat(p);
    if (stat) {
      hasHnsw = true;
      break;
    }
  }

  // HNSW is available if memory package is present
  if (!hasHnsw) {
    const memPkgPaths = [
      path.join(CWD, 'packages', '@monomind', 'memory', 'dist'),
      path.join(CWD, 'node_modules', '@monomind', 'memory'),
    ];
    for (const p of memPkgPaths) {
      if (fs.existsSync(p)) { hasHnsw = true; break; }
    }
  }

  return { vectorCount, dbSizeKB: Math.floor(dbSizeKB), namespaces, hasHnsw };
}

// Test stats (count files only — NO reading file contents)
function getTestStats() {
  let testFiles = 0;

  function countTestFiles(dir, depth = 0) {
    if (depth > 6) return;
    try {
      if (!fs.existsSync(dir)) return;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
          countTestFiles(path.join(dir, entry.name), depth + 1);
        } else if (entry.isFile()) {
          const n = entry.name;
          if (n.includes('.test.') || n.includes('.spec.') || n.includes('_test.') || n.includes('_spec.')) {
            testFiles++;
          }
        }
      }
    } catch (err) { if (process.env.MONOMIND_DEBUG) console.error('[statusline]', err); /* ignore */ }
  }

  // Scan all source directories
  for (const d of ['tests', 'test', '__tests__', 'src', 'v1']) {
    countTestFiles(path.join(CWD, d));
  }

  // Estimate ~4 test cases per file (avoids reading every file)
  return { testFiles, testCases: testFiles * 4 };
}

// Integration status (shared settings + file checks)
function getIntegrationStatus() {
  const mcpServers = { total: 0, enabled: 0 };
  const settings = getSettings();

  if (settings?.mcpServers && typeof settings.mcpServers === 'object') {
    const servers = Object.keys(settings.mcpServers);
    mcpServers.total = servers.length;
    mcpServers.enabled = settings.enabledMcpjsonServers
      ? settings.enabledMcpjsonServers.filter(s => servers.includes(s)).length
      : servers.length;
  }

  // Fallback: .mcp.json
  if (mcpServers.total === 0) {
    const mcpConfig = readJSON(path.join(CWD, '.mcp.json'))
                   || readJSON(path.join(os.homedir(), '.claude', 'mcp.json'));
    if (mcpConfig?.mcpServers) {
      const s = Object.keys(mcpConfig.mcpServers);
      mcpServers.total = s.length;
      mcpServers.enabled = s.length;
    }
  }

  const hasDatabase = ['.swarm/memory.db', '.monomind/memory.db', 'data/memory.db']
    .some(p => fs.existsSync(path.join(CWD, p)));
  const hasApi = !!(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY);

  return { mcpServers, hasDatabase, hasApi };
}

// Session stats (pure file reads)
function getSessionStats() {
  for (const p of ['.monomind/session.json', '.claude/session.json']) {
    const data = readJSON(path.join(CWD, p));
    if (data?.startTime) {
      const diffMs = Date.now() - new Date(data.startTime).getTime();
      const mins = Math.floor(diffMs / 60000);
      const duration = mins < 60 ? \`\${mins}m\` : \`\${Math.floor(mins / 60)}h\${mins % 60}m\`;
      return { duration };
    }
  }
  return { duration: '' };
}

// ─── Extended 256-color palette ─────────────────────────────────
const x = {
  // Backgrounds (used sparingly for labels)
  bgPurple:   '\\x1b[48;5;55m',
  bgTeal:     '\\x1b[48;5;23m',
  bgReset:    '\\x1b[49m',
  // Foregrounds
  purple:     '\\x1b[38;5;141m',   // soft lavender-purple (brand)
  violet:     '\\x1b[38;5;99m',    // deeper purple
  teal:       '\\x1b[38;5;51m',    // bright teal
  mint:       '\\x1b[38;5;120m',   // soft green
  gold:       '\\x1b[38;5;220m',   // warm gold
  orange:     '\\x1b[38;5;208m',   // alert orange
  coral:      '\\x1b[38;5;203m',   // error red-pink
  sky:        '\\x1b[38;5;117m',   // soft blue
  rose:       '\\x1b[38;5;218m',   // warm pink
  slate:      '\\x1b[38;5;245m',   // neutral grey
  white:      '\\x1b[38;5;255m',   // bright white
  green:      '\\x1b[38;5;82m',    // vivid green
  red:        '\\x1b[38;5;196m',   // vivid red
  yellow:     '\\x1b[38;5;226m',   // vivid yellow
  // Shared
  bold:  '\\x1b[1m',
  dim:   '\\x1b[2m',
  reset: '\\x1b[0m',
};

// ── Helpers ──────────────────────────────────────────────────────

// Block progress bar: ▰▰▰▱▱  (5 blocks)
function blockBar(current, total, width = 5) {
  const filled = Math.min(width, Math.round((current / Math.max(total, 1)) * width));
  return '\\u25B0'.repeat(filled) + \`\${x.slate}\\u25B1\${x.reset}\`.repeat(width - filled);
}

// Health dot: ● colored by status
function dot(ok) {
  if (ok === 'good')    return \`\${x.green}●\${x.reset}\`;
  if (ok === 'warn')    return \`\${x.gold}●\${x.reset}\`;
  if (ok === 'error')   return \`\${x.coral}●\${x.reset}\`;
  return \`\${x.slate}●\${x.reset}\`;   // 'none'
}

// Pill badge: [ LABEL ] with background
function badge(label, color) {
  return \`\${color}[\${label}]\${x.reset}\`;
}

// Divider character
const DIV = \`\${x.slate}│\${x.reset}\`;
const SEP = \`\${x.slate}──────────────────────────────────────────────────────\${x.reset}\`;

// Pct → color
function pctColor(pct) {
  if (pct >= 75) return x.green;
  if (pct >= 40) return x.gold;
  if (pct > 0)   return x.orange;
  return x.slate;
}

// Security status → label + color
function secBadge(status) {
  if (status === 'CLEAN')       return { label: '✔ CLEAN',   col: x.green };
  if (status === 'STALE')       return { label: '⟳ STALE',   col: x.gold };
  if (status === 'IN_PROGRESS') return { label: '⟳ RUNNING', col: x.sky };
  if (status === 'SCANNED')     return { label: '✔ SCANNED', col: x.mint };
  if (status === 'PENDING')     return { label: '⏸ PENDING', col: x.gold };
  return { label: '✖ NONE', col: x.slate };
}

`;
