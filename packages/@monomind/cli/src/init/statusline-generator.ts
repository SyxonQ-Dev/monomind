/**
 * Statusline Configuration Generator (Optimized)
 * Creates fast, reliable statusline for V1 progress display
 *
 * Performance:
 * - Single combined git execSync call (not 8+ separate ones)
 * - process.memoryUsage() instead of ps aux
 * - No recursive test file content reading
 * - Shared settings cache
 * - Strict 2s timeouts on all shell calls
 * - git/sqlite3/curl/npm results cached per project (#429)
 */

import { STATUSLINE_DATA_SECTION } from './statusline-script-data.js';
import { STATUSLINE_METRICS_SECTION } from './statusline-script-metrics.js';
import { STATUSLINE_RENDER_SECTION } from './statusline-script-render.js';
import { STATUSLINE_STATS_SECTION } from './statusline-script-stats.js';
import type { InitOptions } from './types.js';

/**
 * Generate optimized statusline script
 * Output format:
 * ▊ Monomind ● user  │  ⎇ branch  │  Opus 4.6 (1M context)
 * ─────────────────────────────────────────────────────
 * 🏗️  DDD Domains    [●●○○○]  2/5    ⚡ HNSW
 * 🤖 Swarm  ◉ [ 5/15]  👥 2    🪝 10/17    🟢 CVE 3/3    💾 4MB    🧠  63%
 * 🔧 Architecture    ADRs ●71%  │  DDD ● 13%  │  Security ●CLEAN
 * 📊 SQLite    Vectors ●3104⚡  │  Size 216KB  │  Tests ●6 (~24 cases)  │  MCP ●1/1
 */
export function generateStatuslineScript(options: InitOptions): string {
  const maxAgents = options.runtime.maxAgents;
  return `#!/usr/bin/env node
/**
 * Monomind V1 Statusline Generator (Optimized)
 * Displays real-time v1 implementation progress and system status
 *
 * Usage: node statusline.cjs [--json] [--compact]
 *
 * Performance notes:
 * - Single git execSync call (combines branch + status + upstream)
 * - No recursive file reading (only stat/readdir, never read test contents)
 * - No ps aux calls (uses process.memoryUsage() + file-based metrics)
 * - Strict 2s timeout on all execSync calls
 * - Shared settings cache across functions
 * - git/sqlite3/curl/npm results cached in .monomind/cache/statusline.json (#429)
 */

/* eslint-disable @typescript-eslint/no-var-requires */
const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');
const os = require('os');

// Configuration
const CONFIG = {
  maxAgents: ${maxAgents},
};

const CWD = process.env.CLAUDE_PROJECT_DIR || process.cwd();

// Segments that spawn a process (git, sqlite3, curl, npm) are cached per
// project with these TTLs, so a warm render is file reads + formatting (#429).
// An expired segment is recomputed by the render that finds it expired.
const CACHE_FILE = path.join(CWD, '.monomind', 'cache', 'statusline.json');
const TTL = { git: 5000, counts: 30000, slow: 10 * 60 * 1000 };
let _segments = null;
function cached(key, ttlMs, compute) {
  if (!_segments) {
    try { _segments = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8')); } catch { _segments = {}; }
    if (!_segments || typeof _segments !== 'object' || Array.isArray(_segments)) _segments = {};
  }
  const entry = _segments[key];
  const now = Date.now();
  if (entry && typeof entry.at === 'number' && now >= entry.at && now - entry.at < ttlMs) return entry.v;
  const v = compute();
  _segments[key] = { at: now, v };
  // Only projects that already have .monomind/ get a cache; never create it.
  if (fs.existsSync(path.dirname(path.dirname(CACHE_FILE)))) {
    try {
      fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
      const tmp = CACHE_FILE + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(_segments));
      fs.renameSync(tmp, CACHE_FILE);
    } catch (err) { if (process.env.MONOMIND_DEBUG) console.error('[statusline]', err); }
  }
  return v;
}

${STATUSLINE_DATA_SECTION}${STATUSLINE_METRICS_SECTION}${STATUSLINE_STATS_SECTION}${STATUSLINE_RENDER_SECTION}`;
}

export function generateStatuslineHook(options: InitOptions): string {
  if (!options.statusline.enabled) {
    return '#!/bin/bash\n# Statusline disabled\n';
  }

  return `#!/bin/bash
# Monomind Statusline Hook
# Source this in your .bashrc/.zshrc for terminal statusline

# Function to get statusline
monomind_statusline() {
  local statusline_script="\${MONOMIND_DIR:-.claude}/helpers/statusline.cjs"
  if [ -f "$statusline_script" ]; then
    node "$statusline_script" 2>/dev/null || echo ""
  fi
}

# Bash: Add to PS1
# export PS1='$(monomind_statusline) \\n\\$ '

# Zsh: Add to RPROMPT
# export RPROMPT='$(monomind_statusline)'

# Claude Code: Add to .claude/settings.json
# "statusLine": {
#   "type": "command",
#   "command": "node .claude/helpers/statusline.cjs 2>/dev/null"
#   "when": "test -f .claude/helpers/statusline.cjs"
# }
`;
}
