/**
 * #428: `monomind browse` downloads Chrome on first use when no browser is
 * installed, instead of every install fetching it through puppeteer.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type BrowsersModule,
  CHROME_BUILD_ID,
  ensureManagedChrome,
  managedChromeDir,
} from '../browser/managed-chrome.js';
import { depsRoot, OptionalDependencyError } from '../utils/optional-deps.js';

let home: string;
let env: NodeJS.ProcessEnv;
const log = vi.fn();

function fakeBrowsers(platform: string | null = 'linux64') {
  const install = vi.fn(
    async (o: { cacheDir: string; downloadProgressCallback?: (d: number, t: number) => void }) => {
      o.downloadProgressCallback?.(50, 100);
      o.downloadProgressCallback?.(100, 100);
      const exe = join(o.cacheDir, 'chrome', `${platform}-${CHROME_BUILD_ID}`, 'chrome');
      mkdirSync(dirname(exe), { recursive: true });
      writeFileSync(exe, '');
    },
  );
  const mod: BrowsersModule = {
    Browser: { CHROME: 'chrome' },
    detectBrowserPlatform: () => platform ?? undefined,
    computeExecutablePath: (o) =>
      join(o.cacheDir, 'chrome', `${o.platform}-${o.buildId}`, 'chrome'),
    install,
  };
  return { mod, install };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mm-chrome-'));
  env = { MONOMIND_HOME: home };
  log.mockClear();
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('ensureManagedChrome', () => {
  it('downloads Chrome once into the deps directory and returns its path', async () => {
    const { mod, install } = fakeBrowsers();
    const exe = await ensureManagedChrome({ env, loadBrowsers: async () => mod, log });
    expect(exe).toBe(join(managedChromeDir(env), 'chrome', `linux64-${CHROME_BUILD_ID}`, 'chrome'));
    expect(existsSync(exe)).toBe(true);
    expect(install).toHaveBeenCalledOnce();
    expect(install.mock.calls[0][0].cacheDir.startsWith(depsRoot(env))).toBe(true);
    expect(readdirSync(depsRoot(env))).toEqual([`chrome@${CHROME_BUILD_ID}`]);
    expect(log.mock.calls.map((c) => c[0]).join('\n')).toMatch(/Chrome download 100%/);

    // Second call: already there, no download.
    await ensureManagedChrome({ env, loadBrowsers: async () => mod, log });
    expect(install).toHaveBeenCalledOnce();
  });

  it('with MONOMIND_NO_AUTO_INSTALL set, downloads nothing and prints the command', async () => {
    const { mod, install } = fakeBrowsers();
    const err = (await ensureManagedChrome({
      env: { ...env, MONOMIND_NO_AUTO_INSTALL: '1' },
      loadBrowsers: async () => mod,
      log,
    }).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(OptionalDependencyError);
    expect(err.message).toContain(
      `install chrome@${CHROME_BUILD_ID} --path "${managedChromeDir(env)}"`,
    );
    expect(install).not.toHaveBeenCalled();
  });

  it('explains when Chrome for Testing has no build for the platform', async () => {
    const { mod, install } = fakeBrowsers(null);
    await expect(ensureManagedChrome({ env, loadBrowsers: async () => mod, log })).rejects.toThrow(
      /no build for this platform/,
    );
    expect(install).not.toHaveBeenCalled();
  });

  it('leaves nothing behind when the download fails', async () => {
    const { mod } = fakeBrowsers();
    mod.install = async () => {
      throw new Error('ECONNRESET');
    };
    await expect(ensureManagedChrome({ env, loadBrowsers: async () => mod, log })).rejects.toThrow(
      'ECONNRESET',
    );
    expect(readdirSync(depsRoot(env))).toEqual([]);
  });
});
