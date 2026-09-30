/**
 * #420 end to end: a default `monomind init` on a machine where only Claude
 * Code is installed writes Claude Code's files alone, never runs a package
 * manager install and leaves the project's package.json byte-identical.
 * `init upgrade --add-missing` then keeps the project's platforms.
 *
 * Detection is driven by a throwaway PATH (a fake `claude`) and HOME, so the
 * test does not depend on which CLIs this machine has.
 */

import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => [] as string[]);

vi.mock('child_process', () => {
  const record = (name: string) =>
    vi.fn((cmd: unknown, args?: unknown) => {
      calls.push(`${name}: ${String(cmd)} ${Array.isArray(args) ? args.join(' ') : ''}`.trim());
      if (name === 'spawn') {
        const proc = new EventEmitter() as EventEmitter & Record<string, unknown>;
        proc.unref = () => {};
        proc.kill = () => {};
        proc.stdout = new EventEmitter();
        proc.stderr = new EventEmitter();
        return proc;
      }
      throw new Error('mocked: no real process execution in tests');
    });
  return {
    execSync: record('execSync'),
    execFileSync: record('execFileSync'),
    spawnSync: record('spawnSync'),
    exec: record('exec'),
    execFile: record('execFile'),
    spawn: record('spawn'),
  };
});

const { initCommand } = await import('../src/commands/init.js');
const { executeUpgradeWithMissing } = await import('../src/init/index.js');
const { output } = await import('../src/output.js');
output.setVerbosity('quiet');

const PACKAGE_JSON = '{\n  "name": "user-project",\n  "version": "1.0.0"\n}\n';
const INSTALL_RE = /\b(npm|pnpm|yarn|bun)(\.cmd)?\b[^\n]*\b(install|i|add|ci)\b/;

