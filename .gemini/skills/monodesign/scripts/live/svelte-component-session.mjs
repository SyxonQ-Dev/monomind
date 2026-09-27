/**
 * Component-session lifecycle for live/svelte-component.mjs: where a
 * session's scaffolded variants and manifest live on disk, finding/reading a
 * manifest, removing sessions, and the deferred-accept queue used when an
 * accept can't be applied synchronously (e.g. the live server restarts).
 *
 * Split out of live/svelte-component.mjs. See that file for context.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inlineSvelteComponentAccept } from './svelte-component-accept.mjs';

export const SVELTE_COMPONENT_ROOT = 'node_modules/.monodesign-live';
export const SVELTE_RUNTIME_FILE = `${SVELTE_COMPONENT_ROOT}/__runtime.js`;
export const DEFERRED_ACCEPTS_FILE = '.monodesign/live/deferred-svelte-component-accepts.json';


export function shouldUseSvelteComponentInjection(filePath) {
  if (/^(0|false|no)$/i.test(process.env.MONODESIGN_LIVE_SVELTE_COMPONENT || '')) return false;
  return path.extname(filePath).toLowerCase() === '.svelte';
}

export function componentSessionDir(id, cwd = process.cwd()) {
  return path.join(cwd, SVELTE_COMPONENT_ROOT, id);
}

export function manifestPathForSession(id, cwd = process.cwd()) {
  return path.join(componentSessionDir(id, cwd), 'manifest.json');
}

export function ensureRuntimeHelper(cwd = process.cwd()) {
  const file = path.join(cwd, SVELTE_RUNTIME_FILE);
  if (fs.existsSync(file)) return file;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `export { mount, unmount } from 'svelte';\n`, 'utf-8');
  return file;
}

export function findSvelteComponentManifest(id, cwd = process.cwd()) {
  const direct = manifestPathForSession(id, cwd);
  if (fs.existsSync(direct)) {
    return readManifest(direct);
  }
  const root = path.join(cwd, SVELTE_COMPONENT_ROOT);
  if (!fs.existsSync(root)) return null;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(root, entry.name, 'manifest.json');
    if (!fs.existsSync(candidate)) continue;
    try {
      const manifest = readManifest(candidate);
      if (manifest?.id === id) return { ...manifest, manifestPath: candidate };
    } catch { /* skip */ }
  }
  return null;
}

export function readManifest(manifestPath) {
  const data = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  return {
    ...data,
    manifestPath,
  };
}

export function resolveSourceFile(sourceFile, cwd = process.cwd()) {
  if (!sourceFile || path.isAbsolute(sourceFile)) {
    throw new Error('Invalid svelte-component source file');
  }
  const full = path.resolve(cwd, sourceFile);
  const rel = path.relative(cwd, full).split(path.sep).join('/');
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Svelte-component source file escapes project root');
  }
  if (!fs.existsSync(full)) {
    throw new Error(`Svelte-component source file not found: ${sourceFile}`);
  }
  return full;
}

export function removeSvelteComponentSession(id, cwd = process.cwd()) {
  const dir = componentSessionDir(id, cwd);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* non-fatal */ }
}

export function removeAllSvelteComponentSessions(cwd = process.cwd()) {
  const root = path.join(cwd, SVELTE_COMPONENT_ROOT);
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('__')) continue;
    try {
      fs.rmSync(path.join(root, entry.name), { recursive: true, force: true });
    } catch { /* non-fatal */ }
  }
}

export function deferredAcceptsPath(cwd = process.cwd()) {
  const key = createHash('sha1').update(path.resolve(cwd)).digest('hex').slice(0, 16);
  return path.join(os.tmpdir(), 'monodesign-live', key, 'deferred-svelte-component-accepts.json');
}

export function readDeferredAccepts(cwd = process.cwd()) {
  const file = deferredAcceptsPath(cwd);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return { accepts: [] };
  }
}

export function writeDeferredAccept(entry, cwd = process.cwd()) {
  const file = deferredAcceptsPath(cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const data = readDeferredAccepts(cwd);
  data.accepts = (data.accepts || []).filter((item) => item.id !== entry.id);
  data.accepts.push({ ...entry, createdAt: new Date().toISOString() });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
}

export function applyDeferredSvelteComponentAccepts(cwd = process.cwd()) {
  const file = deferredAcceptsPath(cwd);
  const data = readDeferredAccepts(cwd);
  const pending = Array.isArray(data.accepts) ? data.accepts : [];
  const results = [];
  const remaining = [];
  for (const entry of pending) {
    try {
      const manifest = findSvelteComponentManifest(entry.id, cwd);
      if (!manifest) {
        results.push({ id: entry.id, ok: false, error: 'manifest not found' });
        remaining.push(entry);
        continue;
      }
      const result = inlineSvelteComponentAccept(
        manifest,
        entry.variantNum,
        entry.paramValues || null,
        cwd,
      );
      results.push({ id: entry.id, ok: result.handled !== false, result });
      if (result.handled === false) remaining.push(entry);
    } catch (err) {
      results.push({ id: entry.id, ok: false, error: err.message });
      remaining.push(entry);
    }
  }
  if (remaining.length > 0) {
    fs.writeFileSync(file, `${JSON.stringify({ accepts: remaining }, null, 2)}\n`, 'utf-8');
  } else {
    try { fs.rmSync(file, { force: true }); } catch {}
  }
  return { applied: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results };
}
