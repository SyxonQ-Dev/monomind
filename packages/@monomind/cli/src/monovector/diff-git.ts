/**
 * Git diff numstat collection with a short-TTL cache.
 */

import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import * as monograph from '@monoes/monograph';
import type { DiffFile } from './diff-classifier-types.js';

const execFileAsync = promisify(execFile);

// ============================================================================
// Optimized Git Diff Functions
// ============================================================================

// Cache for diff results (TTL-based, bounded LRU)
export const diffCache = new Map<string, { files: DiffFile[]; timestamp: number }>();
const CACHE_TTL_MS = 5000; // 5 seconds - short TTL since diffs change frequently
const DIFF_CACHE_MAX_ENTRIES = 50;

/**
 * Validate git ref to prevent command injection.
 * Delegates to @monoes/monograph's shared validator (this was the reference
 * implementation it was extracted from) — kept as a local void-returning
 * wrapper so call sites below don't need to change shape.
 */
function validateGitRef(ref: string): void {
  try {
    monograph.validateGitRef(ref);
  } catch (err) {
    if (monograph.InvalidGitRefError && err instanceof monograph.InvalidGitRefError)
      throw new Error(err.message);
    throw err;
  }
}

/**
 * Get git diff statistics using SINGLE combined command (optimized)
 * Replaces two separate git commands with one
 */
export function getGitDiffNumstat(ref: string = 'HEAD'): DiffFile[] {
  // SECURITY: Validate git ref to prevent command injection
  validateGitRef(ref);

  // Check cache first
  const cacheKey = `numstat:${ref}`;
  const cached = diffCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.files;
  }

  // execFileSync imported at top of module
  try {
    // SECURITY: Use execFileSync with args array instead of shell string
    // This prevents command injection via the ref parameter
    // stdio must be fully piped: execFileSync otherwise forwards git's stderr
    // straight to the parent's terminal AND leaves err.stderr null, so the
    // thrown error below would carry no explanation of what git objected to.
    const numstatOutput = execFileSync(
      'git',
      ['diff', '--numstat', '--diff-filter=ACDMRTUXB', ref],
      { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] },
    );

    const statusOutput = execFileSync('git', ['diff', '--name-status', ref], {
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const output = `${numstatOutput}---STATUS---${statusOutput}`;

    const [numstatPart, statusPart] = output.split('---STATUS---');

    // Parse status (usually smaller, parse first)
    const statusMap = new Map<string, string>();
    if (statusPart) {
      for (const line of statusPart.trim().split('\n')) {
        if (!line) continue;
        const [status, ...pathParts] = line.split('\t');
        const path = pathParts[pathParts.length - 1] || pathParts[0];
        if (path) statusMap.set(path, status.charAt(0));
      }
    }

    // Parse numstat
    const files: DiffFile[] = [];
    if (numstatPart) {
      for (const line of numstatPart.trim().split('\n')) {
        if (!line) continue;
        const [addStr, delStr, path] = line.split('\t');
        if (!path) continue;

        const additions = addStr === '-' ? 0 : parseInt(addStr, 10) || 0;
        const deletions = delStr === '-' ? 0 : parseInt(delStr, 10) || 0;
        const binary = addStr === '-' && delStr === '-';

        const statusChar = statusMap.get(path) || 'M';
        let status: DiffFile['status'] = 'modified';
        switch (statusChar) {
          case 'A':
            status = 'added';
            break;
          case 'D':
            status = 'deleted';
            break;
          case 'R':
            status = 'renamed';
            break;
          default:
            status = 'modified';
        }

        files.push({ path, status, additions, deletions, hunks: 1, binary });
      }
    }

    // Cache the result with FIFO eviction. Without a cap, an attacker calling
    // analyze_diff with HEAD~0...HEAD~N (all valid refs) grew this Map to GBs.
    if (diffCache.size >= DIFF_CACHE_MAX_ENTRIES) {
      const oldestKey = diffCache.keys().next().value;
      if (oldestKey !== undefined) diffCache.delete(oldestKey);
    }
    diffCache.set(cacheKey, { files, timestamp: Date.now() });

    return files;
  } catch (e) {
    // Do NOT return [] here. An empty array is indistinguishable from a genuinely
    // clean diff, so a broken git invocation (not a repo, bad ref, git missing)
    // used to surface as "low risk, 0 files changed". Callers (analyze_* MCP
    // tools) already convert a throw into an explicit error response.
    throw new Error(`git diff failed for ref "${ref}": ${describeGitError(e)}`);
  }
}

/**
 * Extract a useful message from an execFile error, preferring git's own stderr.
 */
function describeGitError(e: unknown): string {
  const err = e as { stderr?: unknown; message?: unknown } | null;
  const stderr = err && typeof err.stderr === 'string' ? err.stderr.trim() : '';
  if (stderr) return stderr.split('\n')[0].slice(0, 300);
  const msg = err && typeof err.message === 'string' ? err.message : String(e);
  return msg.slice(0, 300);
}

/**
 * Async version of getGitDiffNumstat for non-blocking operation
 */
export async function getGitDiffNumstatAsync(ref: string = 'HEAD'): Promise<DiffFile[]> {
  // SECURITY: Validate git ref to prevent command injection
  validateGitRef(ref);

  // Check cache first
  const cacheKey = `numstat:${ref}`;
  const cached = diffCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.files;
  }

  // execFileAsync declared at top of module

  try {
    // SECURITY: Use execFile with args array instead of shell string
    const { stdout: numstatOutput } = await execFileAsync(
      'git',
      ['diff', '--numstat', '--diff-filter=ACDMRTUXB', ref],
      { maxBuffer: 10 * 1024 * 1024 },
    );

    const { stdout: statusOutput } = await execFileAsync('git', ['diff', '--name-status', ref], {
      maxBuffer: 10 * 1024 * 1024,
    });

    const stdout = `${numstatOutput}---STATUS---${statusOutput}`;

    const [numstatPart, statusPart] = stdout.split('---STATUS---');

    const statusMap = new Map<string, string>();
    if (statusPart) {
      for (const line of statusPart.trim().split('\n')) {
        if (!line) continue;
        const [status, ...pathParts] = line.split('\t');
        const path = pathParts[pathParts.length - 1] || pathParts[0];
        if (path) statusMap.set(path, status.charAt(0));
      }
    }

    const files: DiffFile[] = [];
    if (numstatPart) {
      for (const line of numstatPart.trim().split('\n')) {
        if (!line) continue;
        const [addStr, delStr, path] = line.split('\t');
        if (!path) continue;

        const additions = addStr === '-' ? 0 : parseInt(addStr, 10) || 0;
        const deletions = delStr === '-' ? 0 : parseInt(delStr, 10) || 0;
        const binary = addStr === '-' && delStr === '-';

        const statusChar = statusMap.get(path) || 'M';
        let status: DiffFile['status'] = 'modified';
        switch (statusChar) {
          case 'A':
            status = 'added';
            break;
          case 'D':
            status = 'deleted';
            break;
          case 'R':
            status = 'renamed';
            break;
          default:
            status = 'modified';
        }

        files.push({ path, status, additions, deletions, hunks: 1, binary });
      }
    }

    diffCache.set(cacheKey, { files, timestamp: Date.now() });
    return files;
  } catch (e) {
    // See getGitDiffNumstat: a git failure must not look like a clean diff.
    throw new Error(`git diff failed for ref "${ref}": ${describeGitError(e)}`);
  }
}

/**
 * Clear the diff cache (call when git state changes)
 */
export function clearDiffCache(): void {
  diffCache.clear();
}
