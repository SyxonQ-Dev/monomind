'use strict';
// Runs at SessionStart — rebuilds the knowledge graph using @monoes/monograph in the background.
// Fire-and-forget: spawns detached child, logs start, exits immediately without blocking session.
// SDK-spawned org agents skip this — no need to rebuild the graph for each agent session.
if (String(process.env.MONOMIND_SDK_AGENT || '') === '1') process.exit(0);
const path = require('path');
const fs = require('fs');
const mg = require('./utils/monograph-resolve.cjs');

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const graphDir = path.join(projectDir, '.monomind', 'graph');
fs.mkdirSync(graphDir, { recursive: true });
const quiet = String(process.env.MONOMIND_HOOK_QUIET || '') === '1';

// Same resolution as the post-edit rebuild and every other hook consumer:
// project install, global npm root, then the copy bundled with the monomind
// CLI in the npx cache (#328).
const resolved = mg.resolveMonographEntry(projectDir);
const native = resolved ? mg.checkNative(resolved, projectDir) : null;
const canRebuild = resolved ? native.ok : !!mg.findMonomindBin(projectDir);
if (!canRebuild) {
  if (!resolved) {
    mg.recordRebuildFailure(projectDir, 'unresolvable',
      '@monoes/monograph not found in the project, the global npm root or the npx cache', mg.GLOBAL_FIX);
  } else {
    mg.recordRebuildFailure(projectDir, 'native', 'better-sqlite3 failed to load: ' + native.error, native.fix);
  }
  // SessionStart stdout reaches the session; stderr of this hook does not.
  const warning = mg.sessionWarning(mg.diagnose(projectDir));
  if (warning) console.log(warning);
  else if (!resolved) console.error('[graph] @monoes/monograph not found — skipping build');
  process.exit(0);
}

// #414: without git there is no HEAD to compare the index against, so every
// session would rebuild from scratch (a non-git workspace parent grew to
// 3.4 GB this way). Leave the build to the user.
if (!isGitWorkTree(projectDir)) {
  if (!quiet) console.log('[graph] not a git repository — skipping automatic graph build; run `monomind monograph build` to build it manually');
  process.exit(0);
}

// Skip if index is already fresh — don't waste CPU on every session start
const dbPath = path.join(projectDir, '.monomind', 'monograph.db');
if (fs.existsSync(dbPath) && mg.commitsBehind(projectDir, mg.readIndexedCommit(dbPath)) === 0) {
  if (!quiet) console.log('[graph] index is fresh — skipping rebuild');
  process.exit(0);
}

// Skip if another build is already in progress (avoids SQLite BUSY on concurrent init + session-start)
// P2-24: claim atomically (wx-create) instead of statSync-then-writeFileSync
// — two concurrent freshen triggers can both cross the same write-count
// threshold from parallel hook events, and a plain read-check-write lets
// both pass the check and both spawn a detached rebuild child. claimLock
// uses the same TOCTOU-safe stale-lock-break (atomic rename-to-claim) as
// control-start.cjs's spawn lock (see P2-25) — a lock older than 5 minutes
// is treated as abandoned and safely reclaimed, and so is one whose build
// process has exited.
// #414: at most one automatic full build per project every 10 minutes, so
// sessions started back to back don't each rebuild an index that is only
// "stale" because HEAD can't be compared (e.g. a repo with no commits yet).
const lastAutoBuildPath = path.join(graphDir, 'last-auto-build');
const AUTO_BUILD_INTERVAL_MS = 10 * 60 * 1000;
if (Date.now() - readLastAutoBuild(lastAutoBuildPath) < AUTO_BUILD_INTERVAL_MS) {
  if (!quiet) console.log('[graph] automatic build ran less than 10 min ago — skipping');
  process.exit(0);
}

const lockPath = path.join(graphDir, 'build.lock');
if (!mg.claimRebuildLock(lockPath, 0, 5 * 60 * 1000)) {
  if (!quiet) console.log('[graph] build already in progress — skipping');
  process.exit(0);
}

// Detached rebuild; after the build, VACUUM the DB if it has >50% bloat
// (reclaim space from delete/insert churn; opens are ~5x faster on a tight DB).
const pidPath = path.join(graphDir, 'build.pid');
const started = mg.startRebuild(projectDir, { resolved, lockPath, cleanup: [pidPath], vacuum: true });

try { fs.writeFileSync(lastAutoBuildPath, String(Date.now()), 'utf-8'); } catch { /* best-effort */ }

// Track PID so control-stop.cjs can kill it on session exit
try {
  if (started.pid) fs.writeFileSync(pidPath, String(started.pid), 'utf-8');
} catch { /* best-effort */ }

if (!quiet) console.log('[graph] background build started for ' + projectDir);

function isGitWorkTree(dir) {
  try {
    return require('child_process').execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: dir, encoding: 'utf-8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() === 'true';
  } catch { return false; }
}

function readLastAutoBuild(file) {
  try {
    const t = parseInt(fs.readFileSync(file, 'utf-8'), 10);
    return Number.isFinite(t) ? t : 0;
  } catch { return 0; }
}
