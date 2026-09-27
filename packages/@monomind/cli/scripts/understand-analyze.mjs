#!/usr/bin/env node
/**
 * understand-analyze.mjs — Built-in semantic enrichment engine for monomind:understand
 *
 * Ported from Understand-Anything (understand-anything-plugin/packages/core).
 * Ships inside @monomind/cli — no external plugin needed.
 *
 * Reads file nodes from monograph.db, calls the Anthropic API to generate
 * summaries, tags, complexity, and architectural layers, then writes results
 * back into the DB (and optionally emits a graph.json).
 *
 * Usage:
 *   node understand-analyze.mjs [options]
 *
 * Options:
 *   --dir <path>          Project directory (default: cwd)
 *   --db  <path>          monograph.db path (default: <dir>/.monomind/monograph.db)
 *   --output <path>       Write a graph.json here (default: <dir>/.understand/knowledge-graph.json)
 *   --batch-size <N>      Files per LLM batch (default: 5)
 *   --max-files <N>       Stop after N files (0 = all, default: 0)
 *   --dry-run             Print what would happen without writing to DB
 *   --no-llm              Heuristic-only mode (layers + tags from paths, no API calls)
 *   --layers-only         Skip per-file analysis, only (re-)detect layers
 *
 * Designed to be invoked by the /monomind:understand slash command. The
 * slash command runs the script in --no-llm mode and orchestrates the
 * per-file summarization through the active Claude Code session.
 *
 * File-size sweep: layer detection lives in understand-analyze-layers.mjs,
 * Anthropic API helpers + prompts in understand-analyze-llm.mjs,
 * .understandignore support in understand-analyze-ignore.mjs, git helpers in
 * understand-analyze-git.mjs, language/framework detection in
 * understand-analyze-detect.mjs, the onboarding guide builder in
 * understand-analyze-onboard.mjs, and graph.json assembly in
 * understand-analyze-graph.mjs.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname, basename, relative } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execSync, spawn } from 'node:child_process';
import { detectAndWriteLayers } from './understand-analyze-layers.mjs';
import { ANTHROPIC_API_KEY, callClaude, parseJson, buildFilePrompt, buildBatchPrompt } from './understand-analyze-llm.mjs';
import { loadIgnorePatterns, makeIgnoreMatcher } from './understand-analyze-ignore.mjs';
import { getChangedFiles, getCurrentCommitHash } from './understand-analyze-git.mjs';
import { readFileSafe, buildOnboardingGuide } from './understand-analyze-onboard.mjs';
import { buildGraphJson } from './understand-analyze-graph.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const CWD   = process.cwd();

// ── CLI argument helpers ─────────────────────────────────────────────────────
function argVal(name) {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 ? process.argv[i + 1] : null;
}
const hasFlag = (f) => process.argv.includes('--' + f);

const projectDir  = resolve(argVal('dir')  || CWD);
const dbPathArg   = argVal('db')   ? resolve(argVal('db'))   : join(projectDir, '.monomind', 'monograph.db');
const outputArg   = argVal('output')? resolve(argVal('output')) : join(projectDir, '.understand', 'knowledge-graph.json');
const batchSize      = parseInt(argVal('batch-size') || '5',  10);
const maxFiles       = parseInt(argVal('max-files')  || '0',  10);
const dryRun               = hasFlag('dry-run');
const noLlm                = hasFlag('no-llm');
const layersOnly           = hasFlag('layers-only');
const incremental          = hasFlag('incremental');
const importAnalysesStdin  = hasFlag('import-analyses-stdin');
const onboard              = hasFlag('onboard');
const onboardOut     = argVal('onboard-out') ? resolve(argVal('onboard-out')) : join(projectDir, 'ONBOARDING.md');

// ── Resolve @monoes/monograph for DB access ──────────────────────────────────
function resolveMonograph() {
  const req = createRequire(import.meta.url);
  const candidates = [
    // CLI package's own node_modules (npx / global npm install)
    join(__dir, '..', 'node_modules', '@monoes', 'monograph'),
    // Global npm / homebrew
    (() => { try { return join(req.resolve('npm/bin/npm-cli.js'), '..', '..', '..', '@monoes', 'monograph'); } catch { return null; } })(),
    // Monorepo root
    join(__dir, '..', '..', '..', '..', 'node_modules', '@monoes', 'monograph'),
    // User project
    join(projectDir, 'node_modules', '@monoes', 'monograph'),
  ].filter(Boolean);

  for (const c of candidates) {
    try {
      if (existsSync(c)) return req(c);
    } catch {}
  }
  // Last resort: require by name (works when installed globally)
  try { return req('@monoes/monograph'); } catch {}
  return null;
}

const _ignorePatterns = loadIgnorePatterns(projectDir);
const isIgnoredByUser = makeIgnoreMatcher(_ignorePatterns);

const SKIP_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp',
  '.pdf', '.zip', '.tar', '.gz', '.wasm', '.map',
  '.lock', '.lockb', '.db', '.sqlite', '.bin', '.exe',
]);
function shouldAnalyze(filePath) {
  if (!filePath) return false;
  const ext = '.' + filePath.split('.').pop()?.toLowerCase();
  if (SKIP_EXTENSIONS.has(ext)) return false;
  if (isIgnoredByUser(filePath)) return false;
  return true;
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('[understand] Starting semantic enrichment for', projectDir);

  if (!existsSync(dbPathArg)) {
    console.error('[understand] monograph.db not found at', dbPathArg);
    console.error('[understand] Build the graph first: npx monomind monograph build');
    process.exit(1);
  }

  const mg = resolveMonograph();
  if (!mg) {
    console.error('[understand] Cannot find @monoes/monograph. Run: npm install @monoes/monograph');
    process.exit(1);
  }

  // Detect non-local filesystems where better-sqlite3 can't acquire file locks
  // (NFS, SMB, FUSE volumes — typically /Volumes/* on macOS or /mnt/* on Linux).
  // When detected, copy the DB to /tmp, work there, copy back atomically at end.
  let workingDbPath = dbPathArg;
  let dbWasShadowed = false;
  let originalDbPath = dbPathArg;
  const isNetworkFs = /^\/Volumes\//.test(dbPathArg) ||
                       /^\/mnt\//.test(dbPathArg) ||
                       /^\/media\//.test(dbPathArg) ||
                       /^\\\\/.test(dbPathArg);  // UNC paths on Windows
  if (isNetworkFs && !dryRun) {
    const os = await import('node:os');
    const crypto = await import('node:crypto');
    const tmpName = 'monograph-work-' + crypto.randomBytes(6).toString('hex') + '.db';
    workingDbPath = join(os.tmpdir(), tmpName);
    try {
      console.log(`[understand] DB is on a non-local filesystem (${dbPathArg}). Copying to ${workingDbPath} to avoid SQLite lock issues...`);
      const { copyFileSync } = await import('node:fs');
      copyFileSync(originalDbPath, workingDbPath);
      dbWasShadowed = true;
    } catch (e) {
      console.warn(`[understand] Could not copy to /tmp (${e.message}). Trying in place...`);
      workingDbPath = dbPathArg;
    }
  }

  // Retry openDb against SQLite BUSY when monograph is building in the background
  let db;
  for (let attempt = 0; attempt < 5; attempt++) {
    try { db = mg.openDb(workingDbPath); break; }
    catch (e) {
      if (attempt === 4) throw e;
      const msg = String(e?.message || e);
      if (!/busy|locked/i.test(msg)) throw e;
      console.log(`[understand] monograph.db busy, retrying in ${(attempt + 1) * 2}s...`);
      await new Promise(r => setTimeout(r, (attempt + 1) * 2000));
    }
  }

  // Ensure properties column exists
  try { db.prepare(`ALTER TABLE nodes ADD COLUMN properties TEXT`).run(); } catch {}
  try { db.prepare(`CREATE TABLE IF NOT EXISTS communities (id INTEGER PRIMARY KEY, label TEXT, size INTEGER NOT NULL DEFAULT 0, cohesion_score REAL NOT NULL DEFAULT 0.0)`).run(); } catch {}

  // ── Import analyses from stdin (slash-command write-back path) ───────────
  // When Claude Code's /monomind:understand has collected per-file summaries
  // through the active session, it pipes them back via:
  //   echo "$ANALYSES_JSON" | node understand-analyze.mjs --import-analyses-stdin
  // The JSON shape: { "analyses": [{ "id": <nodeId>, "fileSummary": "...", "tags": [...], ... }] }
  if (importAnalysesStdin) {
    const stdinText = await new Promise((resolve) => {
      let buf = '';
      process.stdin.setEncoding('utf-8');
      process.stdin.on('data', c => { buf += c; });
      process.stdin.on('end', () => resolve(buf));
      process.stdin.on('error', () => resolve(buf));
      // Bail out after 30 s so the slash command never hangs
      setTimeout(() => resolve(buf), 30000);
      process.stdin.resume();
    });
    let parsed = null;
    try { parsed = JSON.parse(stdinText); } catch {}
    const analyses = (parsed && Array.isArray(parsed.analyses)) ? parsed.analyses : [];
    if (analyses.length === 0) {
      console.error('[understand] --import-analyses-stdin: no analyses found in stdin JSON');
      mg.closeDb(db);
      process.exit(1);
    }
    // Resolve each analysis item to a DB integer node id.
    // graph.json nodes have id='file:<path>' (synthetic); the real PK is an integer.
    // Accept: analysis.dbId (integer), analysis.filePath, or derive path from analysis.id.
    const lookupByPath = db.prepare(`SELECT id, properties FROM nodes WHERE file_path=? OR file_path=? LIMIT 1`);
    const lookupById   = db.prepare(`SELECT id, properties FROM nodes WHERE id=? LIMIT 1`);
    const updateNode   = db.prepare(`UPDATE nodes SET properties = ? WHERE id = ?`);
    let written = 0;
    const tx = db.transaction(() => {
      for (const analysis of analyses) {
        if (!analysis) continue;
        let nodeRow = null;
        // 1. Prefer explicit integer dbId (added by newer graph.json emitter)
        if (analysis.dbId != null) {
          nodeRow = lookupById.get(analysis.dbId);
        }
        // 2. Fall back to filePath from graph.json node
        if (!nodeRow && analysis.filePath) {
          const rel = analysis.filePath.startsWith('/') ? relative(projectDir, analysis.filePath) : analysis.filePath;
          nodeRow = lookupByPath.get(analysis.filePath, rel);
        }
        // 3. Derive path from synthetic id ('file:<path>')
        if (!nodeRow && analysis.id && String(analysis.id).startsWith('file:')) {
          const derivedPath = String(analysis.id).slice(5);
          const rel = derivedPath.startsWith('/') ? relative(projectDir, derivedPath) : derivedPath;
          nodeRow = lookupByPath.get(derivedPath, rel);
        }
        if (!nodeRow) continue;
        const existing = (() => { try { return nodeRow.properties ? JSON.parse(nodeRow.properties) : {}; } catch { return {}; } })();
        const merged = {
          ...existing,
          ...(analysis.fileSummary       ? { summary:             analysis.fileSummary }            : {}),
          ...(analysis.tags              ? { tags:                 analysis.tags }                   : {}),
          ...(analysis.complexity        ? { complexity:           analysis.complexity }              : {}),
          ...(analysis.functionSummaries ? { functionSummaries:    analysis.functionSummaries }     : {}),
          ...(analysis.classSummaries    ? { classSummaries:       analysis.classSummaries }        : {}),
          ua_analyzed_at: new Date().toISOString(),
        };
        updateNode.run(JSON.stringify(merged), nodeRow.id);
        written++;
      }
    });
    tx();
    // Rebuild FTS so summaries are immediately searchable
    try { db.prepare(`INSERT INTO nodes_fts(nodes_fts) VALUES('rebuild')`).run(); } catch {}

    // Validate write-back: count nodes that now have a readable summary in properties
    let enrichedCount = 0;
    try {
      const row = db.prepare(
        `SELECT COUNT(*) AS c FROM nodes WHERE json_extract(properties, '$.summary') IS NOT NULL AND length(json_extract(properties, '$.summary')) > 5`
      ).get();
      enrichedCount = row ? row.c : 0;
    } catch (_) {}
    console.log(`[understand] Imported ${written} analyses from stdin. FTS rebuilt.`);
    console.log(`[understand] Validation: ${enrichedCount} node(s) now have LLM summaries readable via json_extract.`);
    if (written > 0 && enrichedCount < written) {
      console.warn(`[understand] WARNING: only ${enrichedCount} of ${written} imported analyses are queryable. Some properties may not have committed — check if properties column is TEXT.`);
    }
    mg.closeDb(db);
    return;
  }

  // ── Load all file nodes ──────────────────────────────────────────────────
  let fileNodes = db.prepare(`SELECT id, name, file_path, properties FROM nodes WHERE label = 'File' AND file_path IS NOT NULL`).all();
  console.log(`[understand] Found ${fileNodes.length} file nodes in DB`);

  // ── Layers-only mode ─────────────────────────────────────────────────────
  if (layersOnly) {
    console.log('[understand] Layers-only mode — skipping per-file analysis');
    await detectAndWriteLayers(db, fileNodes, noLlm, dryRun);
    mg.closeDb(db);
    console.log('[understand] Done (layers-only)');
    return;
  }

  // ── Incremental mode: only re-analyze changed files ─────────────────────
  let changedFileSet = null; // null means "analyze all"
  if (incremental) {
    let lastHash = '';
    try {
      const row = db.prepare(`SELECT value FROM index_meta WHERE key = 'ua_last_commit'`).get();
      lastHash = row?.value || '';
    } catch {}
    if (lastHash) {
      const changed = getChangedFiles(projectDir, lastHash);
      if (changed.length > 0) {
        changedFileSet = new Set(changed);
        console.log(`[understand] Incremental mode: ${changed.length} files changed since ${lastHash.slice(0, 8)}`);
      } else {
        console.log('[understand] Incremental mode: no changes detected since last run — skipping analysis');
        mg.closeDb(db);
        return;
      }
    } else {
      console.log('[understand] Incremental mode: no previous commit hash found — running full analysis');
    }
  }

  // ── Filter files that need analysis ─────────────────────────────────────
  const toAnalyze = fileNodes.filter(n => {
    if (!shouldAnalyze(n.file_path)) return false;
    if (changedFileSet) {
      // Match by relative or absolute path
      const rel = n.file_path.startsWith('/') ? relative(projectDir, n.file_path) : n.file_path;
      return changedFileSet.has(rel) || changedFileSet.has(n.file_path);
    }
    return true;
  });
  const limit = maxFiles > 0 ? Math.min(maxFiles, toAnalyze.length) : toAnalyze.length;
  const batch = toAnalyze.slice(0, limit);
  console.log(`[understand] Analyzing ${batch.length} files (${toAnalyze.length - batch.length} skipped/already enriched)`);

  // LLM path determined automatically. The script does NOT advise on
  // credentials — orchestration is the slash command's job.
  const llmPath = ANTHROPIC_API_KEY ? 'api' : 'none';
  if (llmPath === 'none' && !noLlm) {
    console.log('[understand] Running in heuristic mode. For per-file summaries,');
    console.log('[understand] use /monomind:understand from inside Claude Code — the slash');
    console.log('[understand] command orchestrates summarization through the active session.');
  }
  const useLlm = !noLlm && llmPath !== 'none';

  // ── Get project context for better prompts ────────────────────────────────
  let projectContext = `Project directory: ${basename(projectDir)}`;
  try {
    const pkgPath = join(projectDir, 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      projectContext = `${pkg.name || basename(projectDir)}: ${pkg.description || ''}`.trim();
    }
  } catch {}

  // ── Per-file LLM analysis ────────────────────────────────────────────────
  const analysisMap = {}; // file_path → { fileSummary, tags, complexity, functionSummaries, classSummaries }

  if (useLlm && batch.length > 0) {
    const system = 'You are an expert code analysis assistant. Always respond with valid JSON only.';
    const chunks = [];
    for (let i = 0; i < batch.length; i += batchSize) chunks.push(batch.slice(i, i + batchSize));

    let done = 0;
    for (const chunk of chunks) {
      // Read file contents
      const files = chunk
        .map(n => {
          const absPath = n.file_path.startsWith('/') ? n.file_path : join(projectDir, n.file_path);
          const content = readFileSafe(absPath);
          return content ? { path: n.file_path, content, nodeId: n.id } : null;
        })
        .filter(Boolean);

      if (files.length === 0) { done += chunk.length; continue; }

      process.stdout.write(`\r[understand] Analyzing files ${done + 1}–${Math.min(done + files.length, batch.length)} / ${batch.length}...`);

      try {
        let text;
        if (files.length === 1) {
          text = await callClaude(system, buildFilePrompt(files[0].path, files[0].content, projectContext));
          const parsed = parseJson(text);
          if (parsed) analysisMap[files[0].path] = parsed;
        } else {
          text = await callClaude(system, buildBatchPrompt(files, projectContext), 2048);
          const parsed = parseJson(text);
          if (parsed && typeof parsed === 'object') {
            for (const [fp, analysis] of Object.entries(parsed)) {
              if (analysis && typeof analysis === 'object') analysisMap[fp] = analysis;
            }
          }
        }
      } catch (e) {
        console.warn(`\n[understand] API error for batch at ${done}: ${e.message}`);
      }

      done += files.length;
      // Polite rate limiting
      if (chunks.indexOf(chunk) < chunks.length - 1) await new Promise(r => setTimeout(r, 300));
    }
    console.log(`\n[understand] LLM analysis complete: ${Object.keys(analysisMap).length} files analyzed`);
  }

  // ── Write analysis back to DB ─────────────────────────────────────────────
  const updateNode = db.prepare(`UPDATE nodes SET properties = ? WHERE id = ?`);
  let written = 0;

  if (!dryRun) {
    const tx = db.transaction(() => {
      for (const node of batch) {
        const existing = node.properties ? (() => { try { return JSON.parse(node.properties); } catch { return {}; } })() : {};
        const llmData  = analysisMap[node.file_path] || {};
        const merged = {
          ...existing,
          ...(llmData.fileSummary   ? { summary:     llmData.fileSummary }   : {}),
          ...(llmData.tags          ? { tags:         llmData.tags }          : {}),
          ...(llmData.complexity    ? { complexity:   llmData.complexity }    : {}),
          ...(llmData.languageNotes ? { languageNotes: llmData.languageNotes } : {}),
          ...(llmData.functionSummaries ? { functionSummaries: llmData.functionSummaries } : {}),
          ...(llmData.classSummaries    ? { classSummaries:    llmData.classSummaries }    : {}),
          ua_analyzed_at: new Date().toISOString(),
        };
        updateNode.run(JSON.stringify(merged), node.id);
        written++;
      }
    });
    tx();
    console.log(`[understand] Wrote enrichment data to ${written} nodes`);
  } else {
    console.log(`[understand] DRY RUN — would update ${batch.length} nodes`);
  }

  // ── Layer detection ──────────────────────────────────────────────────────
  const layers = await detectAndWriteLayers(db, fileNodes, noLlm || !useLlm, dryRun, projectDir);

  // ── Emit graph.json (for compatibility with ua-import.mjs) ──────────────
  const graphJson = buildGraphJson(projectDir, fileNodes, analysisMap, layers);
  const outputDir = dirname(outputArg);
  if (!dryRun) {
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(outputArg, JSON.stringify(graphJson, null, 2), 'utf-8');
    console.log(`[understand] graph.json written to ${outputArg}`);
  }

  // ── Rebuild FTS ──────────────────────────────────────────────────────────
  if (!dryRun) {
    try {
      db.prepare(`INSERT INTO nodes_fts(nodes_fts) VALUES('rebuild')`).run();
      console.log('[understand] FTS index rebuilt');
    } catch {}
  }

  // ── Update index_meta ────────────────────────────────────────────────────
  if (!dryRun) {
    const upsertMeta = db.prepare(
      `INSERT INTO index_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`
    );
    upsertMeta.run('ua_analyzed_at', new Date().toISOString());
    const currentHash = getCurrentCommitHash(projectDir);
    if (currentHash) upsertMeta.run('ua_last_commit', currentHash);
  }

  mg.closeDb(db);

  // ── Onboarding guide ─────────────────────────────────────────────────────
  let onboardWritten = false;
  if (onboard && !dryRun) {
    const guide = buildOnboardingGuide(graphJson);
    writeFileSync(onboardOut, guide, 'utf-8');
    onboardWritten = true;
    console.log(`[understand] Onboarding guide written to ${relative(CWD, onboardOut)}`);
  }

  // ── Final report ─────────────────────────────────────────────────────────
  const title = dryRun
    ? '║  /monomind:understand — DRY RUN (no writes)       ║'
    : '║  /monomind:understand — Enrichment Complete       ║';
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log(title);
  console.log('╠══════════════════════════════════════════════════╣');
  console.log(`║  DB:              ${relative(CWD, dbPathArg).padEnd(31)}║`);
  console.log(`║  Nodes enriched:  ${String(written).padEnd(31)}║`);
  console.log(`║  Communities:     ${String(layers.length).padEnd(31)}║`);
  console.log(`║  graph.json:      ${relative(CWD, outputArg).padEnd(31)}║`);
  if (onboardWritten) {
    console.log(`║  ONBOARDING.md:   ${relative(CWD, onboardOut).padEnd(31)}║`);
  }
  console.log('╚══════════════════════════════════════════════════╝');

  // Copy DB back if we shadowed it on /tmp due to network FS
  if (dbWasShadowed && !dryRun) {
    try {
      const { copyFileSync, unlinkSync } = await import('node:fs');
      try { db.close(); } catch {}
      console.log(`[understand] Copying enriched DB back to ${originalDbPath}...`);
      copyFileSync(workingDbPath, originalDbPath);
      try { unlinkSync(workingDbPath); } catch {}
    } catch (e) {
      console.error(`[understand] Failed to copy DB back: ${e.message}`);
      console.error(`[understand] Enriched DB is at ${workingDbPath} — copy manually if needed.`);
    }
  }
}

main().catch(e => {
  console.error('[understand] Fatal error:', e.message);
  process.exit(1);
});
