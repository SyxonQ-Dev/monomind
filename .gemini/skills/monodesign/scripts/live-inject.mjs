/**
 * CLI helper: insert/remove the live variant mode script tag in the project's
 * main HTML entry point.
 *
 * On first live run, the agent generates `.monodesign/live/config.json`
 * with the project's insertion target (framework-specific). On
 * every subsequent run, this script handles insert/remove deterministically
 * with zero LLM involvement.
 *
 * Usage:
 *   node live-inject.mjs --port PORT   # Insert the live script tag
 *   node live-inject.mjs --remove      # Remove the live script tag
 *   node live-inject.mjs --check       # Check whether live config exists
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveLiveConfigPath, readLiveServerInfo } from './lib/monodesign-paths.mjs';
import {
  applySvelteKitLiveAdapter,
  detectSvelteKitProject,
  removeSvelteKitLiveAdapter,
} from './live/sveltekit-adapter.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import {
  ensureLiveGitIgnores,
  resolveFiles,
  validateConfig,
  LIVE_IGNORE_PATTERNS,
} from './live-inject-files.mjs';
import { insertTag, removeTag, buildTagBlock } from './live-inject-tag.mjs';
import { patchCspMeta, revertCspMeta } from './live-inject-csp.mjs';

const CONFIG_PATH = resolveLiveConfigPath({ cwd: process.cwd(), scriptsDir: __dirname });

export async function injectCli() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`Usage: node live-inject.mjs [options]

Insert or remove the live mode script tag in the project's HTML entry point.
Reads configuration from .monodesign/live/config.json.

Modes:
  --port PORT   Insert script tag pointing at http://localhost:PORT/live.js
  --remove      Remove the script tag (if present)
  --check       Print whether .monodesign/live/config.json exists and its content

Output (JSON):
  { ok, file, inserted|removed, config? }`);
    process.exit(0);
  }

  if (args.includes('--check')) {
    if (!fs.existsSync(CONFIG_PATH)) {
      console.log(JSON.stringify({ ok: false, error: 'config_missing', path: CONFIG_PATH }));
      process.exit(0);
    }
    let cfg;
    try {
      cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    } catch (err) {
      console.log(JSON.stringify({ ok: false, error: 'config_invalid', message: err.message, path: CONFIG_PATH }));
      return;
    }
    try {
      validateConfig(cfg);
    } catch (err) {
      console.log(JSON.stringify({ ok: false, error: 'config_invalid', message: err.message, path: CONFIG_PATH }));
      return;
    }
    console.log(JSON.stringify({ ok: true, config: cfg, path: CONFIG_PATH }));
    return;
  }

  // Load config
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(JSON.stringify({ ok: false, error: 'config_missing', path: CONFIG_PATH }));
    process.exit(1);
  }
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  validateConfig(config);

  const resolvedFiles = resolveFiles(process.cwd(), config);
  const svelteKit = detectSvelteKitProject(process.cwd(), config);

  if (args.includes('--remove')) {
    if (svelteKit) {
      const adapterResult = removeSvelteKitLiveAdapter({ cwd: process.cwd(), config });
      console.log(JSON.stringify({ ok: true, adapter: 'sveltekit', results: [adapterResult] }));
      return;
    }
    const results = resolvedFiles.map((relFile) => {
      const absFile = path.resolve(process.cwd(), relFile);
      if (!fs.existsSync(absFile)) return { file: relFile, error: 'file_not_found' };
      const content = fs.readFileSync(absFile, 'utf-8');
      const detagged = removeTag(content, config.commentSyntax);
      const updated = revertCspMeta(detagged);
      if (updated === content) return { file: relFile, removed: false, note: 'no tag present' };
      fs.writeFileSync(absFile, updated, 'utf-8');
      return {
        file: relFile,
        removed: detagged !== content,
        cspReverted: updated !== detagged,
      };
    });
    console.log(JSON.stringify({ ok: true, results }));
    return;
  }

  // Insert mode — need --port
  const portIdx = args.indexOf('--port');
  const port = portIdx !== -1 ? parseInt(args[portIdx + 1], 10) : NaN;
  if (!Number.isFinite(port)) {
    console.error(JSON.stringify({ ok: false, error: 'missing_port' }));
    process.exit(1);
  }
  // The injected tag must authenticate like every other server route does —
  // read the per-process credential live-server.mjs persisted at startup.
  const liveInfo = readLiveServerInfo(process.cwd());
  const credentialFields = liveInfo?.info ?? {};
  const authCred = credentialFields.token;
  if (!authCred) {
    console.error(JSON.stringify({ ok: false, error: 'missing_auth_credential', detail: 'no running live server info found for this project — start it before injecting' }));
    process.exit(1);
  }
  const gitIgnore = ensureLiveGitIgnores(process.cwd());

  if (svelteKit) {
    const adapterResult = applySvelteKitLiveAdapter({ cwd: process.cwd(), port, authCred, config });
    console.log(JSON.stringify({ ok: true, port, adapter: 'sveltekit', gitIgnore, results: [adapterResult] }));
    return;
  }

  const results = resolvedFiles.map((relFile) => {
    const absFile = path.resolve(process.cwd(), relFile);
    if (!fs.existsSync(absFile)) return { file: relFile, error: 'file_not_found' };
    const content = fs.readFileSync(absFile, 'utf-8');
    const withoutOld = revertCspMeta(removeTag(content, config.commentSyntax));
    const withTag = insertTag(withoutOld, config, port, authCred, relFile);
    if (withTag === withoutOld) {
      return { file: relFile, error: 'insertion_point_not_found', anchor: config.insertBefore || config.insertAfter };
    }
    const updated = patchCspMeta(withTag, port);
    fs.writeFileSync(absFile, updated, 'utf-8');
    return {
      file: relFile,
      inserted: true,
      cspPatched: updated !== withTag,
    };
  });
  const anyInserted = results.some((r) => r.inserted);
  console.log(JSON.stringify({ ok: anyInserted, port, gitIgnore, results }));
  if (!anyInserted) process.exit(1);
}

const _running = process.argv[1];
if (_running?.endsWith('live-inject.mjs') || _running?.endsWith('live-inject.mjs/')) {
  injectCli();
}

export { insertTag, removeTag, validateConfig, buildTagBlock };
export { LIVE_IGNORE_PATTERNS, ensureLiveGitIgnores, resolveFiles };
export { patchCspMeta, revertCspMeta };
// patchCspMeta + revertCspMeta are re-exported from live-inject-csp.mjs,
// where they're defined.
