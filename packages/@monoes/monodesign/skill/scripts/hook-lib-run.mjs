import fs from 'node:fs';
import path from 'node:path';
import { ALLOWED_EXTS, SENSITIVE_PATH, isGeneratedPath, EDIT_COUNT_THRESHOLD, truthy, depthIsSet, resolveCacheCwd, resolveProjectPlatform, isNativePlatform, readConfig, matchConfiguredExtension } from './hook-lib-config.mjs';
import { readCache, persistCache, ensureFile, bumpEditCount, suppressionNotice } from './hook-lib-cache.mjs';
import { matchesAnyGlob, filterFindings, dedupeAgainstCache, rememberFindings } from './hook-lib-findings.mjs';
import { renderGroupedTemplate, relativize, renderCleanAck, renderPendingAck, shouldEmitAckForFile, designSystemOptions, appendDesignSystemNote, payload } from './hook-lib-render.mjs';
import { resolveTargetFiles, resolveHarness, normalizeHookEvent } from './hook-lib-events.mjs';
import { hasPathTraversal, normalizeScanTargets, expandScanTargets } from './hook-lib-scan-targets.mjs';
import { loadDetector } from './hook-lib-detector.mjs';

/**
 * Run the hook with explicit dependencies. Returns a result object:
 *   { exitCode, stdout, audit, reason? }
 *
 * Never throws. All errors are converted to `exitCode: 0` + audit entry.
 */
