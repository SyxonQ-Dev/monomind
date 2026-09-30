/**
 * #519: the MCP auto-install path installs optional packages through
 * ensureOptionalDependency into $MONOMIND_HOME/deps, at the pinned version,
 * and never writes to the project in the current directory.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetInstallAttempts, tryImportOrInstall } from '../mcp-tools/auto-install.js';
import { depsRoot, type NpmRunner, OPTIONAL_DEPENDENCIES } from '../utils/optional-deps.js';

const PKG = 'monofence-ai';
const VERSION = OPTIONAL_DEPENDENCIES[PKG].version;
const PROJECT_PKG = `${JSON.stringify({ name: 'user-project', version: '1.0.0' }, null, 2)}\n`;

let home: string;
let project: string;
let env: NodeJS.ProcessEnv;
const originalCwd = process.cwd();

const notFound = async (name: string) => {
  throw Object.assign(new Error(`Cannot find package '${name}' imported from /x`), {
    code: 'ERR_MODULE_NOT_FOUND',
  });
};

/** A stand-in for npm that "installs" a fake monofence-ai into --prefix. */
function fakeNpm() {
  const calls: Array<{ args: string[]; cwd: string }> = [];
  const run: NpmRunner = async (args, cwd) => {
    calls.push({ args, cwd });
    const prefix = args.find((a) => a.startsWith('--prefix='))?.slice('--prefix='.length) as string;
    const dir = join(prefix, 'node_modules', PKG);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: PKG, version: VERSION, type: 'module', exports: './index.js' }),
    );
    writeFileSync(join(dir, 'index.js'), 'export const isSafe = () => true;\n');
  };
  return { run, calls };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mm-autoinstall-home-'));
  project = mkdtempSync(join(tmpdir(), 'mm-autoinstall-project-'));
  writeFileSync(join(project, 'package.json'), PROJECT_PKG);
  env = { MONOMIND_HOME: home };
  process.chdir(project);
  resetInstallAttempts();
});
afterEach(() => {
  process.chdir(originalCwd);
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

describe('tryImportOrInstall (#519)', () => {
  it('pins monofence-ai to an exact version on the allow-list', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('installs into the deps directory and leaves the project untouched', async () => {
    const npm = fakeNpm();
    const mod = await tryImportOrInstall<{ isSafe: () => boolean }>(PKG, {
      env,
      importOwn: notFound,
      runNpm: npm.run,
      silent: true,
    });

    expect(mod?.isSafe()).toBe(true);
    expect(npm.calls).toHaveLength(1);
    const { args, cwd } = npm.calls[0];
    expect(args).toContain(`${PKG}@${VERSION}`);
    expect(args).toContain('--ignore-scripts');
    expect(args).not.toContain('--no-save');
    expect(cwd.startsWith(depsRoot(env))).toBe(true);
    expect(cwd.startsWith(project)).toBe(false);

    expect(readdirSync(project)).toEqual(['package.json']);
    expect(existsSync(join(project, 'node_modules'))).toBe(false);
    expect(readFileSync(join(project, 'package.json'), 'utf8')).toBe(PROJECT_PKG);
  });

  it('does not retry a failed install in the same session', async () => {
    const runNpm = vi.fn<NpmRunner>(async () => {
      throw new Error('offline');
    });
    const opts = { env, importOwn: notFound, runNpm, silent: true };

    expect(await tryImportOrInstall(PKG, opts)).toBeNull();
    expect(await tryImportOrInstall(PKG, opts)).toBeNull();
    expect(runNpm).toHaveBeenCalledTimes(1);
    expect(existsSync(join(project, 'node_modules'))).toBe(false);
  });

  it('never installs a package that is not on the allow-list', async () => {
    const runNpm = vi.fn<NpmRunner>();
    const mod = await tryImportOrInstall('left-pad-not-allowed-519', {
      env,
      runNpm,
      silent: true,
    });

    expect(mod).toBeNull();
    expect(runNpm).not.toHaveBeenCalled();
    expect(existsSync(join(project, 'node_modules'))).toBe(false);
    expect(existsSync(depsRoot(env))).toBe(false);
  });
});
