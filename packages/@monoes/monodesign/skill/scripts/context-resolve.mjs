/**
 * Project/context resolution for context.mjs: locating PRODUCT.md/DESIGN.md
 * for the active project, walking up to find a monorepo root, and (for the
 * CLI's target-selection prompt) discovering candidate child projects.
 *
 * Split out of context.mjs. See that file for context.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DESIGN_NAMES,
  FALLBACK_DIRS,
  MONOREPO_FALLBACK_PROJECT_DIRS,
  MONOREPO_MARKER_FILES,
  PRODUCT_NAMES,
  WORKSPACE_DISCOVERY_IGNORED_DIRS,
  firstExisting,
  hasTargetOption,
  isPathInside,
  isPathInsideOrEqual,
  safeRead,
} from './context-utils.mjs';
import {
  isExcludedByWorkspacePattern,
  normalizeWorkspacePattern,
  readWorkspacePatterns,
  resolveWorkspaceProjectRoot,
  segmentMatches,
} from './context-workspace.mjs';

export function resolveContextDir(cwd = process.cwd(), options = {}) {
  return resolveContext(cwd, options).contextDir;
}

export function loadContext(cwd = process.cwd(), options = {}) {
  const resolved = resolveContext(cwd, options);
  const absCwd = path.resolve(cwd);
  const productPath = resolved.productPath;
  const designPath = resolved.designPath;
  const product = productPath ? safeRead(productPath) : null;
  const design = designPath ? safeRead(designPath) : null;
  return {
    hasProduct: !!product,
    product,
    productPath: productPath ? path.relative(absCwd, productPath).split(path.sep).join('/') : null,
    hasDesign: !!design,
    design,
    designPath: designPath ? path.relative(absCwd, designPath).split(path.sep).join('/') : null,
    contextDir: resolved.contextDir,
    productContextDir: productPath ? path.dirname(productPath) : null,
    designContextDir: designPath ? path.dirname(designPath) : null,
    projectRoot: resolved.projectRoot,
    repoRoot: resolved.repoRoot,
    isMonorepo: resolved.isMonorepo,
  };
}

function resolveContext(cwd = process.cwd(), options = {}) {
  const absCwd = path.resolve(cwd);
  const project = resolveProject(absCwd, options);
  const projectContextDir = resolveLocalContextDir(project.projectRoot);
  // Per-file inheritance from the repo root whenever the active project is
  // nested below it: monorepo workspace children and explicit-target nested
  // products in ordinary repos behave the same way.
  const rootContextDir = project.repoRoot !== project.projectRoot
    ? resolveLocalContextDir(project.repoRoot)
    : null;

  let productPath =
    (projectContextDir ? firstExisting(projectContextDir, PRODUCT_NAMES) : null)
    || (rootContextDir ? firstExisting(rootContextDir, PRODUCT_NAMES) : null);
  let designPath =
    (projectContextDir ? firstExisting(projectContextDir, DESIGN_NAMES) : null)
    || (rootContextDir ? firstExisting(rootContextDir, DESIGN_NAMES) : null);

  let envContextDir = null;
  if (!productPath && !designPath) {
    envContextDir = resolveEnvContextDir(absCwd);
    if (envContextDir) {
      productPath = firstExisting(envContextDir, PRODUCT_NAMES);
      designPath = firstExisting(envContextDir, DESIGN_NAMES);
    }
  }

  return {
    contextDir: productPath
      ? path.dirname(productPath)
      : designPath
        ? path.dirname(designPath)
        : envContextDir || project.projectRoot,
    productPath,
    designPath,
    projectRoot: project.projectRoot,
    repoRoot: project.repoRoot,
    isMonorepo: project.isMonorepo,
    targetDir: project.targetDir,
  };
}

export function resolveProjectRoot(cwd = process.cwd(), options = {}) {
  return resolveProject(cwd, options).projectRoot;
}

export function resolveTargetSelection(cwd = process.cwd(), options = {}) {
  if (hasTargetOption(options)) return null;
  const project = resolveProject(cwd);
  if (
    !project.isMonorepo
    || !project.projectRoot
    || !project.repoRoot
    || path.resolve(project.projectRoot) !== path.resolve(project.repoRoot)
  ) {
    return null;
  }
  const targetCandidates = discoverTargetCandidates(project.repoRoot);
  // No discoverable child apps (e.g. `workspaces: ["."]`, a root-only workspace,
  // or a marker file with no apps/packages children): there is nothing to choose,
  // so treat the repo root as the active project rather than blocking on an empty
  // selection prompt that the user cannot answer.
  if (targetCandidates.length === 0) return null;
  return {
    targetPath: null,
    projectRoot: project.projectRoot,
    repoRoot: project.repoRoot,
    targetCandidates,
  };
}

function resolveProject(cwd = process.cwd(), options = {}) {
  const absCwd = path.resolve(cwd);
  const targetDir = resolveTargetDir(absCwd, options);
  let repoRoot = findMonorepoRoot(targetDir);
  if (!repoRoot && targetDir !== absCwd) {
    const cwdRepoRoot = findMonorepoRoot(absCwd);
    if (cwdRepoRoot && isPathInside(targetDir, cwdRepoRoot)) {
      repoRoot = cwdRepoRoot;
    }
  }
  if (!repoRoot) {
    return {
      targetDir,
      projectRoot: nearestTargetContextRoot(absCwd, targetDir) || absCwd,
      repoRoot: absCwd,
      isMonorepo: false,
    };
  }
  return {
    targetDir,
    projectRoot: resolveWorkspaceProjectRoot(repoRoot, targetDir) || repoRoot,
    repoRoot,
    isMonorepo: true,
  };
}

function resolveLocalContextDir(root) {
  if (firstExisting(root, [...PRODUCT_NAMES, ...DESIGN_NAMES])) {
    return root;
  }
  for (const rel of FALLBACK_DIRS) {
    const candidate = path.resolve(root, rel);
    if (firstExisting(candidate, [...PRODUCT_NAMES, ...DESIGN_NAMES])) {
      return candidate;
    }
  }
  return null;
}

function resolveEnvContextDir(cwd) {
  const envDir = process.env.MONODESIGN_CONTEXT_DIR;
  if (!envDir?.trim()) return null;
  const trimmed = envDir.trim();
  return path.isAbsolute(trimmed) ? trimmed : path.resolve(cwd, trimmed);
}

function resolveTargetDir(cwd, options = {}) {
  const targetPath = options && typeof options === 'object' ? options.targetPath : null;
  if (!targetPath || !String(targetPath).trim()) return cwd;
  const abs = path.isAbsolute(targetPath) ? targetPath : path.resolve(cwd, targetPath);
  try {
    const stat = fs.statSync(abs);
    return stat.isDirectory() ? abs : path.dirname(abs);
  } catch {
    return path.extname(abs) ? path.dirname(abs) : abs;
  }
}

function findMonorepoRoot(startDir) {
  let dir = path.resolve(startDir);
  const homeDir = path.resolve(os.homedir());
  while (true) {
    if (dir === homeDir) return null;
    // isMonorepoRoot is checked before hasGitBoundary on purpose: a workspace
    // root that also carries its own .git is still recognized. The trade-off is
    // deliberate — a directory with a monorepo *marker* but no workspace patterns
    // and no apps/packages children is not a monorepo root, so its .git stops
    // traversal and a further-up root is not searched. The nested .git is treated
    // as an independent project boundary, which is the intended isolation.
    if (isMonorepoRoot(dir)) return dir;
    if (hasGitBoundary(dir)) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function isMonorepoRoot(dir) {
  if (readWorkspacePatterns(dir).some((pattern) => !normalizeWorkspacePattern(pattern).startsWith('!'))) return true;
  if (!MONOREPO_MARKER_FILES.some((file) => fs.existsSync(path.join(dir, file)))) return false;
  return hasFallbackWorkspaceChildren(dir);
}

function hasGitBoundary(dir) {
  return fs.existsSync(path.join(dir, '.git'));
}

function hasFallbackWorkspaceChildren(dir) {
  for (const name of MONOREPO_FALLBACK_PROJECT_DIRS) {
    const base = path.join(dir, name);
    let entries;
    try {
      entries = fs.readdirSync(base, { withFileTypes: true });
    } catch {
      continue;
    }
    if (entries.some((entry) => entry.isDirectory() && !isIgnoredWorkspaceDiscoveryDir(entry.name))) return true;
  }
  return false;
}

function discoverTargetCandidates(repoRoot) {
  const roots = new Map();
  const patterns = readWorkspacePatterns(repoRoot);
  for (const pattern of patterns) {
    for (const root of discoverRootsForPattern(repoRoot, pattern)) {
      roots.set(path.relative(repoRoot, root).split(path.sep).join('/'), root);
    }
  }
  if (MONOREPO_MARKER_FILES.some((file) => fs.existsSync(path.join(repoRoot, file)))) {
    for (const name of MONOREPO_FALLBACK_PROJECT_DIRS) {
      const base = path.join(repoRoot, name);
      let entries;
      try {
        entries = fs.readdirSync(base, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || isIgnoredWorkspaceDiscoveryDir(entry.name)) continue;
        const root = path.join(base, entry.name);
        roots.set(path.relative(repoRoot, root).split(path.sep).join('/'), root);
      }
    }
  }
  return [...roots.entries()]
    .filter(([rel]) => rel && !rel.startsWith('..'))
    // Honor negated workspace patterns (e.g. "!packages/internal"). resolveWorkspaceProjectRoot
    // sends an excluded package back to the repo root, so an excluded folder must not appear as a
    // selectable target — choosing it would silently resolve to the root instead.
    .filter(([rel]) => !isExcludedByWorkspacePattern(rel.split('/').filter(Boolean), patterns))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([rel, root]) => {
      const targetExample = findTargetExample(repoRoot, root);
      return {
        name: path.basename(root),
        path: rel,
        targetExample,
        ...resolveCandidateContextSummary(repoRoot, root, targetExample),
      };
    });
}

function resolveCandidateContextSummary(repoRoot, projectRoot, targetPath) {
  const ctx = resolveContext(repoRoot, { targetPath });
  return {
    productStatus: contextSourceStatus(ctx.productPath, repoRoot, projectRoot),
    productPath: contextSourcePath(ctx.productPath, repoRoot),
    designStatus: contextSourceStatus(ctx.designPath, repoRoot, projectRoot),
    designPath: contextSourcePath(ctx.designPath, repoRoot),
  };
}

// Selection candidates surface one of four statuses: 'child' (a canonical
// PRODUCT.md/DESIGN.md directly in the app root), 'inherited' (resolved from the
// repo root in a monorepo), 'missing' (no file found), and 'fallback'. 'fallback'
// intentionally covers two non-canonical locations: a file inside the project
// root but in a subdirectory (FALLBACK_DIRS, e.g. `.agents/context/`), and a file
// outside both the project and repo roots (MONODESIGN_CONTEXT_DIR override).
function contextSourceStatus(filePath, repoRoot, projectRoot) {
  if (!filePath) return 'missing';
  const absPath = path.resolve(filePath);
  const absProjectRoot = path.resolve(projectRoot);
  const absRepoRoot = path.resolve(repoRoot);
  if (isPathInsideOrEqual(absPath, absProjectRoot)) {
    return path.dirname(absPath) === absProjectRoot ? 'child' : 'fallback';
  }
  if (absProjectRoot !== absRepoRoot && isPathInsideOrEqual(absPath, absRepoRoot)) {
    return 'inherited';
  }
  return 'fallback';
}

function contextSourcePath(filePath, repoRoot) {
  if (!filePath) return null;
  const rel = path.relative(repoRoot, filePath).split(path.sep).join('/');
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
    return rel;
  }
  return filePath;
}

function discoverRootsForPattern(repoRoot, rawPattern) {
  const pattern = normalizeWorkspacePattern(rawPattern);
  if (!pattern || pattern.startsWith('!')) return [];
  const segments = pattern.split('/').filter(Boolean);
  if (!segments.length) return [];
  const firstGlobIndex = segments.findIndex((segment) => segment.includes('*'));
  const literalPrefix = firstGlobIndex === -1 ? segments : segments.slice(0, firstGlobIndex);
  const base = path.join(repoRoot, ...literalPrefix);
  if (!fs.existsSync(base)) return [];
  if (segments.includes('**')) {
    const packageRoots = [];
    walkDirs(base, (dir) => {
      if (dir !== base && isCandidateProjectRoot(dir)) packageRoots.push(dir);
    });
    if (packageRoots.length) return packageRoots;
    return directChildDirs(base);
  }
  return expandSimplePattern(repoRoot, segments);
}

function expandSimplePattern(repoRoot, patternSegments, index = 0, current = repoRoot) {
  if (index >= patternSegments.length) return fs.existsSync(current) ? [current] : [];
  const segment = patternSegments[index];
  if (!segment.includes('*')) {
    return expandSimplePattern(repoRoot, patternSegments, index + 1, path.join(current, segment));
  }
  let entries;
  try {
    entries = fs.readdirSync(current, { withFileTypes: true });
  } catch {
    return [];
  }
  const roots = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || isIgnoredWorkspaceDiscoveryDir(entry.name)) continue;
    if (!segmentMatches(segment, entry.name)) continue;
    roots.push(...expandSimplePattern(repoRoot, patternSegments, index + 1, path.join(current, entry.name)));
  }
  return roots;
}

function directChildDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !isIgnoredWorkspaceDiscoveryDir(entry.name))
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

function walkDirs(root, visit) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || isIgnoredWorkspaceDiscoveryDir(entry.name)) continue;
    const dir = path.join(root, entry.name);
    visit(dir);
    walkDirs(dir, visit);
  }
}

function isCandidateProjectRoot(dir) {
  return !!(
    fs.existsSync(path.join(dir, 'package.json'))
    || firstExisting(dir, [...PRODUCT_NAMES, ...DESIGN_NAMES])
    || fs.existsSync(path.join(dir, 'src'))
    || fs.existsSync(path.join(dir, 'app'))
    || fs.existsSync(path.join(dir, 'pages'))
    || fs.existsSync(path.join(dir, 'public'))
  );
}

function isIgnoredWorkspaceDiscoveryDir(name) {
  return name.startsWith('.') || WORKSPACE_DISCOVERY_IGNORED_DIRS.has(name);
}

function findTargetExample(repoRoot, projectRoot) {
  const examples = [
    'src/App.jsx',
    'src/App.tsx',
    'src/main.jsx',
    'src/main.tsx',
    'src/index.jsx',
    'src/index.ts',
    'app/page.tsx',
    'pages/index.tsx',
    'public/index.html',
  ];
  for (const rel of examples) {
    const abs = path.join(projectRoot, rel);
    if (fs.existsSync(abs)) return path.relative(repoRoot, abs).split(path.sep).join('/');
  }
  return path.relative(repoRoot, projectRoot).split(path.sep).join('/');
}

function nearestTargetContextRoot(absCwd, targetDir) {
  if (!isPathInside(targetDir, absCwd)) return null;
  const rootFallbackDirs = FALLBACK_DIRS.map((rel) => path.resolve(absCwd, rel));
  let dir = path.resolve(targetDir);
  while (dir && dir !== absCwd) {
    if (!rootFallbackDirs.includes(dir) && resolveLocalContextDir(dir)) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
