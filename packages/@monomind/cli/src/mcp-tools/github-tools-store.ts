/**
 * GitHub MCP Tools — local store and `gh`/`git` command helpers.
 * Extracted from github-tools.ts.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getProjectCwd } from './types.js';

// Storage paths
const STORAGE_DIR = '.monomind';
const GITHUB_DIR = 'github';
const GITHUB_FILE = 'store.json';

export interface RepoInfo {
  owner: string;
  name: string;
  branch: string;
  lastAnalyzed?: string;
  metrics?: {
    commits: number;
    branches: number;
    contributors: number;
    openIssues: number;
    openPRs: number;
  };
}

export interface GitHubStore {
  repos: Record<string, RepoInfo>;
  prs: Record<
    string,
    { id: string; number: number; title: string; status: string; branch: string; createdAt: string }
  >;
  issues: Record<
    string,
    { id: string; title: string; status: string; labels: string[]; createdAt: string }
  >;
  version: string;
}

function getGitHubDir(): string {
  return join(getProjectCwd(), STORAGE_DIR, GITHUB_DIR);
}

function getGitHubPath(): string {
  return join(getGitHubDir(), GITHUB_FILE);
}

function ensureGitHubDir(): void {
  const dir = getGitHubDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function loadGitHubStore(): GitHubStore {
  try {
    const path = getGitHubPath();
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, 'utf-8'));
    }
  } catch (e) {
    if (process.env.DEBUG || process.env.MONOMIND_DEBUG)
      console.error('[github-tools] failed to parse store.json, using empty store:', e);
  }
  return { repos: {}, prs: {}, issues: {}, version: '3.0.0' };
}

export function saveGitHubStore(store: GitHubStore): void {
  ensureGitHubDir();
  const tmpPath = `${getGitHubPath()}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(store, null, 2), 'utf-8');
  renameSync(tmpPath, getGitHubPath());
}

/** Run a trusted static shell command (no user input), return stdout or null on failure */
export function run(cmd: string, cwd?: string): string | null {
  try {
    return execFileSync(cmd.split(' ')[0], cmd.split(' ').slice(1), {
      encoding: 'utf-8',
      timeout: 15000,
      cwd: cwd || getProjectCwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

/** Run a command with user-provided args as separate array elements (no shell injection) */
export function runSafe(cmd: string, args: string[], cwd?: string): string | null {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf-8',
      timeout: 15000,
      cwd: cwd || getProjectCwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

/** Result of a gh CLI invocation that preserves whether it actually ran and failed. */
type GhResult = { ok: true; stdout: string } | { ok: false; error: string };

/** Run a `gh` command and preserve the real failure reason instead of collapsing to null. */
export function runSafeResult(cmd: string, args: string[], cwd?: string): GhResult {
  try {
    const stdout = execFileSync(cmd, args, {
      encoding: 'utf-8',
      timeout: 15000,
      cwd: cwd || getProjectCwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return { ok: true, stdout };
  } catch (err) {
    const e = err as { stderr?: string | Buffer; message?: string };
    const stderr = e.stderr ? String(e.stderr).trim() : '';
    return { ok: false, error: stderr || e.message || 'gh command failed' };
  }
}

/** Check if gh CLI is available */
export function hasGhCli(): boolean {
  return run('gh --version') !== null;
}

/**
 * Validate that a MCP input value is a safe positive integer suitable for use
 * as a GitHub PR/issue number in CLI arguments.  Returns the integer value on
 * success, or null if the input is missing, non-finite, negative, zero, or
 * non-integer.  Using this guard before string-interpolating the value into a
 * command template prevents argument-injection attacks where an MCP client
 * sends a non-numeric string (e.g. "1 --label evil") that gets split into
 * extra CLI flags when `run()` tokenises the command on whitespace.
 */
export function safeGitHubNumber(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n !== Math.floor(n)) return null;
  return n;
}
