/**
 * Config-file path layout and raw JSON section readers shared by the
 * monodesign-config.mjs sibling modules.
 *
 * Split out of monodesign-config.mjs. See that file for context.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function getConfigPath(root) {
  return join(root, '.monodesign', 'config.json');
}

export function getLocalConfigPath(root) {
  return join(root, '.monodesign', 'config.local.json');
}

export function safeReadJson(filePath) {
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function hookSection(raw) {
  return raw?.hook && typeof raw.hook === 'object' && !Array.isArray(raw.hook) ? raw.hook : null;
}

export function detectorSection(raw) {
  return raw?.detector && typeof raw.detector === 'object' && !Array.isArray(raw.detector) ? raw.detector : null;
}

export function uniqueStrings(values) {
  return Array.from(new Set(values.map(String)));
}
