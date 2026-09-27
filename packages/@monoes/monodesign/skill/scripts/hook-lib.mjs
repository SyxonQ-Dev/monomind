/**
 * Shared library for the Monodesign design hook.
 *
 * Pure-ish helpers split out from `hook.mjs` so unit tests can exercise
 * config parsing, finding filtering, dedup, render, and cache logic without
 * spawning a subprocess. `hook.mjs` itself is the thin stdin/stdout shim.
 *
 * Public surface (everything exported is part of the contract):
 *   ENVELOPE_PREFIX, ALLOWED_EXTS, ACK_EXTS, SENSITIVE_PATH, GENERATED_PATH, TRUTHY
 *   truthy(value)
 *   readConfig(cwd) / DEFAULT_CONFIG / getConfigPath(cwd) / getLocalConfigPath(cwd)
 *   resolveProjectPlatform(cwd) / isNativePlatform(platform)
 *   normalizeIgnoreValue(value)
 *   readCache(cwd) / persistCache(cwd, cache) / resolveCacheCwd(primaryFile, sessionCwd)
 *   bumpEditCount(cache, sessionId, filePath) -> number
 *   suppressionNotice(filePath)
 *   filterFindings(findings, content, ext, config)
 *   matchConfiguredExtension(filePath, extensions)
 *   dedupeAgainstCache(findings, cache, sessionId, filePath)
 *   renderTemplate(findings, filePath, config, opts)
 *   renderCleanAck(filePath, opts) / renderPendingAck(filePath, known, opts)
 *   shouldEmitAckForFile(filePath, config?)
 *   writeAuditLog(env, entry)
 *   loadDetector() -> Promise<{ detectText, detectHtml }>
 *   matchesAnyGlob(filePath, globs)
 *   normalizeScanTargets(primaryTargets, projectCwd)
 *   runHook(deps) -> { exitCode, stdout, audit, reason? }
 *
 * Design notes:
 * - All errors are swallowed at the runHook seam. The detector throwing must
 *   never break a turn. See PRD §5 "Failure modes".
 * - Cache shape is JSON-friendly; we gc the oldest sessions when there are
 *   more than 8 to keep file size predictable across long-lived projects.
 * - The detector loader looks for `detector/detect-antipatterns.mjs` next to
 *   this file first (built skill layout) and falls back to the repo root's
 *   `cli/engine/detect-antipatterns.mjs` (running from source).
 */

export {
  ENVELOPE_PREFIX,
  ALLOWED_EXTS,
  ACK_EXTS,
  SENSITIVE_PATH,
  GENERATED_PATH,
  isGeneratedPath,
  TRUTHY,
  DEFAULT_CONFIG,
  HOOK_LOCAL_IGNORE_PATTERNS,
  EDIT_COUNT_THRESHOLD,
  truthy,
  getConfigPath,
  getLocalConfigPath,
  getCachePath,
  getPendingPath,
  resolveProjectCwd,
  resolveCacheCwd,
  resolveProjectPlatform,
  isNativePlatform,
  readConfig,
  matchConfiguredExtension,
} from './hook-lib-config.mjs';
export {
  normalizeIgnoreValue,
  normalizeIgnoreValueEntries,
} from './hook-lib-ignore.mjs';
export {
  readCache,
  persistCache,
  ensureHookGitExcludes,
  bumpEditCount,
  suppressionNotice,
} from './hook-lib-cache.mjs';
export {
  matchesAnyGlob,
  filterFindings,
  extractFindingIgnoreValue,
  dedupeAgainstCache,
  rememberFindings,
} from './hook-lib-findings.mjs';
export {
  renderTemplate,
  renderCleanAck,
  renderPendingAck,
  shouldEmitAckForFile,
  designSystemOptions,
  appendDesignSystemNote,
  payload,
} from './hook-lib-render.mjs';
export {
  parseApplyPatchPaths,
  resolveTargetFiles,
  resolveHarness,
  parseGitHubToolArgs,
  normalizeHookEvent,
} from './hook-lib-events.mjs';
export {
  parseStaticStyleImports,
  coLocatedStylesheets,
  normalizeScanTargets,
  expandScanTargets,
} from './hook-lib-scan-targets.mjs';
export {
  writeAuditLog,
  loadDetector,
  setDetectorForTesting,
} from './hook-lib-detector.mjs';
export {
  runHook,
} from './hook-lib-run.mjs';
