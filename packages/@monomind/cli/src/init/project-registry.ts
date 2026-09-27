/**
 * Project registry (~/.monomind-projects.json) used by executeInit() and
 * `init upgrade --all`.
 */

import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { MAX_EXEC_FILE_BYTES } from './shared.js';

/**
 * Register a project directory in ~/.monomind-projects.json so that
 * `monomind init upgrade --all` can find it without doing a directory scan.
 * Best-effort: failures are silently swallowed.
 */
export function shouldRegisterMonomindProject(dir: string): boolean {
  // A worktree is an execution view of its parent project, not an independent
  // project. Registering it makes `init upgrade --all` revisit the same
  // repository once per worktree and leaves stale entries when worktrees are
  // removed. This is intentionally path-component based so a project merely
  // containing the text ".worktrees" in another directory name is unaffected.
  const resolved = path.resolve(dir);
  if (resolved.split(path.sep).includes('.worktrees')) return false;
  // Nor is a project under the temp directory: test suites and sandboxes init
  // there by the hundred, and every entry is revisited by upgrade --all.
  const inTmp = path.relative(path.resolve(os.tmpdir()), resolved);
  return inTmp.startsWith('..') || path.isAbsolute(inTmp);
}

export function _registerMonomindProject(dir: string): void {
  if (!shouldRegisterMonomindProject(dir)) return;
  try {
    const esmReq = createRequire(import.meta.url);
    const os = esmReq('os') as typeof import('os');
    const registryPath = path.join(os.homedir(), '.monomind-projects.json');
    let reg: { projects: string[] } = { projects: [] };
    try {
      if (fs.existsSync(registryPath) && fs.statSync(registryPath).size <= MAX_EXEC_FILE_BYTES) {
        reg = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
      }
    } catch (e) {
      if (process.env.DEBUG || process.env.MONOMIND_DEBUG)
        console.error(
          '[_registerMonomindProject] ~/.monomind-projects.json unparseable, resetting:',
          e,
        );
    }
    if (!Array.isArray(reg.projects)) reg.projects = [];
    const abs = path.resolve(dir);
    if (!reg.projects.includes(abs)) {
      reg.projects.push(abs);
      fs.writeFileSync(registryPath, JSON.stringify(reg, null, 2), 'utf-8');
    }
  } catch {
    /* non-fatal */
  }
}

/**
 * Scan common locations for directories that have monomind installed
 * (presence of .claude/helpers/hook-handler.cjs is the definitive signal).
 * Searches up to maxDepth directory levels below each search root.
 */
export function findMonomindProjects(maxDepth = 3): string[] {
  const esmReq = createRequire(import.meta.url);
  const os = esmReq('os') as typeof import('os');
  const home = os.homedir();
  const searchRoots = [
    path.join(home, 'Desktop'),
    path.join(home, 'projects'),
    path.join(home, 'code'),
    path.join(home, 'work'),
    path.join(home, 'dev'),
    path.join(home, 'repos'),
    path.join(home, 'src'),
  ].filter((r) => fs.existsSync(r));

  // Also check known-projects registry if it exists
  const registryPath = path.join(home, '.monomind-projects.json');
  if (fs.existsSync(registryPath) && fs.statSync(registryPath).size <= MAX_EXEC_FILE_BYTES) {
    try {
      const reg = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
      if (Array.isArray(reg.projects)) {
        for (const p of reg.projects) {
          if (!searchRoots.includes(p) && fs.existsSync(p)) searchRoots.push(p);
        }
      }
    } catch {}
  }

  const found: Set<string> = new Set();

  function walk(dir: string, depth: number): void {
    if (depth > maxDepth) return;
    const marker = path.join(dir, '.claude', 'helpers', 'hook-handler.cjs');
    if (fs.existsSync(marker)) {
      found.add(dir);
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  }

  for (const root of searchRoots) {
    walk(root, 0);
  }
  return [...found];
}
