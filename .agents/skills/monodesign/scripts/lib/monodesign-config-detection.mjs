/**
 * Reading and writing the detector-filter subtree (`detector.*`, with
 * back-compat fallback to legacy `hook.*`) of the unified `.monodesign`
 * config for monodesign-config.mjs.
 *
 * Split out of monodesign-config.mjs. See that file for context.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { detectorSection, getConfigPath, getLocalConfigPath, hookSection, safeReadJson, uniqueStrings } from './monodesign-config-core.mjs';
import { mergeIgnoreValues, normalizeIgnoreRule, normalizeIgnoreValueEntries } from './monodesign-config-ignore-value.mjs';
import { ensureConfigGitExclude } from './monodesign-config-consent.mjs';

const DETECTOR_CONFIG_KEYS = new Set(['ignoreRules', 'ignoreFiles', 'ignoreValues', 'designSystem']);

const DEFAULT_DETECTION_CONFIG = Object.freeze({
  ignoreRules: [],
  ignoreFiles: [],
  ignoreValues: [],
  designSystem: { enabled: true },
});

function cloneDetectionConfig() {
  return {
    ignoreRules: [],
    ignoreFiles: [],
    ignoreValues: [],
    designSystem: { ...DEFAULT_DETECTION_CONFIG.designSystem },
  };
}

function cloneRawDetectionConfig() {
  return {
    ignoreRules: [],
    ignoreFiles: [],
    ignoreValues: [],
  };
}

function applyDetectionConfigSource(config, raw) {
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
  return config;
}

/**
 * Detector filters shared by `monomind design detect` and the design hook.
 * `hook.enabled` remains hook lifecycle state; manual CLI scans still run when
 * the hook is disabled, but they honor the same ignore rules and design-system
 * toggle.
 */
export function readDetectionConfig(root) {
  const config = cloneDetectionConfig();
  for (const filePath of [getConfigPath(root), getLocalConfigPath(root)]) {
    const raw = safeReadJson(filePath);
    // Back-compat: old builds stored detector filters under hook.*.
    applyDetectionConfigSource(config, hookSection(raw));
    applyDetectionConfigSource(config, detectorSection(raw));
  }
  return config;
}

export function readRawDetectionConfig(root, opts = {}) {
  const raw = safeReadJson(opts.local ? getLocalConfigPath(root) : getConfigPath(root));
  const config = cloneRawDetectionConfig();
  applyDetectionConfigSource(config, hookSection(raw));
  applyDetectionConfigSource(config, detectorSection(raw));
  return config;
}

export function writeDetectionConfig(root, detectorConfig, opts = {}) {
  const filePath = opts.local ? getLocalConfigPath(root) : getConfigPath(root);
  if (opts.local) ensureConfigGitExclude(root);
  const existing = safeReadJson(filePath) || {};
  const existingHook = hookSection(existing);
  const nextHook = stripDetectorKeys(existingHook);
  const nextDetector = {
    ...(detectorSection(existing) || {}),
    ...normalizeDetectionConfigForWrite(detectorConfig),
  };
  const next = {
    ...existing,
    detector: nextDetector,
  };
  if (nextHook && Object.keys(nextHook).length > 0) {
    next.hook = nextHook;
  } else {
    delete next.hook;
  }
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`);
  return filePath;
}

function normalizeDetectionConfigForWrite(config) {
  const out = {};
  if (Array.isArray(config?.ignoreRules)) {
    out.ignoreRules = uniqueStrings(config.ignoreRules.map((rule) => normalizeIgnoreRule(rule)).filter(Boolean));
  }
  if (Array.isArray(config?.ignoreFiles)) {
    out.ignoreFiles = uniqueStrings(config.ignoreFiles.filter(v => typeof v === 'string' && v.trim()).map(v => v.trim()));
  }
  out.ignoreValues = normalizeIgnoreValueEntries(config?.ignoreValues || []);
  if (config?.designSystem && typeof config.designSystem === 'object' && !Array.isArray(config.designSystem)) {
    out.designSystem = {
      enabled: config.designSystem.enabled !== false,
    };
  }
  return out;
}

function stripDetectorKeys(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!DETECTOR_CONFIG_KEYS.has(key)) out[key] = value;
  }
  return out;
}
