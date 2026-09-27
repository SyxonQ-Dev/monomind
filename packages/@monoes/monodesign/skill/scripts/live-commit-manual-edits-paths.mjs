/**
 * Project-relative path normalization for live-commit-manual-edits.mjs.
 *
 * Split out of live-commit-manual-edits.mjs. See that file for context.
 */

import { isGeneratedFile } from './lib/is-generated.mjs';
import fs from 'node:fs';
import path from 'node:path';

function normalizeProjectSourcePath(cwd, file, opts = {}) {
  if (!file || typeof file !== 'string') return null;
  const absolute = path.isAbsolute(file) ? file : path.resolve(cwd, file);
  const relative = path.relative(cwd, absolute).split(path.sep).join('/');
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  if (opts.requireExists && !fs.existsSync(absolute)) return null;
  if (isGeneratedFile(absolute, { cwd })) return null;
  return relative;
}

export function normalizeRelativeFile(cwd, file) {
  return normalizeProjectSourcePath(cwd, file, { requireExists: true });
}

export function normalizeRollbackPath(cwd, file) {
  return normalizeProjectSourcePath(cwd, file);
}
