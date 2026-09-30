/**
 * Which coding platforms `monomind init` writes by default (#420): the ones
 * installed on this machine, found by their CLI on PATH or their user config
 * directory under $HOME. Read-only — no process is spawned, nothing is
 * written. Claude Code is the fallback when nothing is found.
 *
 * @module @monomind/cli/init/detect-platforms
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PlatformId } from '../platform-adapters/types.js';
import type { InitOptions } from './types.js';

/** The platforms plain `init` can target, in the order it lists them. */
export const INIT_PLATFORMS = ['claude', 'antigravity', 'opencode', 'kimi', 'codex'] as const;
export type InitPlatform = (typeof INIT_PLATFORMS)[number];

export const INIT_PLATFORM_LABELS: Record<InitPlatform, string> = {
  claude: 'Claude Code',
  antigravity: 'Antigravity / Gemini',
  opencode: 'OpenCode',
  kimi: 'Kimi Code',
  codex: 'Codex',
};

interface Probe {
  /** Executable names looked up on PATH. */
  bins: string[];
  /** Config directories relative to $HOME. */
  homeDirs: string[];
  /** Environment variables that name a config directory. */
  envDirs?: string[];
}

const PROBES: Record<InitPlatform, Probe> = {
  claude: { bins: ['claude'], homeDirs: ['.claude'], envDirs: ['CLAUDE_CONFIG_DIR'] },
  antigravity: { bins: ['gemini', 'agy', 'antigravity'], homeDirs: ['.gemini', '.antigravity'] },
  opencode: { bins: ['opencode'], homeDirs: ['.opencode', path.join('.config', 'opencode')] },
  kimi: { bins: ['kimi'], homeDirs: ['.kimi', '.kimi-code'] },
  codex: { bins: ['codex'], homeDirs: ['.codex'], envDirs: ['CODEX_HOME'] },
};

export interface DetectOptions {
  /** PATH to search (default: process.env.PATH). */
  pathEnv?: string;
  /** Home directory (default: os.homedir()). */
  homeDir?: string;
  /** Environment for the config-dir variables (default: process.env). */
  env?: Readonly<Record<string, string | undefined>>;
  /** Windows executable extensions are tried when this is 'win32'. */
  platform?: NodeJS.Platform;
}

