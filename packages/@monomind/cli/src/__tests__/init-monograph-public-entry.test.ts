/**
 * #420: init's code-graph step must resolve @monoes/monograph through its
 * public entry (the deep dist path is not exported) and must never run
 * `npm install` inside the user's project when monograph cannot be loaded.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn((_cmd: string, _args: string[], _opts: unknown) => ({ unref: vi.fn() })),
  execSync: vi.fn(),
  execFileSync: vi.fn(),
  resolve: { override: undefined as string | null | undefined },
}));

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: mocks.spawn,
  execSync: mocks.execSync,
  execFileSync: mocks.execFileSync,
}));

vi.mock('../init/shared.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../init/shared.js')>();
  return {
    ...actual,
    resolveMonographEntryUrl: () =>
      mocks.resolve.override === undefined
        ? actual.resolveMonographEntryUrl()
        : mocks.resolve.override,
  };
});

import { initKnowledgeGraph } from '../init/init-post-steps.js';
import type { InitResult } from '../init/types.js';

function emptyResult(): InitResult {
  return {
    success: true,
    platform: {} as InitResult['platform'],
    created: { directories: [], files: [] },
    updated: [],
    skipped: [],
    removed: [],
    errors: [],
    summary: { skillsCount: 0, commandsCount: 0, agentsCount: 0, hooksEnabled: 0 },
  };
}

describe('initKnowledgeGraph (#420)', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'init-monograph-'));
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"user-project"}\n');
    mocks.spawn.mockClear();
    mocks.execSync.mockClear();
    mocks.execFileSync.mockClear();
    mocks.resolve.override = undefined;
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('spawns the build against the public @monoes/monograph entry', async () => {
    const result = emptyResult();
    await initKnowledgeGraph(dir, result);

    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    const args = mocks.spawn.mock.calls[0][1];
    const script = args[args.indexOf('--eval') + 1];
    expect(script).toContain(`from ${JSON.stringify(import.meta.resolve('@monoes/monograph'))}`);
    expect(result.warnings ?? []).toEqual([]);
    expect(mocks.execSync).not.toHaveBeenCalled();
  });

  it('never installs into the project when monograph cannot be loaded', async () => {
    mocks.resolve.override = null;
    const result = emptyResult();
    await initKnowledgeGraph(dir, result);

    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.execSync).not.toHaveBeenCalled();
    expect(mocks.execFileSync).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).toBe(
      '{"name":"user-project"}\n',
    );
    expect(fs.existsSync(path.join(dir, 'node_modules'))).toBe(false);
    expect(result.created.files).toEqual([]);
    expect(result.warnings).toEqual([
      expect.stringContaining('build it later with `npx monomind monograph build`'),
    ]);
  });
});
