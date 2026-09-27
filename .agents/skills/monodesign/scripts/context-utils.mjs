/**
 * Small generic helpers and shared constants for context.mjs's project/context
 * resolution: canonical file name lists, monorepo marker/ignore sets, and
 * path/JSON primitives used across the context-*.mjs sibling modules.
 *
 * Split out of context.mjs. See that file for context.
 */
import fs from 'node:fs';
import path from 'node:path';

export const PRODUCT_NAMES = ['PRODUCT.md', 'Product.md', 'product.md'];
export const DESIGN_NAMES = ['DESIGN.md', 'Design.md', 'design.md'];
export const FALLBACK_DIRS = ['.agents/context', 'docs'];
export const MONOREPO_MARKER_FILES = ['pnpm-workspace.yaml', 'turbo.json', 'nx.json', 'lerna.json'];
export const MONOREPO_FALLBACK_PROJECT_DIRS = ['apps', 'packages'];
export const WORKSPACE_DISCOVERY_IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.cache',
  'coverage',
]);

export function isPathInside(candidate, root) {
  const rel = path.relative(root, candidate).split(path.sep).join('/');
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function isPathInsideOrEqual(candidate, root) {
  return path.resolve(candidate) === path.resolve(root) || isPathInside(candidate, root);
}

export function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

export function firstExisting(dir, names) {
  for (const name of names) {
    const abs = path.join(dir, name);
    if (fs.existsSync(abs)) return abs;
  }
  return null;
}

export function safeRead(p) {
  try {
    return fs.readFileSync(p, 'utf-8');
  } catch {
    return null;
  }
}

export function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function hasTargetOption(options) {
  return !!(options && typeof options.targetPath === 'string' && options.targetPath.trim());
}
