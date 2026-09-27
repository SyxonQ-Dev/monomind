import fs from 'node:fs';
import path from 'node:path';

// UI components often keep slop in a sibling/co-located stylesheet while the
// JSX edit is what triggered PostToolUse. Scan those styles too so an App.jsx
// patch doesn't report "clean" while styles.css still has Inter/bounce/etc.
const UI_CODE_EXTS = new Set(['.jsx', '.tsx', '.vue', '.svelte', '.astro']);
const STYLE_EXTS = new Set(['.css', '.scss', '.sass', '.less']);
const CO_SCAN_STYLE_NAMES = [
  'styles.css', 'styles.scss', 'styles.sass', 'styles.less',
  'index.css', 'index.scss', 'index.sass', 'index.less',
  'global.css', 'global.scss', 'global.sass', 'global.less',
  'globals.css', 'globals.scss', 'globals.sass', 'globals.less',
];
const MAX_SCAN_TARGETS = 6;

const STATIC_STYLE_IMPORT_RE = /import\s+(?:[\w*{}\s,$]+\s+from\s+)?['"]([^'"]+\.(?:css|scss|sass|less))['"]/gi;

export function hasPathTraversal(filePath) {
  return typeof filePath === 'string' && filePath.includes('..');
}

function isInsideProject(filePath, projectCwd) {
  if (!filePath || !projectCwd || hasPathTraversal(filePath)) return false;
  try {
    const rel = path.relative(projectCwd, filePath).split(path.sep).join('/');
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  } catch {
    return false;
  }
}

export function parseStaticStyleImports(content, fromFile, projectCwd) {
  if (!content || typeof content !== 'string') return [];
  const dir = path.dirname(fromFile);
  const out = [];
  for (const m of content.matchAll(STATIC_STYLE_IMPORT_RE)) {
    let p = (m[1] || '').trim();
    if (!p) continue;
    if (p.startsWith('.')) p = path.resolve(dir, p);
    else if (!path.isAbsolute(p)) p = path.resolve(projectCwd, p);
    if (!isInsideProject(p, projectCwd)) continue;
    out.push(p);
  }
  return out;
}

export function coLocatedStylesheets(filePath) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath, path.extname(filePath));
  const candidates = new Set([
    path.join(dir, `${base}.css`),
    path.join(dir, `${base}.module.css`),
    path.join(dir, `${base}.scss`),
    path.join(dir, `${base}.module.scss`),
    path.join(dir, `${base}.sass`),
    path.join(dir, `${base}.module.sass`),
    path.join(dir, `${base}.less`),
    path.join(dir, `${base}.module.less`),
  ]);
  for (const name of CO_SCAN_STYLE_NAMES) {
    candidates.add(path.join(dir, name));
  }
  return [...candidates].filter((p) => fs.existsSync(p));
}

export function normalizeScanTargets(primaryTargets, projectCwd) {
  if (!Array.isArray(primaryTargets) || primaryTargets.length === 0) return [];
  const ordered = [];
  const seen = new Set();
  const baseCwd = projectCwd || process.cwd();
  const normalizeTarget = (p) => {
    // Preserve literal `..` segments so downstream sensitive-path checks
    // still fire. path.resolve would collapse `/foo/../etc/passwd`.
    if (hasPathTraversal(p)) return p;
    return path.isAbsolute(p) ? p : path.resolve(baseCwd, p);
  };
  const add = (p) => {
    if (ordered.length >= MAX_SCAN_TARGETS) return;
    const abs = normalizeTarget(p);
    if (seen.has(abs)) return;
    seen.add(abs);
    ordered.push(abs);
    return abs;
  };

  for (const p of primaryTargets) add(p);
  return ordered;
}

export function expandScanTargets(primaryTargets, projectCwd) {
  const ordered = normalizeScanTargets(primaryTargets, projectCwd);
  if (ordered.length === 0) return [];
  const seen = new Set(ordered);
  const baseCwd = projectCwd || process.cwd();
  const add = (p) => {
    if (ordered.length >= MAX_SCAN_TARGETS) return;
    const abs = hasPathTraversal(p) ? p : (path.isAbsolute(p) ? p : path.resolve(baseCwd, p));
    if (seen.has(abs)) return;
    seen.add(abs);
    ordered.push(abs);
    return abs;
  };

  const normalizedPrimaries = [];
  for (const p of ordered) normalizedPrimaries.push(p);

  for (const p of normalizedPrimaries) {
    if (ordered.length >= MAX_SCAN_TARGETS) break;
    if (!isInsideProject(p, baseCwd)) continue;
    const ext = path.extname(p).toLowerCase();
    if (STYLE_EXTS.has(ext) || !UI_CODE_EXTS.has(ext)) continue;

    let content = '';
    try { content = fs.readFileSync(p, 'utf-8'); } catch { /* unreadable primary */ }

    for (const imp of parseStaticStyleImports(content, p, projectCwd)) {
      add(imp);
      if (ordered.length >= MAX_SCAN_TARGETS) break;
    }
    for (const col of coLocatedStylesheets(p)) {
      add(col);
      if (ordered.length >= MAX_SCAN_TARGETS) break;
    }
  }

  return ordered;
}