export async function runHook({ stdinJson, env = {}, cwd = process.cwd(), now = Date.now, detector } = {}) {
  const audit = { ts: new Date(now()).toISOString(), event: 'PostToolUse' };
  const result = (extra) => ({ exitCode: 0, stdout: '', audit: { ...audit, ...extra } });

  try {
    // Re-entrancy guard.
    if (depthIsSet(env.MONODESIGN_HOOK_DEPTH) || depthIsSet(env.CLAUDE_HOOK_DEPTH)) {
      return result({ reentrant: true, durationMs: 0 });
    }

    if (truthy(env.MONODESIGN_HOOK_DISABLED)) {
      return result({ skipped: 'env-disabled', durationMs: 0 });
    }

    const started = Date.now();

    let event;
    try {
      event = typeof stdinJson === 'string' ? JSON.parse(stdinJson) : stdinJson;
    } catch {
      return result({ skipped: 'stdin-malformed', durationMs: Date.now() - started });
    }
    if (!event || typeof event !== 'object') {
      return result({ skipped: 'stdin-empty', durationMs: Date.now() - started });
    }

    const harness = resolveHarness(env, event);
    event = normalizeHookEvent(event, cwd, harness);
    audit.harness = harness;

    const sessionCwd = event.cwd || cwd;
    const primaryFiles = normalizeScanTargets(resolveTargetFiles(event, sessionCwd), sessionCwd);
    const projectCwd = resolveCacheCwd(primaryFiles[0], sessionCwd);
    audit.cwd = projectCwd;
    const primaryFileSet = new Set(primaryFiles);
    const targetFiles = expandScanTargets(primaryFiles, projectCwd);
    audit.session = event.session_id || null;
    if (event.tool_name) audit.tool = event.tool_name;

    if (targetFiles.length === 0) {
      return result({ skipped: 'no-file-path', durationMs: Date.now() - started });
    }

    const config = readConfig(projectCwd);
    if (config.enabled === false) {
      return result({ skipped: 'config-disabled', durationMs: Date.now() - started });
    }

    const platform = resolveProjectPlatform(projectCwd);
    if (isNativePlatform(platform)) {
      return result({ skipped: 'native-platform', platform, durationMs: Date.now() - started });
    }

    const cache = readCache(projectCwd);
    const sessionId = event.session_id || 'unknown';
    const det = detector || await loadDetector();
    if (!det || typeof det.detectText !== 'function') {
      // Cache is not mutated yet at this point; nothing to persist.
      return result({ skipped: 'detector-missing', durationMs: Date.now() - started });
    }
    const scanOptions = designSystemOptions(config, det, projectCwd);

    let pendingWinner = null;
    let cleanWinner = null;
    const freshGroups = [];
    let suppressionWinner = null;
    let detectorThrewAny = false;
    let lastSkip = 'no-scannable-file';
    let suppressedHit = false;
    let cacheDirty = false;

    for (const filePath of targetFiles) {
      audit.file = filePath;

      if (hasPathTraversal(filePath) || SENSITIVE_PATH.test(filePath)) {
        lastSkip = 'sensitive';
        continue;
      }
      if (isGeneratedPath(filePath, projectCwd)) {
        lastSkip = 'generated';
        continue;
      }

      const ext = path.extname(filePath).toLowerCase();
      const configuredExt = matchConfiguredExtension(filePath, config.extensions);
      audit.ext = configuredExt ? configuredExt.ext : ext;
      if (!ALLOWED_EXTS.has(ext) && !configuredExt) {
        lastSkip = 'extension';
        continue;
      }

      const relForMatch = relativize(filePath, projectCwd);
      if (matchesAnyGlob(relForMatch, config.ignoreFiles) || matchesAnyGlob(filePath, config.ignoreFiles)) {
        lastSkip = 'config-ignore-file';
        continue;
      }
      if (!fs.existsSync(filePath)) {
        lastSkip = 'file-missing';
        continue;
      }

      if (primaryFileSet.has(filePath)) {
        const editCount = bumpEditCount(cache, sessionId, filePath);
        cacheDirty = true;
        audit.editCount = editCount;

        if (editCount > EDIT_COUNT_THRESHOLD) {
          const wasJustCrossed = editCount === EDIT_COUNT_THRESHOLD + 1;
          if (wasJustCrossed && !suppressionWinner) {
            suppressionWinner = { filePath };
          }
          lastSkip = 'suppressed';
          suppressedHit = true;
          continue;
        }
      }

      const content = fs.readFileSync(filePath, 'utf-8');
      let findings;
      let detectorThrew = false;
      const useHtmlEngine = configuredExt
        ? configuredExt.engine === 'html'
        : (ext === '.html' || ext === '.htm');
      if (useHtmlEngine && typeof det.detectHtml === 'function') {
        try { findings = await det.detectHtml(filePath, scanOptions); } catch { findings = []; detectorThrew = true; }
      } else {
        try { findings = await det.detectText(content, filePath, scanOptions); } catch { findings = []; detectorThrew = true; }
      }

      const filtered = filterFindings(findings || [], content, ext, config);
      const fresh = dedupeAgainstCache(filtered, cache, sessionId, filePath);
      audit.findings = (findings || []).length;
      audit.freshFindings = fresh.length;

      if (fresh.length > 0) {
        rememberFindings(cache, sessionId, filePath, fresh);
        cacheDirty = true;
        freshGroups.push({ filePath, findings: fresh });
        continue;
      }

      if (detectorThrew) {
        detectorThrewAny = true;
        continue;
      }

      if (filtered.length > 0 && !pendingWinner) {
        const known = (ensureFile(cache, sessionId, filePath).findings || []).slice();
        pendingWinner = { filePath, known };
      } else if (filtered.length === 0 && !cleanWinner) {
        cleanWinner = { filePath };
      }
    }

    // Persist only when the write is earned: fresh findings justify creating
    // `.monodesign/` (dedup and suppression need it), and an already-present
    // `.monodesign/` dir marks a project that opted in. A non-UI edit, or a
    // clean UI edit in a project with no Monodesign footprint, must be a
    // no-op on disk (issues #344, #305).
    if (freshGroups.length > 0
      || (cacheDirty && fs.existsSync(path.join(projectCwd, '.monodesign')))) {
      persistCache(projectCwd, cache);
    }

    if (freshGroups.length > 0) {
      const firstGroup = freshGroups[0];
      const text = appendDesignSystemNote(renderGroupedTemplate(freshGroups, config, { cwd: projectCwd }), scanOptions);
      const allFindings = freshGroups.flatMap((group) => group.findings);
      return {
        exitCode: 0,
        stdout: payload(text, 'PostToolUse', harness),
        emission: {
          kind: 'fresh',
          file: firstGroup.filePath,
          findings: firstGroup.findings,
          groups: freshGroups,
        },
        audit: {
          ...audit,
          file: firstGroup.filePath,
          emitted: true,
          freshFiles: freshGroups.length,
          freshFindings: allFindings.length,
          chars: text.length,
          durationMs: Date.now() - started,
        },
      };
    }

    if (detectorThrewAny && !pendingWinner && !cleanWinner) {
      return result({ emitted: false, error: 'detector-threw', durationMs: Date.now() - started });
    }

    if (truthy(env.MONODESIGN_HOOK_QUIET) || config.quiet === true) {
      return result({ emitted: false, quiet: true, durationMs: Date.now() - started });
    }

    if (pendingWinner && shouldEmitAckForFile(pendingWinner.filePath, config)) {
      const text = appendDesignSystemNote(renderPendingAck(pendingWinner.filePath, pendingWinner.known, { cwd: projectCwd }), scanOptions);
      return {
        exitCode: 0,
        stdout: payload(text, 'PostToolUse', harness),
        emission: { kind: 'pending', file: pendingWinner.filePath, known: pendingWinner.known },
        audit: {
          ...audit,
          file: pendingWinner.filePath,
          emitted: true,
          kind: 'pending',
          pending: pendingWinner.known.length,
          chars: text.length,
          durationMs: Date.now() - started,
        },
      };
    }

    if (suppressionWinner) {
      const text = suppressionNotice(relativize(suppressionWinner.filePath, projectCwd));
      return {
        exitCode: 0,
        stdout: payload(text, 'PostToolUse', harness),
        emission: { kind: 'suppression', file: suppressionWinner.filePath },
        audit: {
          ...audit,
          file: suppressionWinner.filePath,
          suppressed: true,
          emitted: true,
          durationMs: Date.now() - started,
        },
      };
    }

    if (cleanWinner && shouldEmitAckForFile(cleanWinner.filePath, config)) {
      const text = appendDesignSystemNote(renderCleanAck(cleanWinner.filePath, { cwd: projectCwd }), scanOptions);
      return {
        exitCode: 0,
        stdout: payload(text, 'PostToolUse', harness),
        emission: { kind: 'clean', file: cleanWinner.filePath },
        audit: {
          ...audit,
          file: cleanWinner.filePath,
          emitted: true,
          kind: 'clean',
          chars: text.length,
          durationMs: Date.now() - started,
        },
      };
    }

    if (pendingWinner || cleanWinner) {
      return result({ emitted: false, skipped: 'non-ui-ack', durationMs: Date.now() - started });
    }

    if (suppressedHit) {
      return result({ suppressed: true, emitted: false, durationMs: Date.now() - started });
    }

    return result({ skipped: lastSkip, durationMs: Date.now() - started });
  } catch (err) {
    return {
      exitCode: 0,
      stdout: '',
      audit: { ...audit, error: String(err?.message ? err.message : err) },
    };
  }
}
