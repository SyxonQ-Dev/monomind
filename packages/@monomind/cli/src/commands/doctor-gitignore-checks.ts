/**
 * Doctor — .gitignore coverage check and its --fix.
 * Extracted from doctor-project-checks.ts.
 */

import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MONOMIND_NEVER_COMMIT } from '../init/never-commit.js';
import { type HealthCheck, MAX_DOCTOR_GITIGNORE_BYTES } from './doctor-env-checks.js';

// i-052: derived from MONOMIND_NEVER_COMMIT (write-runtime-config.ts), the
// single source of truth for files that must never be committed — this was
// the THIRD independently-maintained list that omitted `dashboard-token`,
// and it is the one written specifically to catch gitignore gaps. Consuming
// the shared list here means `monomind doctor --fix` (fixGitignoreCoverage
// below) appends any missing entry for existing users for free.
const REQUIRED_GITIGNORE_PATTERNS = [
  { pattern: '.monomind/sessions/', reason: 'session files contain cwd and machine paths' },
  { pattern: '.monomind/data/', reason: 'intelligence data with edit file paths' },
  { pattern: '.monomind/metrics/', reason: 'metrics with file path references' },
  { pattern: '.monomind/knowledge/', reason: 'knowledge chunks with local file content' },
  { pattern: '.monomind/*.json', reason: 'root-level runtime JSON (control, registry, routing)' },
  { pattern: '.monomind/*.jsonl', reason: 'root-level event logs (decisions, routing-feedback)' },
  { pattern: '**/.monomind/sessions/', reason: 'nested session files in sub-packages' },
  { pattern: '**/.monomind/*.json', reason: 'nested runtime JSON in sub-packages' },
  { pattern: 'data/sessions/', reason: 'session files with machine paths' },
  { pattern: 'data/mastermind-*.json', reason: 'mastermind session data' },
  { pattern: 'data/mastermind-*.jsonl', reason: 'mastermind event logs' },
  { pattern: '**/.claude-flow/', reason: 'claude-flow runtime data with paths' },
  // #398: provider API keys (`providers configure -k`) and session-derived memory DBs.
  { pattern: 'monomind.config.json', reason: 'provider API keys in plain text' },
  { pattern: '.swarm/', reason: 'swarm memory database' },
  { pattern: '.claude/memory.db', reason: 'session-derived memory database' },
  ...MONOMIND_NEVER_COMMIT.map(({ file, reason }) => ({ pattern: `.monomind/${file}`, reason })),
];

/** Strip the parts that don't change what a pattern matches, so `**​/.monomind/`,
 *  `.monomind/` and `.monomind` all compare equal. A gitignore pattern with no
 *  leading slash already matches at every depth, so `**​/` is redundant. */
function normalizeGitignorePattern(p: string): string {
  return p
    .replace(/^\/+/, '')
    .replace(/^\*\*\//, '')
    .replace(/\/+$/, '');
}

/** True when ignoring `line` already protects everything `required` covers.
 *  Beyond exact matches this understands directory containment: a repo with a
 *  blanket `.monomind/` is fully covered for `.monomind/sessions/`,
 *  `.monomind/*.json` and friends, and should not be nagged to add each one. */
function gitignoreLineCovers(line: string, required: string): boolean {
  const l = normalizeGitignorePattern(line);
  const r = normalizeGitignorePattern(required);
  if (!l) return false;
  if (l === r) return true;
  // A bare directory entry covers every path beneath it, but only when the
  // entry itself is literal — `.monomind/*.json` must not be treated as an
  // ancestor of `.monomind/sessions`.
  return !l.includes('*') && r.startsWith(`${l}/`);
}

export async function checkGitignoreCoverage(root = process.cwd()): Promise<HealthCheck> {
  const gitignorePath = join(root, '.gitignore');
  if (!existsSync(gitignorePath)) {
    // The old hint was `echo ".monomind/\n**/.monomind/" >> .gitignore`, which
    // writes a literal backslash-n (sh/bash echo does not interpret escapes
    // without -e) — one junk line matching nothing. `--fix` now writes the file
    // directly, so point at that rather than at a command to copy-paste.
    return {
      name: 'Gitignore Coverage',
      status: 'warn',
      message: 'No .gitignore found — all monomind runtime paths are unprotected',
      fix: 'monomind doctor --fix   (creates .gitignore covering .monomind/ and secrets)',
    };
  }
  if (statSync(gitignorePath).size > MAX_DOCTOR_GITIGNORE_BYTES) {
    return { name: 'Gitignore Coverage', status: 'warn', message: '.gitignore too large to parse' };
  }
  const lines = readFileSync(gitignorePath, 'utf-8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  const missing = REQUIRED_GITIGNORE_PATTERNS.filter(
    ({ pattern }) => !lines.some((l) => gitignoreLineCovers(l, pattern)),
  );
  if (missing.length === 0)
    return {
      name: 'Gitignore Coverage',
      status: 'pass',
      message: 'All monomind runtime paths are gitignored',
    };
  const missingList = missing.map((m) => m.pattern).join(', ');
  return {
    name: 'Gitignore Coverage',
    status: 'warn',
    message: `${missing.length} runtime path(s) not in .gitignore: ${missingList}`,
    fix: 'monomind doctor --fix   (appends the missing entries)',
  };
}

/** Patterns written by `doctor --fix` when there is no .gitignore at all.
 *  Covers monomind runtime state plus the standard secrets files, since a repo
 *  with no .gitignore has nothing protecting those either. The runtime paths
 *  are the specific ones the check requires, never a blanket `.monomind/`:
 *  git cannot re-include a file below an ignored directory, so a blanket line
 *  disables init's own `.monomind/.gitignore` allow-list (config.yaml,
 *  CAPABILITIES.md, org definitions). */
const GITIGNORE_FIX_PATTERNS = [
  '# monomind runtime state',
  ...REQUIRED_GITIGNORE_PATTERNS.map(({ pattern }) => pattern),
  '',
  '# secrets / local env',
  '.env',
  '.env.*',
  '!.env.example',
  '*.pem',
  '*.key',
  '',
  '# dependencies / build output',
  'node_modules/',
  'dist/',
];

/** Creates or appends the missing gitignore entries. Returns true if it wrote.
 *  Append-only and idempotent: never rewrites lines the user already has. */
export async function fixGitignoreCoverage(root = process.cwd()): Promise<boolean> {
  const gitignorePath = join(root, '.gitignore');
  try {
    if (!existsSync(gitignorePath)) {
      writeFileSync(gitignorePath, `${GITIGNORE_FIX_PATTERNS.join('\n')}\n`, 'utf-8');
      return true;
    }
    if (statSync(gitignorePath).size > MAX_DOCTOR_GITIGNORE_BYTES) return false;
    const existing = readFileSync(gitignorePath, 'utf-8');
    const lines = existing
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    const missing = REQUIRED_GITIGNORE_PATTERNS.map((m) => m.pattern).filter(
      (pattern) => !lines.some((l) => gitignoreLineCovers(l, pattern)),
    );
    if (missing.length === 0) return false;
    const prefix = existing.endsWith('\n') || existing === '' ? '' : '\n';
    appendFileSync(
      gitignorePath,
      `${prefix}\n# monomind runtime state\n${missing.join('\n')}\n`,
      'utf-8',
    );
    return true;
  } catch {
    return false;
  }
}
