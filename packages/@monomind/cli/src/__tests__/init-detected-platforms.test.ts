/**
 * #420: `monomind init` writes only the platforms installed on this machine
 * (CLI on PATH or ~/.<name> config dir), Claude Code when none is found.
 * Explicit flags still pick platforms, and `init upgrade` keeps the ones a
 * project already has.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chooseDefaultPlatforms,
  type DetectedPlatform,
  describePlatformChoice,
  detectInstalledPlatforms,
  platformsInProject,
} from '../init/detect-platforms.js';
import type { CommandContext } from '../types.js';

// Load through init.ts, as the CLI does: resolve-options -> init/index has an
// import cycle back into init.ts that only resolves in that order.
await import('../commands/init.js');
const { resolveInitOptions } = await import('../init/resolve-options.js');

let root: string;
let binDir: string;
let homeDir: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mm420-'));
  binDir = path.join(root, 'bin');
  homeDir = path.join(root, 'home');
  fs.mkdirSync(binDir);
  fs.mkdirSync(homeDir);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function fakeBin(name: string): void {
  const file = path.join(binDir, name);
  fs.writeFileSync(file, '#!/bin/sh\n');
  fs.chmodSync(file, 0o755);
}

const detect = (env: Record<string, string> = {}, platform?: NodeJS.Platform) =>
  detectInstalledPlatforms({ pathEnv: binDir, homeDir, env, platform });

describe('detectInstalledPlatforms', () => {
  it('finds nothing on an empty PATH and home', () => {
    expect(detect()).toEqual([]);
  });

  it('finds a CLI on PATH', () => {
    fakeBin('claude');
    expect(detect()).toEqual([{ id: 'claude', via: ['claude on PATH'] }]);
  });

  it('finds a user config dir under $HOME', () => {
    fs.mkdirSync(path.join(homeDir, '.codex'));
    fs.mkdirSync(path.join(homeDir, '.config', 'opencode'), { recursive: true });
    expect(detect().map((d) => [d.id, d.via])).toEqual([
      ['opencode', ['~/.config/opencode']],
      ['codex', ['~/.codex']],
    ]);
  });

  it('maps gemini/agy to antigravity and kimi to kimi, in a stable order', () => {
    fakeBin('kimi');
    fakeBin('agy');
    fakeBin('claude');
    fs.mkdirSync(path.join(homeDir, '.gemini'));
    expect(detect()).toEqual([
      { id: 'claude', via: ['claude on PATH'] },
      { id: 'antigravity', via: ['agy on PATH', '~/.gemini'] },
      { id: 'kimi', via: ['kimi on PATH'] },
    ]);
  });

  it('honours CODEX_HOME and CLAUDE_CONFIG_DIR', () => {
    const codexHome = path.join(root, 'codex-home');
    fs.mkdirSync(codexHome);
    expect(detect({ CODEX_HOME: codexHome }).map((d) => d.id)).toEqual(['codex']);
    expect(detect({ CLAUDE_CONFIG_DIR: path.join(root, 'missing') })).toEqual([]);
  });

  it('ignores a directory named like a CLI, and a file named like a config dir', () => {
    fs.mkdirSync(path.join(binDir, 'codex'));
    fs.writeFileSync(path.join(homeDir, '.claude'), '');
    expect(detect()).toEqual([]);
  });

  it('tries Windows executable extensions on win32', () => {
    fs.writeFileSync(path.join(binDir, 'codex.cmd'), '');
    expect(detect({}, 'win32').map((d) => d.id)).toEqual(['codex']);
    expect(detect({}, 'linux')).toEqual([]);
  });
});

describe('chooseDefaultPlatforms / describePlatformChoice', () => {
  it('falls back to Claude Code and says so', () => {
    const choice = chooseDefaultPlatforms([]);
    expect(choice).toEqual({ source: 'fallback', platforms: ['claude'], detected: [] });
    const lines = describePlatformChoice(choice).join('\n');
    expect(lines).toContain('no coding CLI detected');
    expect(lines).toContain('Claude Code only');
    expect(lines).toContain('--all-platforms');
  });

  it('names what was detected and how to add the others', () => {
    const choice = chooseDefaultPlatforms([
      { id: 'claude', via: ['claude on PATH'] },
      { id: 'codex', via: ['~/.codex'] },
    ]);
    expect(choice.platforms).toEqual(['claude', 'codex']);
    const lines = describePlatformChoice(choice).join('\n');
    expect(lines).toContain('Claude Code (claude on PATH); Codex (~/.codex)');
    expect(lines).toContain('Not written: Antigravity / Gemini, OpenCode, Kimi Code');
    expect(lines).toContain('--platforms claude,codex,antigravity,opencode,kimi');
  });

  it('prints nothing about missing platforms when all five are chosen', () => {
    const lines = describePlatformChoice({
      source: 'explicit',
      platforms: ['claude', 'antigravity', 'opencode', 'kimi', 'codex'],
      detected: [],
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('as requested');
  });
});

describe('resolveInitOptions platform selection (#420)', () => {
  const ALL = ['claude', 'antigravity', 'opencode', 'kimi', 'codex'];
  const ctx = (flags: Record<string, unknown> = {}): CommandContext =>
    ({ args: [], flags: { _: [], ...flags }, cwd: root, interactive: false }) as CommandContext;
  const resolve = (flags: Record<string, unknown>, detected: DetectedPlatform[] = []) => {
    const spy = vi.fn(() => detected);
    const r = resolveInitOptions(ctx(flags), root, spy);
    if (!r.ok) throw new Error(r.message);
    return { ...r, detectCalls: spy.mock.calls.length };
  };

  it('defaults to the detected platforms only', () => {
    const r = resolve({}, [{ id: 'claude', via: ['claude on PATH'] }]);
    expect(r.options.selectedPlatforms).toEqual(['claude']);
    expect(r.platforms.source).toBe('detected');
    expect(r.options.components).toMatchObject({
      antigravity: false,
      opencode: false,
      kimicode: false,
      codex: false,
      claudeMd: true,
      mcp: true,
    });
  });

  it('writes Claude Code when nothing is detected', () => {
    const r = resolve({}, []);
    expect(r.options.selectedPlatforms).toEqual(['claude']);
    expect(r.platforms.source).toBe('fallback');
  });

  it('writes every detected platform, Claude Code included only when detected', () => {
    const r = resolve({}, [
      { id: 'antigravity', via: ['~/.gemini'] },
      { id: 'codex', via: ['codex on PATH'] },
    ]);
    expect(r.options.selectedPlatforms).toEqual(['antigravity', 'codex']);
    expect(r.options.components.antigravity).toBe(true);
    expect(r.options.components.codex).toBe(true);
    expect(r.options.components.claudeMd).toBe(false);
  });

  it.each([
    [{ platforms: 'codex,claude' }, ['codex', 'claude']],
    [{ platform: 'kimicode' }, ['kimi']],
    [{ 'all-platforms': true }, ALL],
    [{ target: 'all' }, ALL],
    [{ full: true }, ALL],
    [{ target: 'codex' }, ['codex']],
    [{ codex: true }, ['codex']],
    [{ 'only-claude': true }, ['claude']],
  ])('explicit flags %j pick %j without detection', (flags, expected) => {
    const r = resolve(flags, [{ id: 'opencode', via: ['opencode on PATH'] }]);
    expect(r.options.selectedPlatforms).toEqual(expected);
    expect(r.platforms.source).toBe('explicit');
    expect(r.detectCalls).toBe(0);
  });

  it('rejects an unknown --platforms id', () => {
    const r = resolveInitOptions(ctx({ platforms: 'claude,nope' }), root, () => []);
    expect(r).toEqual({ ok: false, message: 'Unknown init platform: claude,nope' });
  });
});

describe('platformsInProject', () => {
  it('reads the platforms an existing project has from its files', () => {
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), '');
    fs.mkdirSync(path.join(root, '.codex'));
    expect(platformsInProject(root)).toEqual(['claude', 'codex']);
  });
});
