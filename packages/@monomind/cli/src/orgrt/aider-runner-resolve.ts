// packages/@monomind/cli/src/orgrt/aider-runner-resolve.ts
/**
 * Where the aider runner's pieces live (monoes/monomind#383):
 *   - aider's own Python interpreter — the shim imports aider's scripting
 *     API, so it must run in aider's environment. Found from the `aider`
 *     entry point's shebang (uv tool / pipx / venv installs all write the
 *     absolute interpreter path there), else uv's default tool dir.
 *   - the shim itself, shipped next to this module (src/ or dist/).
 *   - the per-session state dir, outside any user repo.
 * No subprocess is spawned to find any of them.
 */

import { closeSync, existsSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The shim, at the same relative path in src/ and in dist/ (the build
 *  copies src/orgrt/aider/monomind_aider_shim.py into dist/src/orgrt/aider/). */
export function defaultShimPath(): string {
  return fileURLToPath(new URL('./aider/monomind_aider_shim.py', import.meta.url));
}

/** Per-session conversation files: `<dir>/<session>.json` (+ aider's own logs). */
export function defaultStateDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.MONOMIND_AIDER_STATE_DIR || join(homedir(), '.monomind', 'aider-sessions');
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** `name` on PATH (or `name` itself when it already has a slash). */
export function findOnPath(name: string, pathVar: string | undefined): string | undefined {
  if (name.includes('/')) return isFile(name) ? name : undefined;
  for (const dir of (pathVar ?? '').split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, name);
    if (isFile(p)) return p;
  }
  return undefined;
}

function firstLine(path: string): string {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(512);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString('utf8').split('\n')[0] ?? '';
  } finally {
    closeSync(fd);
  }
}

const PYTHON_NAME = /^python[0-9.]*$/;

/** The interpreter a `#!` line names, when it is a Python: `#!/abs/python`
 *  or `#!/usr/bin/env python3` (resolved on PATH). */
export function shebangPython(line: string, pathVar: string | undefined): string | undefined {
  if (!line.startsWith('#!')) return undefined;
  const words = line.slice(2).trim().split(/\s+/);
  let interp = words[0];
  if (interp && basename(interp) === 'env') {
    const name = words.slice(1).find((w) => !w.startsWith('-'));
    interp = name ? (findOnPath(name, pathVar) ?? '') : '';
  }
  if (!interp || !PYTHON_NAME.test(basename(interp))) return undefined;
  return isFile(interp) ? interp : undefined;
}

/**
 * aider's own interpreter, or undefined when it cannot be located (the
 * runner then falls back to the plain CLI). `MONOMIND_AIDER_PYTHON`
 * overrides the lookup.
 */
export function resolveAiderPython(bin: string, env: NodeJS.ProcessEnv): string | undefined {
  const forced = env.MONOMIND_AIDER_PYTHON;
  if (forced) return isFile(forced) ? forced : undefined;
  const entry = findOnPath(bin, env.PATH);
  if (entry) {
    try {
      const py = shebangPython(firstLine(realpathSync(entry)), env.PATH);
      if (py) return py;
    } catch {
      /* unreadable entry point — try uv's tool dir */
    }
  }
  const uvDir = env.UV_TOOL_DIR || join(env.HOME || homedir(), '.local', 'share', 'uv', 'tools');
  const uvPython = join(uvDir, 'aider-chat', 'bin', 'python');
  return existsSync(uvPython) ? uvPython : undefined;
}

/** Whether `cwd` is inside a git work tree (a `.git` in it or above). */
export function insideGitRepo(cwd: string): boolean {
  let d = resolve(cwd);
  for (;;) {
    if (existsSync(join(d, '.git'))) return true;
    const parent = dirname(d);
    if (parent === d) return false;
    d = parent;
  }
}
