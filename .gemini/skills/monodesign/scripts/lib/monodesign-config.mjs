/**
 * CLI-side reader/writer for the unified `.monodesign` config.
 *
 * The CLI (published to npm) and the skill scripts (bundled into the install)
 * live in separate trees and cannot share runtime code, so this duplicates a
 * small slice of skill/scripts/hook-lib.mjs — the config-path layout, detector
 * ignore semantics, and the `.git/info/exclude` handling. Keep the schema,
 * ignore filtering, and exclude marker in sync if either side changes.
 *
 * Schema (config.json shared / config.local.json gitignored, per-developer):
 *   {
 *     "detector": { "ignoreRules": [], "ignoreFiles": [], "ignoreValues": [], "designSystem": { "enabled": true } },
 *     "hook": { "consent": "accepted" | "declined", ... },
 *     "updateCheck": bool
 *   }
 */

export { getConfigPath, getLocalConfigPath } from './monodesign-config-core.mjs';
export {
  readDetectionConfig,
  readRawDetectionConfig,
  writeDetectionConfig,
} from './monodesign-config-detection.mjs';
export {
  normalizeIgnoreValue,
  normalizeIgnoreValueEntries,
} from './monodesign-config-ignore-value.mjs';
export {
  matchesAnyGlob,
  shouldIgnoreDetectionFile,
  filterDetectionFindings,
  extractFindingIgnoreValue,
} from './monodesign-config-filter.mjs';
export {
  getHookConsent,
  setHookConsent,
  ensureConfigGitExclude,
} from './monodesign-config-consent.mjs';
