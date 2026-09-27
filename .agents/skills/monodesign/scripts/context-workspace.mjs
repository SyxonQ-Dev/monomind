/**
 * Monorepo workspace pattern discovery for context.mjs: reading workspace
 * globs from package.json/pnpm-workspace.yaml/lerna.json, matching a target
 * path against them, and resolving the nearest project-like root when no
 * pattern matches.
 *
 * Split out of context.mjs. See that file for context.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  DESIGN_NAMES,
  MONOREPO_FALLBACK_PROJECT_DIRS,
  PRODUCT_NAMES,
  escapeRegExp,
  firstExisting,
  isPathInsideOrEqual,
  readJson,
} from './context-utils.mjs';

export function resolveWorkspaceProjectRoot(repoRoot, targetDir) {
  const rel = path.relative(repoRoot, targetDir).split(path.sep).join('/');
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return repoRoot;
  // rel is POSIX-normalised above, so split on '/' — splitting on path.sep here
  // returned the whole string as a single segment on Windows, no workspace
  // pattern ever matched, and every child project silently resolved to the
  // repo root instead.
  const relSegments = rel.split('/').filter(Boolean);
  const patterns = readWorkspacePatterns(repoRoot);
  const excluded = isExcludedByWorkspacePattern(relSegments, patterns);
  if (!excluded) {
    for (const pattern of patterns) {
      const projectRoot = projectRootFromWorkspacePattern(repoRoot, relSegments, pattern);
      if (projectRoot) return projectRoot;
    }
  }
  if (excluded) return repoRoot;
  if (
    relSegments.length >= 2
    && MONOREPO_FALLBACK_PROJECT_DIRS.includes(relSegments[0])
  ) {
    return path.join(repoRoot, relSegments[0], relSegments[1]);
  }
  const nearest = nearestProjectLikeRoot(repoRoot, targetDir);
  if (nearest) return nearest;
  return repoRoot;
}

export function isExcludedByWorkspacePattern(relSegments, patterns) {
  return patterns.some((rawPattern) => {
    const pattern = normalizeWorkspacePattern(rawPattern);
    if (!pattern.startsWith('!')) return false;
    return workspacePatternMatchesRel(pattern.slice(1), relSegments);
  });
}

function nearestProjectLikeRoot(repoRoot, targetDir) {
  let dir = path.resolve(targetDir);
  const stop = path.resolve(repoRoot);
  while (dir && dir !== stop) {
    if (
      firstExisting(dir, [...PRODUCT_NAMES, ...DESIGN_NAMES])
      || fs.existsSync(path.join(dir, 'package.json'))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function nearestPackageRootBetween(repoRoot, targetDir, stopDir) {
  let dir = path.resolve(targetDir);
  const stop = path.resolve(stopDir || repoRoot);
  const root = path.resolve(repoRoot);
  while (dir && dir !== stop && isPathInsideOrEqual(dir, root)) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function workspacePatternMatchesRel(pattern, relSegments) {
  const patternSegments = normalizeWorkspacePattern(pattern).split('/').filter(Boolean);
  if (!patternSegments.length) return false;
  if (patternSegments.includes('**')) {
    const firstGlobIndex = patternSegments.findIndex((segment) => segment.includes('*'));
    const literalPrefix = firstGlobIndex === -1
      ? patternSegments
      : patternSegments.slice(0, firstGlobIndex);
    if (relSegments.length < literalPrefix.length + 1) return false;
    for (let i = 0; i < literalPrefix.length; i++) {
      if (!segmentMatches(literalPrefix[i], relSegments[i])) return false;
    }
    return true;
  }
  if (relSegments.length < patternSegments.length) return false;
  for (let i = 0; i < patternSegments.length; i++) {
    if (!segmentMatches(patternSegments[i], relSegments[i])) return false;
  }
  return true;
}

export function readWorkspacePatterns(repoRoot) {
  return [
    ...readPackageWorkspaces(repoRoot),
    ...readPnpmWorkspaces(repoRoot),
    ...readLernaWorkspaces(repoRoot),
  ].filter(Boolean);
}

function readPackageWorkspaces(repoRoot) {
  const pkg = readJson(path.join(repoRoot, 'package.json'));
  const workspaces = pkg?.workspaces;
  if (Array.isArray(workspaces)) return workspaces;
  if (Array.isArray(workspaces?.packages)) return workspaces.packages;
  return [];
}

function readLernaWorkspaces(repoRoot) {
  const lerna = readJson(path.join(repoRoot, 'lerna.json'));
  return Array.isArray(lerna?.packages) ? lerna.packages : [];
}

function readPnpmWorkspaces(repoRoot) {
  try {
    const body = fs.readFileSync(path.join(repoRoot, 'pnpm-workspace.yaml'), 'utf-8');
    const patterns = [];
    let inPackages = false;
    for (const line of body.split(/\r?\n/)) {
      const trimmed = stripYamlInlineComment(line).trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const flowMatch = trimmed.match(/^packages:\s*\[(.*)\]\s*$/);
      if (flowMatch) {
        patterns.push(...parseYamlFlowList(flowMatch[1]));
        inPackages = false;
        continue;
      }
      if (/^packages:\s*$/.test(trimmed)) {
        inPackages = true;
        continue;
      }
      if (inPackages && /^[A-Za-z0-9_-]+:\s*/.test(trimmed)) break;
      if (inPackages) {
        const match = trimmed.match(/^-\s*(.+)$/);
        if (match) patterns.push(unquoteYamlValue(match[1]));
      }
    }
    return patterns;
  } catch {
    return [];
  }
}

function stripYamlInlineComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if ((ch === '"' || ch === "'") && line[i - 1] !== '\\') {
      quote = quote === ch ? null : quote || ch;
      continue;
    }
    if (ch === '#' && !quote) return line.slice(0, i);
  }
  return line;
}

function parseYamlFlowList(body) {
  const items = [];
  let quote = null;
  let current = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if ((ch === '"' || ch === "'") && body[i - 1] !== '\\') {
      quote = quote === ch ? null : quote || ch;
      current += ch;
      continue;
    }
    if (ch === ',' && !quote) {
      const value = unquoteYamlValue(current);
      if (value) items.push(value);
      current = '';
      continue;
    }
    current += ch;
  }
  const value = unquoteYamlValue(current);
  if (value) items.push(value);
  return items;
}

function unquoteYamlValue(value) {
  return String(value || '')
    .trim()
    .replace(/^['"]|['"]$/g, '');
}
function projectRootFromWorkspacePattern(repoRoot, relSegments, rawPattern) {
  const pattern = normalizeWorkspacePattern(rawPattern);
  if (!pattern || pattern.startsWith('!')) return null;
  const patternSegments = pattern.split('/').filter(Boolean);
  if (!patternSegments.length) return null;
  if (patternSegments.includes('**')) {
    return projectRootFromDoubleStarPattern(repoRoot, relSegments, patternSegments);
  }
  if (relSegments.length < patternSegments.length) return null;
  for (let i = 0; i < patternSegments.length; i++) {
    if (!segmentMatches(patternSegments[i], relSegments[i])) return null;
  }
  return path.join(repoRoot, ...relSegments.slice(0, patternSegments.length));
}

function projectRootFromDoubleStarPattern(repoRoot, relSegments, patternSegments) {
  const firstGlobIndex = patternSegments.findIndex((segment) => segment.includes('*'));
  const literalPrefix = firstGlobIndex === -1
    ? patternSegments
    : patternSegments.slice(0, firstGlobIndex);
  if (relSegments.length < literalPrefix.length + 1) return null;
  for (let i = 0; i < literalPrefix.length; i++) {
    if (!segmentMatches(literalPrefix[i], relSegments[i])) return null;
  }
  const prefixDir = path.join(repoRoot, ...literalPrefix);
  const targetDir = path.join(repoRoot, ...relSegments);
  const packageRoot = nearestPackageRootBetween(repoRoot, targetDir, prefixDir);
  if (packageRoot) return packageRoot;
  return path.join(repoRoot, ...relSegments.slice(0, literalPrefix.length + 1));
}

export function normalizeWorkspacePattern(pattern) {
  return String(pattern || '')
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');
}

export function segmentMatches(patternSegment, relSegment) {
  if (patternSegment === '*') return true;
  if (!patternSegment.includes('*')) return patternSegment === relSegment;
  const re = new RegExp(`^${escapeRegExp(patternSegment).replace(/\\\*/g, '[^/]*')}$`);
  return re.test(relSegment);
}
