/**
 * Monograph CLI Command
 * Knowledge graph for code and documents — build, search, inspect.
 */

import { readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';

const DOC_EXTENSIONS = new Set(['.md', '.mdx', '.txt', '.rst', '.pdf']);
const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '__pycache__',
  '.cache',
  'coverage',
  '.monomind',
  'vendor',
  'target',
]);

export function getDbPath(root: string) {
  return join(root, '.monomind', 'monograph.db');
}

export function walkDocs(dir: string, ignore: string[]): { path: string; ext: string }[] {
  const extraIgnore = new Set(ignore);
  const results: { path: string; ext: string }[] = [];
  function walk(d: string) {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (IGNORE_DIRS.has(entry) || extraIgnore.has(entry)) continue;
      const full = join(d, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full);
        continue;
      }
      const ext = extname(entry).toLowerCase();
      if (DOC_EXTENSIONS.has(ext)) results.push({ path: full, ext });
    }
  }
  walk(dir);
  return results;
}
