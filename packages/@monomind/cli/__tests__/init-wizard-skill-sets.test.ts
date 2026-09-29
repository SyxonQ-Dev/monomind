/**
 * GH #411: the init wizard's Custom "skill sets" answer was ignored — it set
 * skills.core/memory/github but left skills.all = true, so every skill was
 * installed anyway — and its answers were written into the shared presets.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InitOptions } from '../src/init/types.js';

const answers = vi.hoisted(() => ({
  select: [] as string[],
  multiSelect: [] as string[][],
}));
const executed = vi.hoisted(() => ({ options: [] as InitOptions[] }));

vi.mock('../src/prompt.js', () => ({
  select: vi.fn(async () => answers.select.shift()),
  multiSelect: vi.fn(async () => answers.multiSelect.shift()),
  input: vi.fn(async () => '5'),
  confirm: vi.fn(async () => false),
}));

vi.mock('../src/init/executor.js', () => ({
  executeInit: vi.fn(async (options: InitOptions) => {
    executed.options.push(options);
    return { success: false, errors: [] };
  }),
}));

// Load through init.ts, as the CLI does: init-wizard -> init/index has an
// import cycle back into init.ts that only resolves in that order.
await import('../src/commands/init.js');
const { wizardCommand } = await import('../src/commands/init-wizard.js');
const { DEFAULT_INIT_OPTIONS } = await import('../src/init/types.js');
const { output } = await import('../src/output.js');
output.setVerbosity('quiet');

beforeEach(() => {
  executed.options.length = 0;
});

async function runCustom(skillSets: string[]): Promise<InitOptions> {
  answers.select = ['custom', 'mesh', 'memory'];
  answers.multiSelect = [['skills', 'commands'], skillSets, []];
  await wizardCommand.action!({ args: [], flags: { _: [] }, cwd: '/tmp/x', interactive: true });
  expect(executed.options).toHaveLength(1);
  return executed.options[0];
}

describe('init wizard skill sets', () => {
  it('installs only the skill sets the user picked', async () => {
    const options = await runCustom(['core', 'github']);
    expect(options.skills).toEqual({
      core: true,
      extended: false,
      memory: false,
      github: true,
      browser: false,
      advanced: false,
      all: false,
    });
  });

  it('leaves the shared default presets untouched', async () => {
    const before = structuredClone(DEFAULT_INIT_OPTIONS);
    await runCustom(['memory']);
    expect(DEFAULT_INIT_OPTIONS).toEqual(before);
  });
});
