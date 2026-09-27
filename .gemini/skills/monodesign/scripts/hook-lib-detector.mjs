import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { readConfig } from './hook-lib-config.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function writeAuditLog(env, entry, cwd = process.cwd()) {
  // The event's project root (entry.cwd) when present, else the passed cwd. Both
  // config reads and relative log paths resolve against this, since the hook
  // process cwd can differ from the project being edited.
  const baseCwd = entry && typeof entry.cwd === 'string' && entry.cwd ? entry.cwd : cwd;
  // Env wins; otherwise fall back to the unified config's hook.auditLog path.
  let target = env?.MONODESIGN_HOOK_LOG;
  if (!target || typeof target !== 'string') {
    try { target = readConfig(baseCwd).auditLog; } catch { target = null; }
  }
  if (!target || typeof target !== 'string') return false;
  try {
    let expanded;
    if (target.startsWith('~/')) {
      expanded = path.join(process.env.HOME || process.env.USERPROFILE || '.', target.slice(2));
    } else if (path.isAbsolute(target)) {
      expanded = target;
    } else {
      expanded = path.resolve(baseCwd, target);
    }
    fs.mkdirSync(path.dirname(expanded), { recursive: true });
    const line = `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`;
    fs.appendFileSync(expanded, line);
    return true;
  } catch {
    return false;
  }
}

// Packaged fallback: resolve the engine from an installed @monoes/monodesign.
function packagedDetectorPath() {
  try {
    return createRequire(import.meta.url).resolve('@monoes/monodesign/engine');
  } catch {
    return null;
  }
}

const DETECTOR_CANDIDATES = [
  path.join(__dirname, 'detector', 'detect-antipatterns.mjs'),
  path.join(__dirname, '..', '..', 'cli', 'engine', 'detect-antipatterns.mjs'),
  path.join(__dirname, '..', '..', '..', 'cli', 'engine', 'detect-antipatterns.mjs'),
  packagedDetectorPath(),
].filter(Boolean);

let detectorCache = null;
export async function loadDetector(candidates = DETECTOR_CANDIDATES) {
  if (detectorCache) return detectorCache;
  const found = candidates.find((c) => fs.existsSync(c));
  if (!found) return null;
  const mod = await import(pathToFileURL(found));
  detectorCache = {
    detectText: mod.detectText,
    detectHtml: mod.detectHtml,
    loadDesignSystemForCwd: mod.loadDesignSystemForCwd,
  };
  return detectorCache;
}

// For tests: allow injecting a detector implementation.
export function setDetectorForTesting(impl) {
  detectorCache = impl;
}
