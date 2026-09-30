/**
 * GH #411: the init wizard's Custom "skill sets" answer was ignored — it set
 * skills.core/memory/github but left skills.all = true, so every skill was
 * installed anyway — and its answers were written into the shared presets.
 * The skill sets are now opt-in packs on top of core, asked for every preset
 * but Full.
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

async function run(preset: string, multiSelects: string[][]): Promise<InitOptions> {
  answers.select = [preset, 'mesh', 'memory'];
  answers.multiSelect = multiSelects;
  await wizardCommand.action!({ args: [], flags: { _: [] }, cwd: '/tmp/x', interactive: true });
  expect(executed.options).toHaveLength(1);
  return executed.options[0];
}

describe('init wizard packs (GH #411)', () => {
  it('installs core plus the packs the user picked', async () => {
    const options = await run('default', [['orgs', 'github']]);
    expect(options.packs).toEqual(['orgs', 'github']);
    expect(options.skills).toEqual({ core: true, all: false });
    expect(options.agents).toEqual({ core: true, all: false });
  });

  it('asks for packs after the Custom component choice', async () => {
    const options = await run('custom', [['skills', 'commands'], ['extras']]);
    expect(options.components.agents).toBe(false);
    expect(options.packs).toEqual(['extras']);
  });

  it('Full installs every pack without asking', async () => {
    const options = await run('full', []);
    expect(options.packs).toBeUndefined();
    expect(options.skills.all).toBe(true);
  });

  it('leaves the shared default presets untouched', async () => {
    const before = structuredClone(DEFAULT_INIT_OPTIONS);
    await run('custom', [['skills'], ['business']]);
    expect(DEFAULT_INIT_OPTIONS).toEqual(before);
  });
});
