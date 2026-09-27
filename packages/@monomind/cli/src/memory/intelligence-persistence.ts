/**
 * V1 Intelligence Module — persistence configuration
 * Split out of intelligence.ts (file-size sweep). Pure move: paths, the
 * multi-process-safe patterns.json lock, and the stats file path.
 *
 * @module v1/cli/intelligence
 */

import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// ============================================================================
// Persistence Configuration
// ============================================================================

/**
 * Get the data directory for neural pattern persistence
 * Uses .monomind/neural in the current working directory,
 * falling back to home directory
 */
export function getDataDir(): string {
  // MONOMIND_CWD is the project root; process.cwd() is wherever the process
  // happened to start. For a global or MCP install those differ — the server
  // is launched by the editor, not from the project — so keying the pattern
  // store off cwd scattered a project's learned patterns across whatever
  // directory the server booted in (or fell through to ~/.monomind entirely).
  // Every other consumer resolves the project this way; see getProjectCwd()
  // in mcp-tools/types.ts. Inlined rather than imported to keep the memory
  // layer independent of the MCP tool layer.
  const cwd = process.env.MONOMIND_CWD || process.cwd();
  const localDir = join(cwd, '.monomind', 'neural');
  const homeDir = join(homedir(), '.monomind', 'neural');

  // Prefer local directory if .monomind exists
  if (existsSync(join(cwd, '.monomind'))) {
    return localDir;
  }

  return homeDir;
}

/**
 * Ensure the data directory exists
 */
export function ensureDataDir(): string {
  const dir = getDataDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Get the patterns file path
 */
export function getPatternsPath(): string {
  return join(getDataDir(), 'patterns.json');
}

// ── multi-process-safe patterns.json flush (P1-14) ─────────────────────────
// patterns.json can be flushed by more than one process at once — e.g. the
// long-lived MCP server process and a short-lived CJS hook subprocess each
// load their own in-memory copy, then flush independently. Without a lock +
// re-read-before-write, whichever flush lands last silently erases whatever
// the other process added since its own load. flushToDisk() below re-reads
// the current on-disk file immediately before writing and merges this
// process's in-memory patterns in by `id` (keeping whichever record has the
// newer `lastUsedAt`), guarded by a short advisory lock.

export function getPatternsLockPath(): string {
  return `${getPatternsPath()}.lock`;
}

export const PATTERNS_LOCK_STALE_MS = 10_000; // single JSON write — 10s is generous

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/**
 * Mirrors the stale-lock-breaking pattern in
 * .claude/helpers/control-start.cjs (claimSpawnLock/releaseSpawnLock):
 * wx-flag write to claim, break the lock if its holder is dead or the lock
 * is older than the stale threshold, retry once, then give up and proceed
 * unlocked (best-effort — a missed lock still merges via the re-read, it
 * just narrows a tiny TOCTOU window further).
 */
export function claimPatternsLock(): boolean {
  const lockPath = getPatternsLockPath();
  try {
    mkdirSync(dirname(lockPath), { recursive: true });
  } catch {
    /* ignore */
  }
  try {
    writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
    return true;
  } catch {
    try {
      const stat = statSync(lockPath);
      const holder = Number(readFileSync(lockPath, 'utf-8'));
      if (Date.now() - stat.mtimeMs < PATTERNS_LOCK_STALE_MS && isPidAlive(holder)) return false;
      unlinkSync(lockPath);
      writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
      return true;
    } catch {
      return false;
    }
  }
}

export function releasePatternsLock(): void {
  const lockPath = getPatternsLockPath();
  try {
    if (Number(readFileSync(lockPath, 'utf-8')) === process.pid) unlinkSync(lockPath);
  } catch {
    /* ignore */
  }
}

/**
 * Get the stats file path
 */
export function getStatsPath(): string {
  return join(getDataDir(), 'stats.json');
}
