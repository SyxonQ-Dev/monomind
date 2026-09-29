/**
 * #418: monoswarm and autopilot record state but start nothing. Their output
 * must say so — no hard-coded "5%" progress for a swarm with zero tasks, no
 * "running" status for a state file with no agents, no "Deploy N agents"
 * plan, and autopilot flagged as deprecated with no real task source.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { autopilotCommand } from '../commands/autopilot.js';
import { monoswarmCommand } from '../commands/monoswarm.js';
import { monoswarmTools } from '../mcp-tools/monoswarm-tools.js';
import { output } from '../output.js';
import type { CommandContext } from '../types.js';

function sub(cmd: typeof monoswarmCommand, name: string) {
  const found = cmd.subcommands?.find((c) => c.name === name);
  if (!found) throw new Error(`subcommand ${name} not found`);
  return found;
}

const ctx = (overrides: Partial<CommandContext> = {}): CommandContext => ({
  args: [],
  flags: { _: [] },
  cwd: process.cwd(),
  interactive: false,
  ...overrides,
});

/** Capture everything the command prints through `output`. */
function capture(): () => string {
  const lines: string[] = [];
  const push = (...a: unknown[]) => {
    lines.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
  };
  for (const fn of [
    'writeln',
    'printInfo',
    'printSuccess',
    'printWarning',
    'printError',
    'printTable',
    'printList',
  ] as const) {
    vi.spyOn(output, fn).mockImplementation(push as never);
  }
  return () => lines.join('\n');
}

let tmpCwd: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'monoswarm-honest-'));
  process.chdir(tmpCwd);
  process.env.MONOMIND_CWD = tmpCwd;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.chdir(originalCwd);
  delete process.env.MONOMIND_CWD;
  fs.rmSync(tmpCwd, { recursive: true, force: true });
});

describe('monoswarm reports recorded state honestly (#418)', () => {
  it('monoswarm_init records status "initialized", not "running"', async () => {
    const init = monoswarmTools.find((t) => t.name === 'monoswarm_init');
    await init?.handler({ topology: 'mesh' });
    const state = JSON.parse(
      fs.readFileSync(path.join(tmpCwd, '.monomind', 'monoswarm', 'state.json'), 'utf-8'),
    );
    expect(state.status).toBe('initialized');
    expect(state.agents).toEqual([]);
  });

  it('status with zero tasks shows no fake progress and does not claim to be running', async () => {
    const init = monoswarmTools.find((t) => t.name === 'monoswarm_init');
    await init?.handler({ topology: 'mesh' });
    const printed = capture();

    const result = await sub(monoswarmCommand, 'status').action?.(ctx());
    const data = result?.data as { progress: number; status: string };

    expect(data.progress).toBe(0);
    expect(data.status).not.toBe('running');
    expect(data.status).toMatch(/recorded/);
    expect(printed()).not.toMatch(/5%/);
    expect(printed()).toMatch(/n\/a/);
    expect(printed()).toMatch(/no agents started/i);
  });

  it('start does not present its plan as a deployment', async () => {
    const printed = capture();
    vi.spyOn(output, 'createSpinner').mockReturnValue({
      start: vi.fn(),
      succeed: vi.fn(),
      fail: vi.fn(),
      stop: vi.fn(),
    } as never);

    await sub(monoswarmCommand, 'start').action?.(ctx({ flags: { _: [], objective: 'x' } }));

    expect(printed()).not.toMatch(/Deployment Plan/);
    expect(printed()).toMatch(/no agents are started/i);
  });

  it('is marked deprecated in help', () => {
    expect(monoswarmCommand.description).toMatch(/deprecated/i);
  });
});

describe('autopilot is flagged deprecated with no task source (#418)', () => {
  it('help text says deprecated', () => {
    expect(autopilotCommand.description).toMatch(/deprecated/i);
  });

  it('status prints the deprecation and that no task source was found', async () => {
    // team-tasks reads ~/.claude/tasks — point HOME at the empty temp dir.
    vi.stubEnv('HOME', tmpCwd);
    const printed = capture();
    const status = autopilotCommand.subcommands?.find((c) => c.name === 'status');
    await status?.action?.(ctx({ flags: { _: [] } }));
    expect(printed()).toMatch(/deprecated/i);
    expect(printed()).toMatch(/no task source/i);
  });
});
