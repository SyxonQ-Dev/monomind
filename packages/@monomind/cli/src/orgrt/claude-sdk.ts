// packages/@monomind/cli/src/orgrt/claude-sdk.ts
/**
 * The Claude Agent SDK and the Claude Code binary it runs (#428, #522).
 *
 * The SDK is installed into ~/.monomind/deps on first use
 * (utils/optional-deps.ts). Most of its 300 MB is its own copy of Claude Code.
 * When a usable Claude Code is already installed, it is passed to the SDK as
 * `pathToClaudeCodeExecutable`, and the SDK is installed without its bundled
 * binary.
 *
 * Where to look, in order (nothing is run to find it):
 *   1. $MONOMIND_CLAUDE_PATH. Set to `bundled`, it turns detection off.
 *   2. `claude` on PATH;
 *   3. ~/.local/bin/claude;
 *   4. ~/.claude/local/claude.
 *
 * What is accepted. The binary's real path is what the SDK runs, so a
 * symlink swapped later changes nothing in this process. The org daemons run
 * it outside every role sandbox, so a role that could rewrite it would run
 * code as the operator:
 *   - A binary found on its own (2-4) must be a system install: the file and
 *     every directory above it owned by root and not writable by group or
 *     others. Org roles run as the operator's user, and the bwrap mask
 *     (authority-mask.ts) leaves everything that user can write writable, so
 *     nothing the user owns can be trusted cheaply. That excludes the usual
 *     per-user installs (~/.local/share/claude, mise, nvm, Homebrew); see #527.
 *   - $MONOMIND_CLAUDE_PATH is the operator's own choice and may point
 *     anywhere. The file only has to be owned by this user or root and not
 *     writable by group or others. If it is under a directory roles can
 *     write, protecting it is up to the operator.
 * Then `claude --version` runs once per process (no shell, short timeout).
 * The version must have the same major as the Claude Code the pinned SDK
 * bundles, and be that version or newer: the SDK passes the CLI flags and
 * control messages of its own Claude Code release, and an older CLI rejects
 * the flags it does not know. Newer 2.x releases keep accepting them.
 * Anything refused falls back to the SDK's bundled binary. An explicit path
 * that is refused is reported on stderr; it is never replaced by another
 * candidate.
 */
import { execFile } from 'node:child_process';
import { accessSync, constants, realpathSync, type Stats, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { type EnsureOptions, ensureOptionalDependency } from '../utils/optional-deps.js';

export const CLAUDE_PATH_ENV = 'MONOMIND_CLAUDE_PATH';
/** The Claude Code version bundled with the pinned SDK (its manifest.json);
 *  claude-sdk.test.ts checks it against the installed SDK. */
export const SDK_BUNDLED_CLAUDE_VERSION = '2.1.226';
const SDK = '@anthropic-ai/claude-agent-sdk';
const VERSION_TIMEOUT_MS = 5_000;

export interface ClaudeProbe {
  env: NodeJS.ProcessEnv;
  home: string;
  platform: NodeJS.Platform;
  /** This process's uid; undefined where there is none (Windows). */
  uid: number | undefined;
  realpath: (p: string) => string;
  stat: (p: string) => Stats;
  isExecutable: (p: string) => boolean;
  /** Stdout of `<file> --version`. */
  version: (file: string) => Promise<string>;
  log: (line: string) => void;
}

export interface InstalledClaude {
  /** Real path of the binary to use; undefined means the SDK's own. */
  path?: string;
  /** Binaries found but not used, with the reason. */
  skipped: string[];
}

interface Candidate {
  path: string;
  explicit: boolean;
}

/** Where to look, in order; empty when detection is off. */
export function claudeCandidates(
  env: NodeJS.ProcessEnv,
  home: string,
  platform: NodeJS.Platform,
): Candidate[] {
  const explicit = env[CLAUDE_PATH_ENV]?.trim();
  if (explicit === 'bundled') return [];
  if (explicit) return [{ path: explicit, explicit: true }];
  const bin = platform === 'win32' ? 'claude.exe' : 'claude';
  // Relative PATH entries depend on the cwd; skip them.
  const onPath = (env.PATH ?? '')
    .split(delimiter)
    .filter((d) => d && isAbsolute(d))
    .map((d) => join(d, bin));
  const paths = [...onPath, join(home, '.local', 'bin', bin), join(home, '.claude', 'local', bin)];
  return [...new Set(paths)].map((path) => ({ path, explicit: false }));
}

/** Whether `claude --version` output names a Claude Code the pinned SDK can
 *  drive: same major as the bundled one, and that version or newer. */
export function compatibleClaudeVersion(output: string): { ok: boolean; version?: string } {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(output);
  if (!m) return { ok: false };
  const have = m.slice(1, 4).map(Number);
  const need = SDK_BUNDLED_CLAUDE_VERSION.split('.').map(Number);
  const version = have.join('.');
  if (have[0] !== need[0]) return { ok: false, version };
  for (let i = 1; i < 3; i++) if (have[i] !== need[i]) return { ok: have[i] > need[i], version };
  return { ok: true, version };
}

const groupOrOtherWritable = (st: Stats): boolean => (Number(st.mode) & 0o022) !== 0;

/** Why the binary at `real` is not a system install, or undefined. */
export function notSystemInstalled(real: string, probe: ClaudeProbe): string | undefined {
  if (probe.uid === undefined) return 'file ownership cannot be checked on this platform';
  for (let cur = real; ; cur = dirname(cur)) {
    const st = probe.stat(cur);
    if (st.uid !== 0)
      return `${cur} is owned by uid ${st.uid}, not root, so org roles may write it`;
    if (groupOrOtherWritable(st)) return `${cur} is writable by group or others`;
    if (dirname(cur) === cur) return undefined;
  }
}

/** Why an operator-chosen binary is refused, or undefined. */
function badExplicitBinary(real: string, probe: ClaudeProbe): string | undefined {
  const st = probe.stat(real);
  if (probe.uid !== undefined && st.uid !== probe.uid && st.uid !== 0)
    return `${real} is owned by uid ${st.uid}, not by this user or root`;
  if (probe.platform !== 'win32' && groupOrOtherWritable(st))
    return `${real} is writable by group or others`;
  return undefined;
}

type Checked = { real: string } | { why: string; missing?: boolean };

async function checkCandidate(c: Candidate, probe: ClaudeProbe): Promise<Checked> {
  if (!isAbsolute(c.path)) return { why: 'it is not an absolute path' };
  let real: string;
  try {
    real = probe.realpath(c.path);
  } catch {
    return { why: 'it does not exist', missing: true };
  }
  try {
    if (!probe.stat(real).isFile()) return { why: `${real} is not a file` };
    if (!probe.isExecutable(real)) return { why: `${real} is not executable` };
    const bad = c.explicit ? badExplicitBinary(real, probe) : notSystemInstalled(real, probe);
    if (bad) return { why: bad };
    const v = compatibleClaudeVersion(await probe.version(real));
    if (!v.ok) {
      const [major] = SDK_BUNDLED_CLAUDE_VERSION.split('.');
      return {
        why:
          `${real} is Claude Code ${v.version ?? 'of an unknown version'}, and the Claude ` +
          `runtime needs ${major}.x, ${SDK_BUNDLED_CLAUDE_VERSION} or newer`,
      };
    }
  } catch (e) {
    return { why: `checking ${real} failed: ${(e as Error).message}` };
  }
  return { real };
}

/** Finds the Claude Code to use (see the file header). */
export async function findInstalledClaude(probe: ClaudeProbe): Promise<InstalledClaude> {
  const skipped: string[] = [];
  for (const c of claudeCandidates(probe.env, probe.home, probe.platform)) {
    const r = await checkCandidate(c, probe);
    if ('real' in r) return { path: r.real, skipped };
    if (c.explicit) {
      probe.log(
        `${CLAUDE_PATH_ENV}=${c.path} is not used: ${r.why}. ` +
          "Using the Claude Agent SDK's bundled Claude Code.",
      );
      return { skipped };
    }
    if (!r.missing) skipped.push(`${c.path}: ${r.why}`);
  }
  return { skipped };
}

const runVersion = (file: string): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      ['--version'],
      { timeout: VERSION_TIMEOUT_MS, shell: false, windowsHide: true, maxBuffer: 64 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(String(stdout))),
    );
  });

