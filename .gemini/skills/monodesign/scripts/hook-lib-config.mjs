import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractPlatform, loadContext } from './context.mjs';
import { mergeIgnoreValues } from './hook-lib-ignore.mjs';
import { envProjectDir } from './hook-lib-events.mjs';
import { hasPathTraversal } from './hook-lib-scan-targets.mjs';

export const ENVELOPE_PREFIX = '[monodesign@1]';

export const ALLOWED_EXTS = new Set([
  '.tsx', '.jsx', '.html', '.htm', '.vue', '.svelte', '.astro',
  '.css', '.scss', '.sass', '.less', '.ts', '.js',
]);

export const ACK_EXTS = new Set([
  '.tsx', '.jsx', '.html', '.htm', '.vue', '.svelte', '.astro',
  '.css', '.scss', '.sass', '.less',
]);

// Hard-skip regex for sensitive files. Cannot be turned off via config.
// Match tokenized secret/credential filenames, not UI names such as
// CredentialForm.tsx, SecretPage.jsx, or secretary-dashboard.vue.
export const SENSITIVE_PATH = new RegExp([
  String.raw`(?:^|[/\\])\.env(?:\.|$)`,
  String.raw`(?:^|[/\\])\.git(?:[/\\]|$)`,
  String.raw`(?:^|[/\\])id_rsa(?:$|[._-])[^/\\]*$`,
  String.raw`(?:^|[/\\])[^/\\]*\.pem$`,
  String.raw`(?:^|[/\\])(?:[^/\\]*[._-])?(?:secret|secrets|credential|credentials)(?=[._-])[^/\\]*\.(?:json|ya?ml|toml|ini|conf|config|env|txt|key|cert|crt|pem|js|ts)$`,
].join('|'), 'i');

// Hard-skip regex for generated, lock, minified, and build-output paths.
export const GENERATED_PATH = /(?:\.generated\.[a-z]+$|\.d\.ts$|\.min\.[a-z]+$|[/\\]node_modules[/\\]|[/\\](?:dist|build|out|\.next|\.cache|coverage)[/\\]|[/\\]?[^/\\]+\.lock(?:\.json)?$)/i;

// GENERATED_PATH checked against the path inside the project, so a project
// that lives under e.g. ~/.cache/ or /srv/build/ is still scanned. Paths
// outside the project root fall back to the absolute path.
export function isGeneratedPath(filePath, projectRoot) {
  const rel = path.relative(path.resolve(projectRoot), path.resolve(filePath));
  const inside = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  return GENERATED_PATH.test(inside ? path.sep + rel : filePath);
}

export const TRUTHY = /^(1|true|yes|on)$/i;

export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  quiet: false,
  auditLog: null,
  designSystem: { enabled: true },
  ignoreRules: [],
  ignoreFiles: [],
  ignoreValues: [],
  extensions: [],
  limits: { maxFindings: 5, maxChars: 8000 },
});

export const HOOK_LOCAL_IGNORE_PATTERNS = Object.freeze([
  '.monodesign/hook.cache.json',
  '.monodesign/hook.pending.json',
  '.monodesign/config.local.json',
]);


export const EDIT_COUNT_THRESHOLD = 6;

export function truthy(value) {
  return typeof value === 'string' && TRUTHY.test(value);
}

export function depthIsSet(value) {
  if (value === undefined || value === null) return false;
  const text = String(value).trim();
  if (!text) return false;
  if (TRUTHY.test(text)) return true;
  return /^\d+$/.test(text) && Number(text) > 0;
}

export function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

export function getConfigPath(cwd) {
  return path.join(cwd, '.monodesign', 'config.json');
}

export function getLocalConfigPath(cwd) {
  return path.join(cwd, '.monodesign', 'config.local.json');
}

export function getCachePath(cwd) {
  return path.join(cwd, '.monodesign', 'hook.cache.json');
}

export function getPendingPath(cwd) {
  return path.join(cwd, '.monodesign', 'hook.pending.json');
}

export function resolveProjectCwd(event, fallback = process.cwd()) {
  return event?.cwd
    || (Array.isArray(event?.workspace_roots) && event.workspace_roots[0])
    || envProjectDir(fallback)
    || fallback;
}

function looksLikeProjectRoot(dir) {
  return ['.git', 'package.json', '.monodesign'].some((marker) => {
    try { return fs.existsSync(path.join(dir, marker)); } catch { return false; }
  });
}

