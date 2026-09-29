/**
 * Regression test for #478: `monomind config get memory` printed
 * `memory = [object Object]` because the human-output branch of getCommand
 * interpolated the raw value into a template literal. Objects and arrays must
 * be pretty-printed as JSON; scalars keep the `key = value` form.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configCommand } from '../commands/config.js';
import { output } from '../output.js';
import { configManager } from '../services/config-file-manager.js';
import type { CommandContext } from '../types.js';

const getCommand = configCommand.subcommands?.find((sc) => sc.name === 'get');

let cwd: string;
let lines: string[];

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'config-get-object-test-'));
  lines = [];
  vi.spyOn(output, 'writeln').mockImplementation((text?: string) => {
    lines.push(text ?? '');
  });
  vi.spyOn(output, 'printTable').mockImplementation((opts) => {
    for (const row of opts.data) lines.push(`${row.key} | ${row.value}`);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(cwd, { recursive: true, force: true });
});

async function runGet(args: string[], flags: Record<string, unknown> = {}) {
  const ctx: CommandContext = { args, flags: { _: [], ...flags }, cwd, interactive: false };
  return getCommand?.action?.(ctx);
}

describe('`config get` renders object and array values readably (#478)', () => {
  it('pretty-prints an object-valued key as indented JSON', async () => {
    configManager.set(cwd, 'memory.backend', 'sqlite');
    const result = await runGet(['memory']);
    const text = lines.join('\n');

    expect(result?.success).toBe(true);
    expect(text).not.toContain('[object Object]');
    const memory = configManager.get(cwd, 'memory');
    expect(text).toBe(`memory = ${JSON.stringify(memory, null, 2)}`);
    expect(text).toContain('"backend": "sqlite"');
  });

  it('pretty-prints an array-valued key as JSON', async () => {
    configManager.set(cwd, 'agents.tags', [{ name: 'a' }, 'b']);
    await runGet(['agents.tags']);
    const text = lines.join('\n');

    expect(text).not.toContain('[object Object]');
    expect(text).toBe(`agents.tags = ${JSON.stringify([{ name: 'a' }, 'b'], null, 2)}`);
  });

  it('resolves a nested object via dot path', async () => {
    configManager.set(cwd, 'providers.demo', { model: 'x', opts: { retries: 2 } });
    await runGet(['providers.demo']);

    expect(lines.join('\n')).toBe(
      `providers.demo = ${JSON.stringify({ model: 'x', opts: { retries: 2 } }, null, 2)}`,
    );
  });

  it('prints scalars exactly as before', async () => {
    configManager.set(cwd, 'monoswarm.maxAgents', 20);
    await runGet(['monoswarm.maxAgents']);
    expect(lines).toEqual(['monoswarm.maxAgents = 20']);

    lines = [];
    configManager.set(cwd, 'memory.backend', 'sqlite');
    await runGet(['memory.backend']);
    expect(lines).toEqual(['memory.backend = sqlite']);
  });

  it('--format json emits valid JSON for an object value', async () => {
    await runGet(['memory'], { format: 'json' });
    const parsed = JSON.parse(lines.join('\n'));
    expect(parsed.key).toBe('memory');
    expect(parsed.value).toEqual(configManager.get(cwd, 'memory'));
  });

  it('the full-config table renders arrays of objects without [object Object]', async () => {
    configManager.set(cwd, 'agents.tags', [{ name: 'a' }]);
    await runGet([]);
    const text = lines.join('\n');

    expect(text).not.toContain('[object Object]');
    expect(text).toContain('agents.tags | [{"name":"a"}]');
  });
});
