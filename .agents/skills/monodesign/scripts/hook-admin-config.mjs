/**
 * Reading and writing the `hook`/`detector` subtrees of
 * .monodesign/config.json / .monodesign/config.local.json for hook-admin.mjs.
 *
 * Split out of hook-admin.mjs. See that file for context.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  getConfigPath,
  getLocalConfigPath,
  DEFAULT_CONFIG,
  ensureHookGitExcludes,
  normalizeIgnoreValueEntries,
} from './hook-lib.mjs';

const DETECTOR_CONFIG_KEYS = new Set(['ignoreRules', 'ignoreFiles', 'ignoreValues', 'designSystem']);

export function readRawConfigFile(filePath) {
  if (!fs.existsSync(filePath)) return { exists: false, malformed: false, raw: null };
  try {
    return { exists: true, malformed: false, raw: JSON.parse(fs.readFileSync(filePath, 'utf-8')) };
  } catch {
    return { exists: true, malformed: true, raw: null };
  }
}


function hookSection(unified) {
  return unified && typeof unified === 'object' && !Array.isArray(unified) && unified.hook && typeof unified.hook === 'object' && !Array.isArray(unified.hook)
    ? unified.hook
    : null;
}

function detectorSection(unified) {
  return unified && typeof unified === 'object' && !Array.isArray(unified) && unified.detector && typeof unified.detector === 'object' && !Array.isArray(unified.detector)
    ? unified.detector
    : null;
}

export function readRawHookConfig(cwd, opts = {}) {
  const unified = readRawConfigFile(opts.local ? getLocalConfigPath(cwd) : getConfigPath(cwd)).raw;
  return hookSection(unified);
}

export function readRawDetectorConfig(cwd, opts = {}) {
  const unified = readRawConfigFile(opts.local ? getLocalConfigPath(cwd) : getConfigPath(cwd)).raw;
  const merged = mergeDetectorConfig(hookSection(unified));
  return mergeDetectorConfig(detectorSection(unified), merged);
}

function stripDetectorKeys(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!DETECTOR_CONFIG_KEYS.has(key)) out[key] = value;
  }
  return out;
}

// Write hook runtime config under `hook`, leaving detector filters in
// `detector` and preserving sibling keys such as updateCheck.
export function writeHookConfig(cwd, hookConfig, opts = {}) {
  const filePath = opts.local ? getLocalConfigPath(cwd) : getConfigPath(cwd);
  if (opts.local) ensureHookGitExcludes(cwd);
  const existingRaw = readRawConfigFile(filePath).raw;
  const existing = existingRaw && typeof existingRaw === 'object' && !Array.isArray(existingRaw) ? existingRaw : {};
  const existingHook = stripDetectorKeys(hookSection(existing));
  // Merge over the existing hook object so fields the merge helpers don't manage
  // (consent, quiet, auditLog) survive an Monodesign hooks edit.
  const next = { ...existing, hook: { ...existingHook, ...hookConfig } };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`);
  return filePath;
}

export function writeDetectorConfig(cwd, detectorConfig, opts = {}) {
  const filePath = opts.local ? getLocalConfigPath(cwd) : getConfigPath(cwd);
  if (opts.local) ensureHookGitExcludes(cwd);
  const existingRaw = readRawConfigFile(filePath).raw;
  const existing = existingRaw && typeof existingRaw === 'object' && !Array.isArray(existingRaw) ? existingRaw : {};
  const nextHook = stripDetectorKeys(hookSection(existing));
  const existingDetector = mergeDetectorConfig(detectorSection(existing));
  const next = {
    ...existing,
    detector: mergeDetectorConfig(detectorConfig, existingDetector),
  };
  if (Object.keys(nextHook).length > 0) next.hook = nextHook;
  else delete next.hook;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`);
  return filePath;
}

export function mergeHookConfig(existing) {
  const base = existing && typeof existing === 'object' ? existing : {};
  return {
    enabled: base.enabled !== false,
    limits: {
      maxFindings: Number.isFinite(base?.limits?.maxFindings) ? base.limits.maxFindings : DEFAULT_CONFIG.limits.maxFindings,
      maxChars: Number.isFinite(base?.limits?.maxChars) ? base.limits.maxChars : DEFAULT_CONFIG.limits.maxChars,
    },
  };
}

export function mergeDetectorConfig(existing, seed = null) {
  const base = existing && typeof existing === 'object' ? existing : {};
  const out = seed ? {
    ignoreRules: [...seed.ignoreRules],
    ignoreFiles: [...seed.ignoreFiles],
    ignoreValues: normalizeIgnoreValueEntries(seed.ignoreValues),
  } : {
    ignoreRules: [],
    ignoreFiles: [],
    ignoreValues: [],
  };
  if (seed?.designSystem && typeof seed.designSystem === 'object' && !Array.isArray(seed.designSystem)) {
    out.designSystem = { ...seed.designSystem };
  }
  if (base.designSystem && typeof base.designSystem === 'object' && !Array.isArray(base.designSystem)) {
    out.designSystem = {
      ...(out.designSystem || {}),
      enabled: base.designSystem.enabled !== false,
    };
  }
  if (Array.isArray(base.ignoreRules)) {
    out.ignoreRules = Array.from(new Set([...out.ignoreRules, ...base.ignoreRules.map(String)]));
  }
  if (Array.isArray(base.ignoreFiles)) {
    out.ignoreFiles = Array.from(new Set([...out.ignoreFiles, ...base.ignoreFiles.map(String)]));
  }
  if (Array.isArray(base.ignoreValues)) {
    out.ignoreValues = mergeIgnoreValueEntries(out.ignoreValues, base.ignoreValues);
  }
  return out;
}

function mergeIgnoreValueEntries(existing, incoming) {
  const map = new Map();
  for (const entry of normalizeIgnoreValueEntries(existing)) {
    map.set(ignoreValueEntryKey(entry), entry);
  }
  for (const entry of normalizeIgnoreValueEntries(incoming)) {
    map.set(ignoreValueEntryKey(entry), entry);
  }
  return Array.from(map.values());
}

function ignoreValueEntryKey(entry) {
  const files = Array.isArray(entry.files) && entry.files.length > 0 ? entry.files.join('\x1f') : '';
  return `${entry.rule}\0${entry.value}\0${files}`;
}