// Where `.monodesign/` (cache + config) lives for this event. Normally the
// session cwd, untouched. But when the agent was launched from an umbrella
// directory that is not itself a project (no .git, package.json, or
// .monodesign), key to the edited file's nearest project root instead, so a
// multi-project launch dir doesn't accumulate a shared cross-project cache
// (issue #305). Climbing stops at the home dir, falling back to the session
// cwd when no marker is found.
export function resolveCacheCwd(primaryFile, sessionCwd) {
  const base = path.resolve(sessionCwd || process.cwd());
  if (!primaryFile || typeof primaryFile !== 'string' || hasPathTraversal(primaryFile)) return base;
  if (looksLikeProjectRoot(base)) return base;
  let dir;
  try {
    dir = path.dirname(path.resolve(primaryFile));
  } catch {
    return base;
  }
  const home = path.resolve(os.homedir());
  while (true) {
    if (dir === home) return base;
    if (looksLikeProjectRoot(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return base;
    dir = parent;
  }
}

// The detector's rules are web rules (HTML/CSS shapes), but a React Native or
// Flutter project is made of the exact extensions the hook watches (.tsx, .ts,
// .js), so without this gate every native screen edit would draw web-shaped
// findings that contradict the native platform references. PRODUCT.md's
// `## Platform` field decides: `ios` / `android` / `adaptive` projects skip
// the scan entirely. Resolution goes through loadContext so the hook reads the
// same PRODUCT.md the skill does (alternate context dirs, monorepo fallback).
export function resolveProjectPlatform(cwd) {
  try {
    const ctx = loadContext(cwd);
    return extractPlatform(ctx?.product);
  } catch {
    return null;
  }
}

export function isNativePlatform(platform) {
  return platform === 'ios' || platform === 'android' || platform === 'adaptive';
}

export function readConfig(cwd) {
  const config = cloneDefaultConfig();
  // Hook runtime settings live under `hook`; detector filters live under
  // `detector`. Back-compat: older configs stored detector filters in `hook`,
  // so read those first and let canonical `detector` settings win.
  for (const filePath of [getConfigPath(cwd), getLocalConfigPath(cwd)]) {
    const raw = safeReadJson(filePath);
    applyConfigSource(config, hookSection(raw));
    applyDetectorConfigSource(config, detectorSection(raw));
  }
  return config;
}

// The hook settings subtree of a unified config.json / config.local.json.
function hookSection(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return raw.hook && typeof raw.hook === 'object' && !Array.isArray(raw.hook) ? raw.hook : null;
}

function detectorSection(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return raw.detector && typeof raw.detector === 'object' && !Array.isArray(raw.detector) ? raw.detector : null;
}

function numberOr(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function cloneDefaultConfig() {
  return {
    ...DEFAULT_CONFIG,
    ignoreRules: [],
    ignoreFiles: [],
    ignoreValues: [],
    extensions: [],
    designSystem: { ...DEFAULT_CONFIG.designSystem },
    limits: { ...DEFAULT_CONFIG.limits },
  };
}

function applyDetectorConfigSource(config, raw) {
  if (!raw || typeof raw !== 'object') return config;
  if (raw.designSystem && typeof raw.designSystem === 'object' && !Array.isArray(raw.designSystem)) {
    config.designSystem = {
      ...config.designSystem,
      enabled: raw.designSystem.enabled !== false,
    };
  }
  if (Array.isArray(raw.ignoreRules)) {
    config.ignoreRules = uniqueStrings([...config.ignoreRules, ...raw.ignoreRules]);
  }
  if (Array.isArray(raw.ignoreFiles)) {
    config.ignoreFiles = uniqueStrings([...config.ignoreFiles, ...raw.ignoreFiles]);
  }
  if (Array.isArray(raw.ignoreValues)) {
    config.ignoreValues = mergeIgnoreValues(config.ignoreValues, raw.ignoreValues);
  }
  if (Array.isArray(raw.extensions)) {
    config.extensions = mergeExtensions(config.extensions, raw.extensions);
  }
  return config;
}

// Extra scanned extensions from `detector.extensions` config. Entries are
// `{ ext, engine }` (engine 'html' | 'text', default 'html' — the common case
// for server-side templates) or bare strings as shorthand. Extensions are
// matched against the end of the filename, not path.extname, so double
// extensions like `.blade.php` and `.html.erb` work (issue #316).
function normalizeExtensionEntries(entries) {
  if (!Array.isArray(entries)) return [];
  const out = [];
  for (const entry of entries) {
    const raw = typeof entry === 'string' ? entry : entry?.ext;
    if (typeof raw !== 'string') continue;
    let ext = raw.trim().toLowerCase();
    if (!ext) continue;
    if (!ext.startsWith('.')) ext = `.${ext}`;
    const engine = (!(typeof entry === 'string') && entry?.engine === 'text') ? 'text' : 'html';
    out.push({ ext, engine });
  }
  return out;
}

function mergeExtensions(existing, incoming) {
  const map = new Map();
  for (const entry of normalizeExtensionEntries(existing)) map.set(entry.ext, entry);
  for (const entry of normalizeExtensionEntries(incoming)) map.set(entry.ext, entry);
  return Array.from(map.values());
}

export function matchConfiguredExtension(filePath, extensions) {
  if (!Array.isArray(extensions) || extensions.length === 0) return null;
  const name = path.basename(String(filePath || '')).toLowerCase();
  if (!name) return null;
  // The longest matching suffix wins, so `.blade.php` beats a broader `.php`
  // entry regardless of config order.
  let best = null;
  for (const entry of normalizeExtensionEntries(extensions)) {
    if (name.length > entry.ext.length && name.endsWith(entry.ext)
      && (!best || entry.ext.length > best.ext.length)) {
      best = entry;
    }
  }
  return best;
}

function applyConfigSource(config, raw) {
  if (!raw || typeof raw !== 'object') return config;
  if (Object.hasOwn(raw, 'enabled')) {
    config.enabled = raw.enabled !== false;
  }
  if (Object.hasOwn(raw, 'quiet')) {
    config.quiet = raw.quiet === true;
  }
  if (typeof raw.auditLog === 'string' && raw.auditLog.trim()) {
    config.auditLog = raw.auditLog.trim();
  }
  applyDetectorConfigSource(config, raw);
  if (raw.limits && typeof raw.limits === 'object') {
    config.limits = {
      maxFindings: numberOr(raw.limits.maxFindings, config.limits.maxFindings),
      maxChars: numberOr(raw.limits.maxChars, config.limits.maxChars),
    };
  }
  return config;
}

export function uniqueStrings(values) {
  return Array.from(new Set(values.map(String)));
}
