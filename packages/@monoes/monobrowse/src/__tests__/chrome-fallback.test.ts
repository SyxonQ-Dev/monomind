/**
 * #428: an installed browser always wins; monomind's downloaded Chrome (the
 * registered fallback, or MONOBROWSE_CHROME_PATH for a child process) is used
 * only when there is none.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const present = new Set<string>();
vi.mock('node:fs', async (orig) => ({
  ...(await orig<typeof import('node:fs')>()),
  existsSync: (p: string) => present.has(p),
}));
vi.mock('node:child_process', async (orig) => ({
  ...(await orig<typeof import('node:child_process')>()),
  execSync: () => {
    throw new Error('which: nothing found');
  },
}));

const { findChrome, resolveChrome, setChromeFallback } = await import(
  '../browser/browser-discovery.js'
);
const { CHROME_EXECUTABLES } = await import('../browser/types.js');

const SYSTEM = CHROME_EXECUTABLES.find((p) => p.startsWith('/usr/bin/')) as string;

beforeEach(() => {
  present.clear();
  delete process.env.MONOBROWSE_CHROME_PATH;
});
afterEach(() => {
  setChromeFallback(undefined);
  delete process.env.MONOBROWSE_CHROME_PATH;
});

describe('resolveChrome', () => {
  it('throws the usual error when there is no browser and no fallback', async () => {
    await expect(resolveChrome()).rejects.toThrow('No supported browser found');
  });

  it('asks the fallback only when no browser is installed', async () => {
    const fallback = vi.fn(async () => '/deps/chrome');
    setChromeFallback(fallback);
    await expect(resolveChrome()).resolves.toBe('/deps/chrome');
    expect(fallback).toHaveBeenCalledOnce();

    present.add(SYSTEM);
    fallback.mockClear();
    await expect(resolveChrome()).resolves.toBe(SYSTEM);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('never falls back for an explicit executablePath', async () => {
    const fallback = vi.fn(async () => '/deps/chrome');
    setChromeFallback(fallback);
    await expect(resolveChrome('/nope/chrome')).rejects.toThrow('Chrome executable not found');
    expect(fallback).not.toHaveBeenCalled();
  });
});

describe('findChrome and MONOBROWSE_CHROME_PATH', () => {
  it('uses the variable only when no browser is installed', () => {
    process.env.MONOBROWSE_CHROME_PATH = '/deps/chrome';
    present.add('/deps/chrome');
    expect(findChrome()).toBe('/deps/chrome');
    present.add(SYSTEM);
    expect(findChrome()).toBe(SYSTEM);
  });

  it('ignores a variable that points at nothing', () => {
    process.env.MONOBROWSE_CHROME_PATH = '/deps/missing';
    expect(() => findChrome()).toThrow('No supported browser found');
  });
});
