/**
 * #428: heavy dependencies are installed on first use into
 * $MONOMIND_HOME/deps, never into the user's project.
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
import {
  dependencyDir,
  depsRoot,
  ensureOptionalDependency,
  manualInstallCommand,
  type NpmRunner,
  OPTIONAL_DEPENDENCIES,
  OptionalDependencyError,
} from '../utils/optional-deps.js';

const SDK = '@anthropic-ai/claude-agent-sdk';
const VERSION = OPTIONAL_DEPENDENCIES[SDK].version;

let home: string;
let env: NodeJS.ProcessEnv;
const log = vi.fn();

const notFound = async (name: string) => {
  throw Object.assign(new Error(`Cannot find package '${name}' imported from /x`), {
    code: 'ERR_MODULE_NOT_FOUND',
  });
};

/** Writes a minimal ESM package that exports `marker`. */
function writeFakePackage(prefix: string, marker: string, version: string = VERSION): void {
  const dir = join(prefix, 'node_modules', SDK);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: SDK, version, type: 'module', exports: './index.js' }),
  );
  writeFileSync(join(dir, 'index.js'), `export const marker = ${JSON.stringify(marker)};\n`);
}

/** A stand-in for npm: records its calls and "installs" the fake package
 *  into the prefix it was given. */
function fakeNpm(marker: string, delayMs = 0) {
  const calls: Array<{ args: string[]; cwd: string }> = [];
  const run: NpmRunner = async (args, cwd) => {
    calls.push({ args, cwd });
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    const prefix = args.find((a) => a.startsWith('--prefix='))?.slice('--prefix='.length) as string;
    writeFakePackage(prefix, marker);
  };
  return { run, calls };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mm-deps-'));
  env = { MONOMIND_HOME: home };
  log.mockClear();
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('ensureOptionalDependency', () => {
  it('returns the copy monomind itself resolves, without installing', async () => {
    const npm = fakeNpm('unused');
    const own = { marker: 'own' };
    const mod = await ensureOptionalDependency<{ marker: string }>(SDK, {
      env,
      importOwn: async () => own,
      runNpm: npm.run,
      log,
    });
    expect(mod).toBe(own);
    expect(npm.calls).toHaveLength(0);
    expect(existsSync(depsRoot(env))).toBe(false);
  });

  it('imports an existing install from the deps directory', async () => {
    writeFakePackage(dependencyDir(SDK, env), 'from-deps');
    const npm = fakeNpm('unused');
    const mod = await ensureOptionalDependency<{ marker: string }>(SDK, {
      env,
      importOwn: notFound,
      runNpm: npm.run,
      log,
    });
    expect(mod.marker).toBe('from-deps');
    expect(npm.calls).toHaveLength(0);
  });

  it('installs a missing package into the deps directory, pinned and without scripts', async () => {
    const npm = fakeNpm('installed');
    const mod = await ensureOptionalDependency<{ marker: string }>(SDK, {
      env,
      importOwn: notFound,
      runNpm: npm.run,
      log,
    });
    expect(mod.marker).toBe('installed');
    expect(npm.calls).toHaveLength(1);
    const { args, cwd } = npm.calls[0];
    expect(args[0]).toBe('install');
    expect(args).toContain(`${SDK}@${VERSION}`);
    expect(args).toContain('--ignore-scripts');
    expect(args).toContain('--global=false');
    expect(args).toContain(`--prefix=${cwd}`);
    expect(cwd.startsWith(depsRoot(env))).toBe(true);
    // The staging directory was renamed into place; nothing else is left.
    expect(readdirSync(depsRoot(env)).sort()).toEqual([`${SDK.replace('/', '+')}@${VERSION}`]);
    expect(log.mock.calls[0][0]).toMatch(/Installing it once into/);
    expect(log.mock.calls[0][0]).toMatch(/MONOMIND_NO_AUTO_INSTALL/);
  });

  it('reinstalls over a version that does not match the pin', async () => {
    writeFakePackage(dependencyDir(SDK, env), 'stale', '0.0.1');
    const npm = fakeNpm('fresh');
    const mod = await ensureOptionalDependency<{ marker: string }>(SDK, {
      env,
      importOwn: notFound,
      runNpm: npm.run,
      log,
    });
    expect(mod.marker).toBe('fresh');
    expect(npm.calls).toHaveLength(1);
  });

  it('with MONOMIND_NO_AUTO_INSTALL set, installs nothing and prints the exact command', async () => {
    const npm = fakeNpm('unused');
    const err = (await ensureOptionalDependency(SDK, {
      env: { ...env, MONOMIND_NO_AUTO_INSTALL: '1' },
      importOwn: notFound,
      runNpm: npm.run,
      log,
    }).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(OptionalDependencyError);
    expect(err.message).toContain(manualInstallCommand(SDK, env));
    expect(err.message).toContain(`npm install --prefix "${dependencyDir(SDK, env)}"`);
    expect(err.message).toContain(`${SDK}@${VERSION}`);
    expect(npm.calls).toHaveLength(0);
    expect(existsSync(depsRoot(env))).toBe(false);
  });

  it('treats MONOMIND_NO_AUTO_INSTALL=0 as unset', async () => {
    const npm = fakeNpm('installed');
    await ensureOptionalDependency(SDK, {
      env: { ...env, MONOMIND_NO_AUTO_INSTALL: '0' },
      importOwn: notFound,
      runNpm: npm.run,
      log,
    });
    expect(npm.calls).toHaveLength(1);
  });

  it('refuses any package that is not in the allow-list', async () => {
    const npm = fakeNpm('unused');
    await expect(
      ensureOptionalDependency('left-pad; rm -rf ~' as typeof SDK, {
        env,
        importOwn: notFound,
        runNpm: npm.run,
        log,
      }),
    ).rejects.toThrow(/not a dependency monomind installs/);
    expect(npm.calls).toHaveLength(0);
  });

  it('rethrows a load failure that is not "package missing"', async () => {
    await expect(
      ensureOptionalDependency(SDK, {
        env,
        importOwn: async () => {
          throw new SyntaxError('broken module');
        },
        runNpm: fakeNpm('unused').run,
        log,
      }),
    ).rejects.toThrow('broken module');
  });

  it('reports a failed install with the manual command and leaves no partial directory', async () => {
    const err = (await ensureOptionalDependency(SDK, {
      env,
      importOwn: notFound,
      runNpm: async (args) => {
        const prefix = args.find((a) => a.startsWith('--prefix='))?.slice(9) as string;
        writeFileSync(join(prefix, 'half-written'), '');
        throw new Error('npm exited 1: E404');
      },
      log,
    }).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(OptionalDependencyError);
    expect(err.message).toContain('E404');
    expect(err.message).toContain(manualInstallCommand(SDK, env));
    expect(existsSync(dependencyDir(SDK, env))).toBe(false);
    expect(readdirSync(depsRoot(env))).toEqual([]);
  });

  it('never runs npm in, or writes to, the current project', async () => {
    const project = mkdtempSync(join(tmpdir(), 'mm-proj-'));
    const manifest = '{ "name": "users-project", "dependencies": {} }\n';
    writeFileSync(join(project, 'package.json'), manifest);
    const cwd = process.cwd();
    process.chdir(project);
    try {
      const npm = fakeNpm('installed');
      await ensureOptionalDependency(SDK, { env, importOwn: notFound, runNpm: npm.run, log });
      expect(npm.calls[0].cwd.startsWith(project)).toBe(false);
      expect(npm.calls[0].args.some((a) => a.includes(project))).toBe(false);
    } finally {
      process.chdir(cwd);
    }
    expect(readFileSync(join(project, 'package.json'), 'utf8')).toBe(manifest);
    expect(readdirSync(project)).toEqual(['package.json']);
    rmSync(project, { recursive: true, force: true });
  });

  it('installs once when two callers race (lock)', async () => {
    const npm = fakeNpm('raced', 300);
    const opts = { env, importOwn: notFound, runNpm: npm.run, log };
    const [a, b] = await Promise.all([
      ensureOptionalDependency<{ marker: string }>(SDK, opts),
      ensureOptionalDependency<{ marker: string }>(SDK, opts),
    ]);
    expect(a.marker).toBe('raced');
    expect(b.marker).toBe('raced');
    expect(npm.calls).toHaveLength(1);
    expect(existsSync(`${dependencyDir(SDK, env)}.lock`)).toBe(false);
  });

  it('takes over a lock left by a process that died', async () => {
    const lock = `${dependencyDir(SDK, env)}.lock`;
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, 'pid'), '2147483646'); // no such process
    const npm = fakeNpm('recovered');
    const mod = await ensureOptionalDependency<{ marker: string }>(SDK, {
      env,
      importOwn: notFound,
      runNpm: npm.run,
      log,
    });
    expect(mod.marker).toBe('recovered');
    expect(existsSync(lock)).toBe(false);
  });
});

describe('OPTIONAL_DEPENDENCIES', () => {
  it('pins the SDK to the version the CLI develops and tests against', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
    expect(pkg.devDependencies[SDK]).toBe(VERSION);
    expect(pkg.dependencies[SDK]).toBeUndefined();
  });
});
