import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HELPER_FILES, OBSOLETE_HELPER_NAMES } from '../init/helpers-generator.js';
import { generateSettings } from '../init/settings-generator.js';
import { DEFAULT_INIT_OPTIONS } from '../init/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..', '..', '..');

type Hooks = Record<string, { hooks: { command: string }[] }[]>;

function commands(hooks: Hooks): string[] {
  return Object.values(hooks).flatMap((groups) =>
    groups.flatMap((g) => g.hooks.map((h) => h.command)),
  );
}

// Issue #417: hooks that ran on every session/turn and did nothing.
const DEAD_HOOKS = [
  /auto-memory-hook\.mjs/,
  /hook-handler\.cjs"? status'?$/,
  /hook-handler\.cjs"? notify'?$/,
];

function assertNoDeadHooks(hooks: Hooks): void {
  for (const cmd of commands(hooks)) {
    for (const dead of DEAD_HOOKS) expect(cmd).not.toMatch(dead);
  }
}

describe('dead hooks are not registered (#417)', () => {
  it('the generator writes none of them', () => {
    const hooks = (generateSettings(DEFAULT_INIT_OPTIONS) as { hooks: Hooks }).hooks;
    assertNoDeadHooks(hooks);
    expect(hooks.Stop).toBeUndefined();
    expect(hooks.Notification).toBeUndefined();
  });

  for (const rel of ['.claude/settings.json', 'packages/@monomind/cli/.claude/settings.json']) {
    it(`${rel} has none of them`, () => {
      assertNoDeadHooks(JSON.parse(readFileSync(join(REPO_ROOT, rel), 'utf-8')).hooks);
    });
  }

  it('auto-memory-hook.mjs is no longer installed, and init --force removes it', () => {
    expect(HELPER_FILES['auto-memory-hook.mjs']).toBeUndefined();
    expect(OBSOLETE_HELPER_NAMES).toContain('auto-memory-hook.mjs');
  });
});