export interface DetectedPlatform {
  id: InitPlatform;
  /** What found it, e.g. `claude on PATH` or `~/.codex`. */
  via: string[];
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** `~` or `~/x` expanded against `home`. */
function expandHome(p: string, home: string): string {
  return p === '~' || p.startsWith('~/') || p.startsWith('~\\') ? path.join(home, p.slice(1)) : p;
}

function onPath(bin: string, dirs: string[], exts: string[]): boolean {
  return dirs.some((dir) => exts.some((ext) => isFile(path.join(dir, bin + ext))));
}

/** Installed init platforms, in INIT_PLATFORMS order. */
export function detectInstalledPlatforms(opts: DetectOptions = {}): DetectedPlatform[] {
  const env = opts.env ?? process.env;
  const home = opts.homeDir ?? os.homedir();
  const win = (opts.platform ?? process.platform) === 'win32';
  const delimiter = win ? ';' : path.delimiter;
  const dirs = String(opts.pathEnv ?? env.PATH ?? env.Path ?? '')
    .split(delimiter)
    // Windows PATH entries may be quoted.
    .map((dir) => (win ? dir.replace(/^"(.*)"$/, '$1') : dir))
    .filter(Boolean);
  const exts = win
    ? [
        '',
        ...String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
          .split(';')
          .filter(Boolean),
      ].flatMap((ext) => (ext ? [ext.toLowerCase(), ext.toUpperCase()] : ['']))
    : [''];
  const xdg = env.XDG_CONFIG_HOME ? expandHome(env.XDG_CONFIG_HOME, home) : undefined;

  const found: DetectedPlatform[] = [];
  for (const id of INIT_PLATFORMS) {
    const probe = PROBES[id];
    const via: string[] = [];
    for (const bin of probe.bins) if (onPath(bin, dirs, exts)) via.push(`${bin} on PATH`);
    for (const rel of probe.homeDirs) if (isDir(path.join(home, rel))) via.push(`~/${rel}`);
    if (id === 'opencode' && xdg && isDir(path.join(xdg, 'opencode'))) {
      via.push('$XDG_CONFIG_HOME/opencode');
    }
    for (const name of probe.envDirs ?? []) {
      const dir = env[name];
      if (dir && isDir(expandHome(dir, home))) via.push(`$${name}`);
    }
    if (via.length > 0) found.push({ id, via });
  }
  return found;
}

/** `detected` plus the project's own platforms, in INIT_PLATFORMS order. */
export function withProjectPlatforms(
  detected: DetectedPlatform[],
  inProject: readonly InitPlatform[],
): DetectedPlatform[] {
  const via = 'already in this project';
  return INIT_PLATFORMS.flatMap((id) => {
    const hit = detected.find((d) => d.id === id);
    if (!inProject.includes(id)) return hit ? [hit] : [];
    return [{ id, via: [...(hit?.via ?? []), via] }];
  });
}

/** How `init` arrived at its platform list, for the summary line. */
export interface PlatformChoice {
  source: 'detected' | 'fallback' | 'explicit';
  platforms: PlatformId[];
  detected: DetectedPlatform[];
  /** `--skip-claude`: leave Claude Code out of the "Not written" hint (#525). */
  skipClaude?: boolean;
}

/** The default selection: what is installed, else Claude Code alone. */
export function chooseDefaultPlatforms(detected: DetectedPlatform[]): PlatformChoice {
  return detected.length > 0
    ? { source: 'detected', platforms: detected.map((d) => d.id), detected }
    : { source: 'fallback', platforms: ['claude'], detected };
}

/**
 * The platforms an existing project already has on disk, judged by the files
 * `init` writes for each one. A plain `init` (no platform flags) adds these
 * to the detected ones, so `init --force` refreshes every platform a project
 * has, installed here or not.
 */
export function platformsInProject(targetDir: string): InitPlatform[] {
  const has = (...rel: string[]) => rel.some((r) => fs.existsSync(path.join(targetDir, r)));
  const map: Record<InitPlatform, boolean> = {
    claude: has('.claude/settings.json', 'CLAUDE.md', '.claude/skills'),
    antigravity: has('GEMINI.md', '.gemini'),
    opencode: has('opencode.json', '.opencode'),
    kimi: has('.kimi-code'),
    codex: has('.codex'),
  };
  return INIT_PLATFORMS.filter((id) => map[id]);
}

/** The one-line summaries init prints about its platform choice. */
export function describePlatformChoice(choice: PlatformChoice): string[] {
  const names = (ids: readonly PlatformId[]) =>
    ids.map((id) => INIT_PLATFORM_LABELS[id as InitPlatform] ?? id).join(', ');
  const lines: string[] = [];
  if (choice.source === 'explicit') {
    lines.push(`Platforms: ${names(choice.platforms)} (as requested)`);
  } else if (choice.source === 'fallback') {
    lines.push('Platforms: no coding CLI detected (claude, codex, gemini, opencode, kimi)');
    lines.push('  Writing Claude Code only.');
  } else {
    lines.push(
      `Platforms detected: ${choice.detected
        .map((d) => `${INIT_PLATFORM_LABELS[d.id]} (${d.via.join(', ')})`)
        .join('; ')}`,
    );
  }
  const others = INIT_PLATFORMS.filter(
    (id) => !choice.platforms.includes(id) && !(choice.skipClaude && id === 'claude'),
  );
  if (others.length > 0) {
    // `--all-platforms` would add Claude Code back, so it is no alternative
    // after `--skip-claude`.
    const allPlatforms = choice.skipClaude ? '' : ' or `monomind init --all-platforms --yes`';
    lines.push(
      `  Not written: ${names(others)}. Add them with \`monomind init --platforms ${[
        ...choice.platforms,
        ...others,
      ].join(',')} --yes\`${allPlatforms}.`,
    );
  }
  return lines;
}

/**
 * Point `options` at `platforms`: the adapter selection plus the legacy
 * component switches the writers read. Without Claude Code, the Claude-only
 * components are turned off.
 */
export function applyPlatformSelection(options: InitOptions, platforms: readonly PlatformId[]) {
  const on = (id: PlatformId) => platforms.includes(id);
  options.selectedPlatforms = [...platforms];
  options.components.antigravity = on('antigravity');
  options.components.opencode = on('opencode');
  options.components.kimicode = on('kimi');
  options.components.codex = on('codex');
  options.components.mcp = options.components.mcp && (on('claude') || on('antigravity'));
  if (!on('claude')) {
    options.components.settings = false;
    options.components.commands = false;
    options.components.agents = false;
    options.components.helpers = false;
    options.components.statusline = false;
    options.components.claudeMd = false;
  }
}
