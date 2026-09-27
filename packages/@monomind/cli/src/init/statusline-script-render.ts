/**
 * Statusline script section: compact line, multi-line dashboard, JSON output,
 * mode state file and main entry point.
 * Spliced verbatim into generateStatuslineScript() output.
 */

export const STATUSLINE_RENDER_SECTION = `// ── Single-line statusline (compact) ─────────────────────────────
function generateStatusline() {
  const git       = getGitInfo();
  const monoswarm     = getMonoswarmStatus();
  const system    = getSystemMetrics();
  const hooks     = getHooksStatus();
  const knowledge = getKnowledgeStats();
  const triggers  = getTriggerStats();
  const parts     = [];

  // Brand + swarm dot
  const monoswarmDot = monoswarm.coordinationActive ? \`\${x.green}●\${x.reset}\` : \`\${x.slate}○\${x.reset}\`;
  parts.push(\`\${x.bold}\${x.purple}▊ Monomind\${x.reset} \${monoswarmDot}\`);

  // Git branch + changes (compact)
  if (git.gitBranch) {
    let b = \`\${x.sky}⎇ \${x.bold}\${git.gitBranch}\${x.reset}\`;
    if (git.staged   > 0) b += \` \${x.green}+\${git.staged}\${x.reset}\`;
    if (git.modified > 0) b += \` \${x.gold}~\${git.modified}\${x.reset}\`;
    if (git.ahead    > 0) b += \` \${x.green}↑\${git.ahead}\${x.reset}\`;
    if (git.behind   > 0) b += \` \${x.coral}↓\${git.behind}\${x.reset}\`;
    parts.push(b);
  }

  // Model
  parts.push(\`\${x.violet}\${getModelName()}\${x.reset}\`);

  // Active agent
  const activeAgent = getActiveAgent();
  if (activeAgent) {
    const col  = activeAgent.activated ? x.green : x.sky;
    const icon = activeAgent.activated ? '●' : '→';
    parts.push(\`\${col}\${icon} \${x.bold}\${activeAgent.name}\${x.reset}\`);
  }

  // Intelligence
  const ic = pctColor(system.intelligencePct);
  parts.push(\`\${ic}💡 \${system.intelligencePct}%\${x.reset}\`);

  // Knowledge chunks (Task 28) — show when populated
  if (knowledge.chunks > 0) {
    parts.push(\`\${x.teal}📚 \${knowledge.chunks}k\${x.reset}\`);
  }

  // V4: graph staleness — visible warning when the monograph is behind HEAD.
  // Silent staleness is the most dangerous failure mode (the user trusts a
  // stale answer), so surface commits-behind on the statusline itself.
  const graph = getMonographStats();
  if (graph.exists && graph.nodes > 0) {
    const stale = getGraphStaleness();
    if (stale && stale.commitsBehind > 0) {
      // Color escalates with staleness: green <=3, gold <=10, coral >10.
      const staleCol = stale.commitsBehind <= 3 ? x.green
                     : stale.commitsBehind <= 10 ? x.gold : x.coral;
      parts.push(\`\${staleCol}⊛ \${graph.nodes}n \${stale.commitsBehind}behind\${x.reset}\`);
    } else {
      parts.push(\`\${x.teal}⊛ \${graph.nodes}n\${x.reset}\`);
    }
  }

  // Triggers (Task 32) — show when populated
  if (triggers.triggers > 0) {
    parts.push(\`\${x.mint}🎯 \${triggers.triggers}t\${x.reset}\`);
  }

  // Swarm agents (only when active)
  if (monoswarm.activeAgents > 0) {
    parts.push(\`\${x.gold}🐝 \${monoswarm.activeAgents}/\${monoswarm.maxAgents}\${x.reset}\`);
  }

  // Hooks
  if (hooks.enabled > 0) {
    parts.push(\`\${x.mint}⚡ \${hooks.enabled}h\${x.reset}\`);
  }

  // Daemon alerts — only show when there's something worth flagging
  const alerts = getDaemonAlerts();
  if (alerts.security && (alerts.security.riskLevel === 'high' || alerts.security.riskLevel === 'critical')) {
    parts.push(\`\${x.coral}🛡 \${alerts.security.findings}\${x.reset}\`);
  }
  if (alerts.testgaps && alerts.testgaps.uncovered > 0) {
    parts.push(\`\${x.gold}🧪 \${alerts.testgaps.uncovered}\${x.reset}\`);
  }

  return parts.join(\`  \${DIV}  \`);
}

// Neural Control Room liveness. Port comes from .monomind/control.json, written
// by control-start.cjs when it spawns src/ui/server.mjs. No control.json means
// the dashboard was never started in this project — caller hides the row.
function getDashboardHealth() {
  const ctl = readJSON(path.join(CWD, '.monomind', 'control.json'));
  const port = ctl && Number(ctl.port);
  if (!port) return { configured: false, port: 0, frontendUp: false, backendUp: false };
  // One curl, two transfers (curl re-applies -w after each URL/-o pair) — half the
  // process-spawn cost of two calls. The trailing space in '%{http_code} ' is what
  // separates the two codes; without it they'd concatenate into "200401".
  // curl's own --max-time fires before safeExec's outer timeout so a hung server
  // yields curl's clean empty-string failure instead of an execSync kill.
  const out = safeExec(
    "curl -s --max-time 0.4 --connect-timeout 0.2 -w '%{http_code} '"
    + " -o /dev/null http://127.0.0.1:" + port + "/"
    + " -o /dev/null http://127.0.0.1:" + port + "/api/status",
    900,
  );
  const codes = out.split(' ');
  const back = Number(codes[1]);
  return {
    configured: true,
    port: port,
    // '/' is an open route (server.mjs _OPEN_ROUTES) — a real 200 proves the HTML
    // bundle serves. Must be GET: HEAD / 404s, the handler only matches GET.
    frontendUp: codes[0] === '200',
    // /api/status is auth-gated (401 without a token) — any HTTP status at all
    // proves the process is answering. Mirrors server.mjs's own unauthenticated
    // liveness probe in writeDashboardToken() (fetch + no status check).
    backendUp: back >= 100 && back <= 599,
  };
}

// ── Multi-line dashboard (full mode) ─────────────────────────────
function generateDashboard() {
  const git         = getGitInfo();
  const modelName   = getModelName();
  const progress    = getv1Progress();
  const security    = getSecurityStatus();
  const monoswarm       = getMonoswarmStatus();
  const system      = getSystemMetrics();
  const adrs        = getADRStatus();
  const hooks       = getHooksStatus();
  const memoryStats  = getMemoryStats();
  const tests       = getTestStats();
  const session     = getSessionStats();
  const integration = getIntegrationStatus();
  const knowledge   = getKnowledgeStats();
  const triggers    = getTriggerStats();
  const si          = getSIBudget();
  const sec         = secBadge(security.status);
  const activeAgent = getActiveAgent();
  const lines       = [];

  // ── Header: brand + git + model + session ────────────────────
  const monoswarmDot = monoswarm.coordinationActive ? \`\${x.green}● LIVE\${x.reset}\` : \`\${x.slate}○ IDLE\${x.reset}\`;
  const projName = getProjectName();
  const cwdName = path.basename(CWD);
  let hdr = \`\${x.bold}\${x.purple}▊ Monomind \${VERSION}\${x.reset}  \${monoswarmDot}  \${x.teal}\${x.bold}\${projName}\${x.reset}  \${DIV}  \${x.dim}◎ \${cwdName}\${x.reset}  \${DIV}  \${x.violet}⬡ \${git.name}\${x.reset}\`;

  if (git.gitBranch) {
    hdr += \`  \${DIV}  \${x.sky}⎇ \${x.bold}\${git.gitBranch}\${x.reset}\`;
    if (git.staged   > 0) hdr += \`  \${x.green}+\${git.staged}\${x.reset}\`;
    if (git.modified > 0) hdr += \`  \${x.gold}~\${git.modified} mod\${x.reset}\`;
    if (git.untracked > 0) hdr += \`  \${x.slate}?\${git.untracked}\${x.reset}\`;
    if (git.ahead    > 0) hdr += \`  \${x.green}↑\${git.ahead}\${x.reset}\`;
    if (git.behind   > 0) hdr += \`  \${x.coral}↓\${git.behind}\${x.reset}\`;
  }

  hdr += \`  \${DIV}  🤖 \${x.violet}\${x.bold}\${modelName}\${x.reset}\`;
  if (session.duration) hdr += \`  \${x.dim}⏱ \${session.duration}\${x.reset}\`;

  lines.push(hdr);
  lines.push(SEP);

  // ── Row 1: Active agent + Loop status ────────────────────────
  let agentStr;
  if (activeAgent) {
    const col  = activeAgent.activated ? x.green : x.sky;
    const mark = activeAgent.activated ? \`\${col}\${x.bold}● ACTIVE\${x.reset}  \` : '';
    const conf = activeAgent.activated ? '' : \`  \${x.slate}\${(activeAgent.confidence * 100).toFixed(0)}%\${x.reset}\`;
    agentStr = \`\${mark}\${col}👤 \${x.bold}\${activeAgent.name}\${x.reset}\${conf}\`;
  } else {
    agentStr = \`\${x.slate}👤 no agent routed\${x.reset}\`;
  }

  const loopState = getLoopStatus();
  let loopStr;
  if (loopState.count > 0) {
    const parts = loopState.loops.slice(0, 2).map(l => {
      const status = l.status === 'hil:pending'
        ? \`\${x.coral}⏳ HIL\${x.reset}\`
        : \`\${x.green}⟳\${x.reset}\`;
      const tag = l.type === 'tillend'
        ? \`\${x.bold}\${l.cmd}\${x.reset}\${x.slate} run \${l.rep}\${x.reset}\`
        : \`\${x.bold}\${l.cmd}\${x.reset}\${x.slate} \${l.rep}/\${l.max}\${x.reset}\`;
      return \`\${status} \${tag}\`;
    });
    loopStr = \`\${x.gold}🔄\${x.reset} \${parts.join(\`\${x.slate}  ·  \${x.reset}\`)}\`;
    if (loopState.count > 2) loopStr += \`\${x.slate}  +\${loopState.count - 2} more\${x.reset}\`;
  } else {
    loopStr = \`\${x.slate}🔄 no active loops\${x.reset}\`;
  }

  // Graph usage ratio + $ saved — show only when there's data
  const usage = getGraphUsage();
  let usageStr = '';
  if (usage) {
    const col = usage.pct >= 40 ? x.green : usage.pct >= 15 ? x.gold : x.coral;
    const savedCol = usage.dollarsSaved >= 0.10 ? x.green : x.slate;
    const savedStr = \`   \${savedCol}💰 $\${usage.dollarsSaved.toFixed(2)}\${x.reset}\`;
    usageStr = \`   \${DIV}   \${col}📊 graph \${usage.pct}%\${x.reset}\${x.slate} · grep \${100 - usage.pct}%\${x.reset}\${savedStr}\`;
  }

  // Hook latency — surface when slow (>500ms per prompt)
  const lat = getHookLatency();
  let latStr = '';
  if (lat && lat.perPromptMs > 500) {
    latStr = \`   \${DIV}   \${x.coral}⚡ hooks \${lat.perPromptMs}ms\${x.reset}\`;
  } else if (lat && lat.perPromptMs > 0) {
    latStr = \`   \${DIV}   \${x.dim}⚡ \${lat.perPromptMs}ms\${x.reset}\`;
  }

  lines.push(\`\${x.purple}🤖  AGENT\${x.reset}    \${agentStr}   \${DIV}   \${loopStr}\${usageStr}\${latStr}\`);
  lines.push(SEP);

  // ── Row 2: Graph freshness + Pending HIL ─────────────────────
  const gf = getMonographStats();
  const freshness = getGraphFreshness();
  let graphStr;
  if (gf.exists) {
    const nodesFmt = gf.nodes >= 1000 ? \`\${(gf.nodes / 1000).toFixed(0)}k\` : \`\${gf.nodes}\`;
    const freshTag = freshness.fresh
      ? \`\${x.green}● fresh\${x.reset}\`
      : freshness.stale
        ? \`\${x.coral}● \${freshness.commitsBehind} commits stale\${x.reset}\`
        : \`\${x.gold}● \${freshness.commitsBehind} behind\${x.reset}\`;
    graphStr = \`\${x.sky}🔗 \${x.bold}\${nodesFmt}\${x.reset}\${x.slate} nodes\${x.reset}  \${freshTag}\`;
  } else {
    graphStr = \`\${x.slate}🔗 no graph\${x.reset}\`;
  }

  // Document / knowledge stats
  const docStats = getDocStats();
  let docStr = '';
  if (docStats.exists) {
    const parts = [];
    if (docStats.docs > 0) {
      const docFmt = docStats.docs >= 1000 ? \`\${(docStats.docs / 1000).toFixed(1)}k\` : \`\${docStats.docs}\`;
      parts.push(\`\${x.bold}\${docFmt}\${x.reset}\${x.slate} docs\${x.reset}\`);
    }
    if (docStats.chunks > 0) parts.push(\`\${x.bold}\${docStats.chunks}\${x.reset}\${x.slate} chunks\${x.reset}\`);
    if (docStats.memories > 0) parts.push(\`\${x.bold}\${docStats.memories}\${x.reset}\${x.slate} memories\${x.reset}\`);
    if (parts.length) docStr = \`   \${DIV}   \${x.sky}📄\${x.reset} \${parts.join('  ')}\`;
  }

  const hil = getHILPending();
  const hilStr = hil.pending > 0
    ? \`   \${DIV}   \${x.coral}✨ \${x.bold}\${hil.pending}\${x.reset}\${x.coral} HIL pending\${x.reset}\`
    : \`\`;

  lines.push(\`\${x.teal}🧠  CONTEXT\${x.reset}  \${graphStr}\${docStr}\${hilStr}\`);

  // ── Row 3: Daemon worker alerts (security / testgaps / benchmark) ──
  const alerts = getDaemonAlerts();
  const alertParts = [];
  if (alerts.security) {
    const s = alerts.security;
    const col = s.riskLevel === 'critical' || s.riskLevel === 'high' ? x.coral : s.findings > 0 ? x.gold : x.green;
    alertParts.push(\`\${col}🛡 sec \${s.riskLevel}\${s.findings > 0 ? \` (\${s.findings})\` : ''}\${x.reset}\`);
  }
  if (alerts.testgaps) {
    alertParts.push(\`\${x.gold}🧪 gaps \${alerts.testgaps.uncovered}\${x.reset}\`);
  }
  if (alerts.benchmark && alerts.benchmark.heapMB !== null) {
    alertParts.push(\`\${x.slate}⏱ bench heap \${alerts.benchmark.heapMB}MB\${alerts.benchmark.uptimeMin !== null ? \` up \${alerts.benchmark.uptimeMin}m\` : ''}\${x.reset}\`);
  }
  if (alertParts.length > 0) {
    lines.push(SEP);
    lines.push(\`\${x.purple}⚙️  WORKERS\${x.reset}  \${alertParts.join(\`   \${DIV}   \`)}\`);
  }

  // ── Row: Neural Control Room liveness ──────────────────────
  const dash = getDashboardHealth();
  if (dash.configured) {
    lines.push(SEP);
    const fe = \`\${dot(dash.frontendUp ? 'good' : 'error')}\${x.slate} ui\${x.reset}\`;
    const be = \`\${dot(dash.backendUp ? 'good' : 'error')}\${x.slate} api\${x.reset}\`;
    const where = (dash.frontendUp || dash.backendUp)
      ? \`\${x.dim}:\${dash.port}\${x.reset}\`
      : \`\${x.coral}down :\${dash.port}\${x.reset}\`;
    lines.push(\`\${x.purple}🖥  DASH\${x.reset}  \${fe}  \${be}   \${DIV}   \${where}\`);
  }

  return lines.join('\\n');
}

// ── JSON output ──────────────────────────────────────────────────
function generateJSON() {
  const git = getGitInfo();
  return {
    user:       { name: git.name, gitBranch: git.gitBranch, modelName: getModelName() },
    domains:    getv1Progress(),
    security:   getSecurityStatus(),
    monoswarm:  getMonoswarmStatus(),
    system:     getSystemMetrics(),
    adrs:       getADRStatus(),
    hooks:      getHooksStatus(),
    memory:     getMemoryStats(),
    tests:      getTestStats(),
    git:        { modified: git.modified, untracked: git.untracked, staged: git.staged, ahead: git.ahead, behind: git.behind },
    daemonAlerts: getDaemonAlerts(),
    lastUpdated: new Date().toISOString(),
  };
}

// ─── Mode state file ─────────────────────────────────────────────
const MODE_FILE = path.join(CWD, '.monomind', 'statusline-mode.txt');

function readMode() {
  try {
    const modeStat = safeStat(MODE_FILE);
    if (modeStat && modeStat.size <= 1024) {
      return fs.readFileSync(MODE_FILE, 'utf-8').trim();
    }
  } catch (err) { if (process.env.MONOMIND_DEBUG) console.error('[statusline]', err); /* ignore */ }
  return 'full'; // default
}

// ─── Main ───────────────────────────────────────────────────────
if (process.argv.includes('--json')) {
  console.log(JSON.stringify(generateJSON(), null, 2));
} else if (process.argv.includes('--compact')) {
  console.log(JSON.stringify(generateJSON()));
} else if (process.argv.includes('--single-line')) {
  console.log(generateStatusline());
} else if (process.argv.includes('--toggle')) {
  // Toggle mode and print the new view
  const current = readMode();
  const next = current === 'compact' ? 'full' : 'compact';
  try {
    fs.mkdirSync(path.dirname(MODE_FILE), { recursive: true });
    fs.writeFileSync(MODE_FILE, next, 'utf-8');
  } catch (err) { if (process.env.MONOMIND_DEBUG) console.error('[statusline]', err); /* ignore */ }
  if (next === 'compact') {
    console.log(generateStatusline());
  } else {
    console.log(generateDashboard());
  }
} else {
  // Default: respect mode state file — use disk cache to avoid 52+ sync I/O calls per render
  const CACHE_FILE = path.join(os.homedir(), '.monomind', 'statusline-cache.json');
  const CACHE_TTL_MS = 5000; // 5 seconds
  const mode = readMode();

  // Try to serve from cache if fresh and same mode
  let servedFromCache = false;
  try {
    const cacheStat = safeStat(CACHE_FILE);
    if (cacheStat && (Date.now() - cacheStat.mtimeMs) < CACHE_TTL_MS && cacheStat.size <= 512 * 1024) {
      const cached = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
      if (cached && cached.mode === mode && typeof cached.output === 'string') {
        console.log(cached.output);
        servedFromCache = true;
      }
    }
  } catch (err) { if (process.env.MONOMIND_DEBUG) console.error('[statusline]', err); /* cache miss — regenerate */ }

  if (!servedFromCache) {
    const statusOutput = mode === 'compact' ? generateStatusline() : generateDashboard();
    console.log(statusOutput);
    // Persist to cache for subsequent renders within the TTL window
    try {
      fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
      fs.writeFileSync(CACHE_FILE, JSON.stringify({ mode, output: statusOutput }), 'utf-8');
    } catch (err) { if (process.env.MONOMIND_DEBUG) console.error('[statusline]', err); /* ignore cache write failures */ }
  }
}
`;
