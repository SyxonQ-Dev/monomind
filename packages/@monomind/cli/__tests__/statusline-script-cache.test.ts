/**
 * #429: the init-generated statusline.cjs caches its process-spawning segments
 * (git, sqlite3, curl, npm) in <project>/.monomind/cache/statusline.json, so a
 * render with a warm cache spawns none of them.
 *
 * The spawned tools are replaced by logging stubs on PATH.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateStatuslineScript } from '../src/init/statusline-generator.js';
import { DEFAULT_INIT_OPTIONS } from '../src/init/types.js';

describe.skipIf(process.platform === 'win32')('generated statusline segment cache (#429)', () => {
  let dir: string;
  let proj: string;
  let bin: string;
  let log: string;
  let script: string;
  let cacheFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sl-gen-cache-'));
    proj = join(dir, 'proj');
    bin = join(dir, 'bin');
    log = join(dir, 'spawn.log');
    cacheFile = join(proj, '.monomind', 'cache', 'statusline.json');
    mkdirSync(join(proj, '.monomind', 'memory'), { recursive: true });
    mkdirSync(join(proj, '.claude', 'helpers'), { recursive: true });
    mkdirSync(bin);
    writeFileSync(join(proj, '.monomind', 'monograph.db'), '');
    writeFileSync(join(proj, '.monomind', 'memory', 'memory.db'), '');
    writeFileSync(join(proj, '.monomind', 'control.json'), JSON.stringify({ port: 1 }));
    for (const tool of ['git', 'sqlite3', 'curl', 'npm']) {
      const p = join(bin, tool);
      writeFileSync(p, `#!/bin/sh\necho "${tool} $*" >> "${log}"\n`);
      chmodSync(p, 0o755);
    }
    writeFileSync(log, '');
    script = join(proj, '.claude', 'helpers', 'statusline.cjs');
    writeFileSync(script, generateStatuslineScript(DEFAULT_INIT_OPTIONS));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function render(): string[] {
    writeFileSync(log, '');
    execFileSync(process.execPath, [script], {
      cwd: proj,
      encoding: 'utf8',
      env: { ...process.env, HOME: dir, CLAUDE_PROJECT_DIR: proj, PATH: `${bin}:/usr/bin:/bin` },
    });
    return readFileSync(log, 'utf8').split('\n').filter(Boolean);
  }

  it('spawns git and sqlite3 on a cold render, nothing on a warm one', () => {
    const cold = render();
    expect(cold.some((l) => l.startsWith('git status --porcelain'))).toBe(true);
    expect(cold.some((l) => l.startsWith('sqlite3'))).toBe(true);
    expect(render()).toEqual([]);
  });

  it('refreshes an expired git segment but not the unexpired DB counts', () => {
    render();
    const data = JSON.parse(readFileSync(cacheFile, 'utf8'));
    for (const entry of Object.values(data) as Array<{ at: number }>) entry.at -= 6000;
    writeFileSync(cacheFile, JSON.stringify(data));

    const lines = render();
    expect(lines.some((l) => l.startsWith('git status --porcelain'))).toBe(true);
    expect(lines.some((l) => l.startsWith('sqlite3'))).toBe(false);
  });
});
