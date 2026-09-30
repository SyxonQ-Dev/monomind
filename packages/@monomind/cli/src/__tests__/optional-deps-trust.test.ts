/**
 * #518 review, B1: code in the deps dir runs in monomind's unsandboxed
 * daemons, so before loading anything from it the installer refuses a tree
 * someone else could have planted: a symlink on the way in or leading out,
 * a file owned by another user, or one others may write.
 */
import type * as fs from 'node:fs';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Paths whose lstat reports another owner (the other-uid case). */
const foreign = new Set<string>();
vi.mock('node:fs', async (orig) => {
  const real = await orig<typeof import('node:fs')>();
  return {
    ...real,
    lstatSync: ((p: fs.PathLike, o?: fs.StatSyncOptions) => {
      const st = real.lstatSync(p, o as never) as fs.Stats;
      if (foreign.has(String(p))) return Object.assign(Object.create(st), { uid: st.uid + 1 });
      return st;
    }) as typeof real.lstatSync,
  };
});

const {
  assertTrustedTree,
  dependencyDir,
  depsRoot,
  ensureOptionalDependency,
  OptionalDependencyError,
} = await import('../utils/optional-deps.js');
const { ensureManagedChrome, managedChromeDir, CHROME_BUILD_ID } = await import(
  '../browser/managed-chrome.js'
);
const { fakeNpm, HOST, notFound, SDK, writeFakeSdk } = await import(
  './fixtures/optional-deps-fixture.js'
);

let home: string;
let env: NodeJS.ProcessEnv;
const log = vi.fn();
const opts = () => ({ env, resolveOwn: notFound, log, host: HOST, runNpm: fakeNpm('npm').run });
const plantSdk = (marker = 'PLANTED CODE RAN') => {
  mkdirSync(depsRoot(env), { recursive: true, mode: 0o700 });
  writeFakeSdk(dependencyDir(SDK, env), marker);
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mm-trust-'));
  env = { MONOMIND_HOME: home };
  foreign.clear();
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('the deps dir is only loaded when monomind could have written it alone', () => {
  it('loads a tree this user owns with safe modes', async () => {
    plantSdk('ok');
    await expect(ensureOptionalDependency<{ marker: string }>(SDK, opts())).resolves.toMatchObject({
      marker: 'ok',
    });
  });

  it('refuses an entry that is a symlink to a planted tree (the review PoC)', async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'mm-plant-'));
    writeFakeSdk(elsewhere, 'PLANTED CODE RAN');
    mkdirSync(depsRoot(env), { recursive: true, mode: 0o700 });
    symlinkSync(elsewhere, dependencyDir(SDK, env));
    const err = await ensureOptionalDependency(SDK, opts()).catch((e: Error) => e);
    expect(err).toBeInstanceOf(OptionalDependencyError);
    expect((err as Error).message).toMatch(/is a symlink/);
    rmSync(elsewhere, { recursive: true, force: true });
  });

  it('refuses a deps root that is a symlink', async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'mm-plant-'));
    writeFakeSdk(join(elsewhere, `${SDK.replace('/', '+')}@0.3.226`), 'PLANTED CODE RAN');
    symlinkSync(elsewhere, depsRoot(env));
    await expect(ensureOptionalDependency(SDK, opts())).rejects.toThrow(/deps is a symlink/);
    rmSync(elsewhere, { recursive: true, force: true });
  });

  it('refuses a symlink inside the entry that leads out of it', async () => {
    plantSdk();
    const pkg = join(dependencyDir(SDK, env), 'node_modules', SDK);
    rmSync(join(pkg, 'index.js'));
    const outside = join(home, 'evil.js');
    writeFileSync(outside, 'export const marker = "PLANTED CODE RAN";\n');
    symlinkSync(outside, join(pkg, 'index.js'));
    await expect(ensureOptionalDependency(SDK, opts())).rejects.toThrow(/links outside it/);
  });

  it('refuses a file owned by another user (mocked lstat)', async () => {
    plantSdk();
    const bin = join(
      dependencyDir(SDK, env),
      'node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude',
    );
    foreign.add(bin);
    await expect(ensureOptionalDependency(SDK, opts())).rejects.toThrow(/is owned by uid/);
  });

  it('refuses a deps root owned by another user (mocked lstat)', async () => {
    plantSdk();
    foreign.add(depsRoot(env));
    await expect(ensureOptionalDependency(SDK, opts())).rejects.toThrow(/deps is owned by uid/);
  });

  it('refuses a group- or other-writable file or directory', async () => {
    plantSdk();
    const pkg = join(dependencyDir(SDK, env), 'node_modules', SDK);
    chmodSync(join(pkg, 'index.js'), 0o666);
    await expect(ensureOptionalDependency(SDK, opts())).rejects.toThrow(
      /writable by group or others/,
    );
    chmodSync(join(pkg, 'index.js'), 0o644);
    chmodSync(depsRoot(env), 0o777);
    await expect(ensureOptionalDependency(SDK, opts())).rejects.toThrow(
      /writable by group or others/,
    );
  });

  it('removes group write from its own install, so a 002 umask does not break it', async () => {
    const old = process.umask(0o002);
    try {
      const mod = await ensureOptionalDependency<{ marker: string }>(SDK, opts());
      expect(mod.marker).toBe('npm');
    } finally {
      process.umask(old);
    }
  });

  it('assertTrustedTree rejects an entry outside the root', () => {
    expect(() => assertTrustedTree(join(home, 'deps'), home)).toThrow(/not under/);
  });
});

describe('the managed Chrome is held to the same rule', () => {
  const browsers = (dirFor: (cacheDir: string) => string) => ({
    Browser: { CHROME: 'chrome' },
    detectBrowserPlatform: () => 'linux64',
    computeExecutablePath: (o: { cacheDir: string }) => join(dirFor(o.cacheDir), 'chrome'),
    install: vi.fn(),
  });

  it('refuses a planted Chrome whose directory is a symlink', async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'mm-plant-'));
    writeFileSync(join(elsewhere, 'chrome'), '#!/bin/sh\necho PLANTED CODE RAN\n', { mode: 0o755 });
    mkdirSync(depsRoot(env), { recursive: true, mode: 0o700 });
    symlinkSync(elsewhere, managedChromeDir(env));
    const b = browsers((d) => d);
    await expect(ensureManagedChrome({ env, log, loadBrowsers: async () => b })).rejects.toThrow(
      /is a symlink/,
    );
    expect(b.install).not.toHaveBeenCalled();
    rmSync(elsewhere, { recursive: true, force: true });
  });

  it('refuses a Chrome binary owned by another user (mocked lstat)', async () => {
    const dir = managedChromeDir(env);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, 'chrome'), '', { mode: 0o755 });
    foreign.add(join(dir, 'chrome'));
    const b = browsers((d) => d);
    await expect(ensureManagedChrome({ env, log, loadBrowsers: async () => b })).rejects.toThrow(
      /owned by uid/,
    );
    expect(CHROME_BUILD_ID).toBeTruthy();
  });
});