describe('init on a Claude-only machine (#420)', () => {
  let tmp: string;
  let project: string;
  // Every variable detection reads, so the real machine can't leak in.
  const DETECT_ENV = ['HOME', 'PATH', 'XDG_CONFIG_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR'];
  const saved = Object.fromEntries(DETECT_ENV.map((k) => [k, process.env[k]]));

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mm420e-'));
    project = path.join(tmp, 'proj');
    const bin = path.join(tmp, 'bin');
    const home = path.join(tmp, 'home');
    for (const dir of [project, bin, path.join(home, '.claude')]) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\n', { mode: 0o755 });
    fs.writeFileSync(path.join(project, 'package.json'), PACKAGE_JSON);
    for (const k of DETECT_ENV) delete process.env[k];
    process.env.HOME = home;
    process.env.PATH = bin;
    calls.length = 0;
  });

  afterEach(async () => {
    try {
      const bridge = await import('../src/memory/memory-bridge.js');
      await bridge.shutdownBridge();
    } catch {}
    for (const k of DETECT_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const init = (flags: Record<string, unknown> = {}) =>
    initCommand.action!({
      args: [],
      flags: { _: [], yes: true, 'no-install': true, 'no-watch': true, 'no-start-all': true, ...flags },
      cwd: project,
      interactive: false,
    });

  it('writes Claude Code only, says so, and installs nothing into the project', async () => {
    const info = vi.spyOn(output, 'printInfo');
    const result = await init();
    expect(result.success).toBe(true);

    expect(fs.existsSync(path.join(project, 'CLAUDE.md'))).toBe(true);
    expect(fs.existsSync(path.join(project, '.claude', 'settings.json'))).toBe(true);
    for (const other of ['GEMINI.md', '.gemini', 'AGENTS.md', '.agents', '.codex', '.kimi-code', 'opencode.json', '.opencode']) {
      expect(fs.existsSync(path.join(project, other)), other).toBe(false);
    }
    expect(info).toHaveBeenCalledWith(expect.stringContaining('Platforms detected: Claude Code'));
    expect(info).toHaveBeenCalledWith(expect.stringContaining('--all-platforms'));

    expect(fs.readFileSync(path.join(project, 'package.json'), 'utf8')).toBe(PACKAGE_JSON);
    expect(fs.existsSync(path.join(project, 'node_modules'))).toBe(false);
    for (const lock of ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']) {
      expect(fs.existsSync(path.join(project, lock)), lock).toBe(false);
    }
    expect(calls.filter((c) => INSTALL_RE.test(c))).toEqual([]);
  }, 60000);

  it('writes all five platforms with --all-platforms', async () => {
    const result = await init({ 'all-platforms': true });
    expect(result.success).toBe(true);
    for (const file of ['CLAUDE.md', 'GEMINI.md', 'opencode.json', '.kimi-code', '.codex']) {
      expect(fs.existsSync(path.join(project, file)), file).toBe(true);
    }
  }, 60000);

  it('upgrade --add-missing keeps the project platforms and adds no new trees', async () => {
    expect((await init()).success).toBe(true);
    const skills = path.join(project, '.claude', 'skills');
    const removed = fs.readdirSync(skills)[0];
    fs.rmSync(path.join(skills, removed), { recursive: true, force: true });

    const result = await executeUpgradeWithMissing(project, false);
    expect(result.success).toBe(true);
    expect(result.addedSkills).toContain(removed);
    expect(fs.existsSync(path.join(project, '.gemini'))).toBe(false);
    expect(fs.existsSync(path.join(project, '.agents'))).toBe(false);
    expect(fs.readFileSync(path.join(project, 'package.json'), 'utf8')).toBe(PACKAGE_JSON);
  }, 60000);

  it('upgrade --add-missing still mirrors into a platform tree the project has', async () => {
    expect((await init({ platforms: 'claude,codex' })).success).toBe(true);
    const skills = path.join(project, '.claude', 'skills');
    const removed = fs.readdirSync(skills)[0];
    fs.rmSync(path.join(skills, removed), { recursive: true, force: true });
    fs.rmSync(path.join(project, '.agents', 'skills', removed), { recursive: true, force: true });

    const result = await executeUpgradeWithMissing(project, false);
    expect(result.addedSkills).toContain(removed);
    expect(fs.existsSync(path.join(project, '.agents', 'skills', removed))).toBe(true);
    expect(fs.existsSync(path.join(project, '.gemini'))).toBe(false);
  }, 60000);

  it('without --no-install and without a TTY, the doctor pass spawns no npm at all', async () => {
    const tty = process.stdout.isTTY;
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    const info = vi.spyOn(output, 'printInfo');
    try {
      const result = await initCommand.action!({
        args: [],
        flags: { _: [], yes: true, 'no-watch': true, 'no-start-all': true },
        cwd: project,
        interactive: false,
      });
      expect(result.success).toBe(true);
    } finally {
      Object.defineProperty(process.stdout, 'isTTY', { value: tty, configurable: true });
    }
    expect(calls.filter((c) => /\bnpm\b[^\n]*\binstall\b/.test(c))).toEqual([]);
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining('install it with: npm install -g @anthropic-ai/claude-code'),
    );
    expect(fs.readFileSync(path.join(project, 'package.json'), 'utf8')).toBe(PACKAGE_JSON);
  }, 60000);

  it('init --force re-pins every platform the project has, not just the detected ones', async () => {
    expect((await init({ 'all-platforms': true, pin: '0.0.1' })).success).toBe(true);
    const pinned = ['.codex/config.toml', 'opencode.json', '.kimi-code/mcp.json'];
    for (const file of pinned) {
      expect(fs.readFileSync(path.join(project, file), 'utf8'), file).toContain('0.0.1');
    }
    expect((await init({ force: true })).success).toBe(true);
    for (const file of pinned) {
      expect(fs.readFileSync(path.join(project, file), 'utf8'), file).not.toContain('0.0.1');
    }
  }, 60000);

  it('init --json reports the platforms it chose', async () => {
    const out: string[] = [];
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    });
    try {
      expect((await init({ json: true })).success).toBe(true);
    } finally {
      write.mockRestore();
    }
    const doc = JSON.parse(out.join('').trim().split('\n').at(-1) as string);
    expect(doc.platforms).toEqual({
      source: 'detected',
      selected: ['claude'],
      detected: [{ id: 'claude', via: ['claude on PATH', '~/.claude'] }],
    });
  }, 60000);

  it('init skills creates no .gemini/ or .agents/ in a project without them', async () => {
    const { skillsCommand } = await import('../src/commands/init-subcommands.js');
    const run = () =>
      skillsCommand.action!({ args: [], flags: { _: [], core: true }, cwd: project, interactive: false });
    expect((await run()).success).toBe(true);
    expect(fs.existsSync(path.join(project, '.claude', 'skills'))).toBe(true);
    expect(fs.existsSync(path.join(project, '.gemini'))).toBe(false);
    expect(fs.existsSync(path.join(project, '.agents'))).toBe(false);

    // A project that has .agents/ gets the mirror there (fresh copy of the skills).
    fs.rmSync(path.join(project, '.claude', 'skills'), { recursive: true, force: true });
    fs.mkdirSync(path.join(project, '.agents'));
    expect((await run()).success).toBe(true);
    expect(fs.readdirSync(path.join(project, '.agents', 'skills')).length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(project, '.gemini'))).toBe(false);
  }, 60000);

  it("the project's hooks find monograph without a local dependency (npx cache copy)", async () => {
    expect((await init()).success).toBe(true);
    // The copy bundled with the CLI in npm's npx cache, as `npx monomind` leaves it.
    const cache = path.join(tmp, 'npm-cache');
    const pkgDir = path.join(cache, '_npx', 'abc', 'node_modules', '@monoes', 'monograph');
    fs.mkdirSync(path.join(pkgDir, 'dist'), { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name: '@monoes/monograph', version: '9.9.9', exports: { '.': './dist/index.js' } }),
    );
    fs.writeFileSync(path.join(pkgDir, 'dist', 'index.js'), 'export {};\n');

    const helper = path.join(project, '.claude', 'helpers', 'utils', 'monograph-resolve.cjs');
    const { resolveMonographEntry } = createRequire(import.meta.url)(helper);
    const hit = resolveMonographEntry(project, { globalRoot: null, npxCacheDir: cache });
    expect(hit).toMatchObject({ source: 'npx', version: '9.9.9' });
    expect(fs.readFileSync(path.join(project, 'package.json'), 'utf8')).toBe(PACKAGE_JSON);
  }, 60000);
});