export const defaultClaudeProbe = (env: NodeJS.ProcessEnv = process.env): ClaudeProbe => ({
  env,
  home: homedir(),
  platform: process.platform,
  uid: process.getuid?.(),
  realpath: realpathSync,
  stat: statSync,
  isExecutable: (p) => {
    try {
      accessSync(p, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
  version: runVersion,
  log: (line) => process.stderr.write(`[monomind] ${line}\n`),
});

/** How to load the SDK given what `findInstalledClaude` found. */
export function sdkLoadOptions(found: InstalledClaude): EnsureOptions {
  if (found.path) return { withoutSdkBinary: true };
  if (!found.skipped.length) return {};
  return {
    note:
      `An installed Claude Code was not used (${found.skipped.join('; ')}); ` +
      `set ${CLAUDE_PATH_ENV} to a Claude Code binary to use it instead.`,
  };
}

export type ClaudeSdk = Pick<
  typeof import('@anthropic-ai/claude-agent-sdk'),
  'createSdkMcpServer' | 'query' | 'tool'
> & {
  /** Set when an installed Claude Code is used: the SDK's
   *  `pathToClaudeCodeExecutable`. */
  executable?: string;
};

let claudeSdk: Promise<ClaudeSdk> | undefined;

/** The Claude Agent SDK, installed into ~/.monomind/deps on first use
 *  (#428; not a dependency of the published package), plus the installed
 *  Claude Code to run, if any (#522). Loaded once per process; a failure is
 *  not cached, so a later session retries. */
export const loadClaudeSdk = (): Promise<ClaudeSdk> =>
  (claudeSdk ??= (async () => {
    const found = await findInstalledClaude(defaultClaudeProbe());
    const sdk = await ensureOptionalDependency<ClaudeSdk>(SDK, sdkLoadOptions(found));
    const { createSdkMcpServer, query, tool } = sdk;
    return { createSdkMcpServer, query, tool, ...(found.path ? { executable: found.path } : {}) };
  })().catch((err) => {
    claudeSdk = undefined;
    throw err;
  }));

/** The SDK option that runs `sdk.executable`, if one was found. */
export const executableOption = (sdk: ClaudeSdk): { pathToClaudeCodeExecutable?: string } =>
  sdk.executable ? { pathToClaudeCodeExecutable: sdk.executable } : {};
