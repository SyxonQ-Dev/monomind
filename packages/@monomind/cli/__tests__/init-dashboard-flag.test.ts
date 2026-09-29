/**
 * #423: the SessionStart hook starts the dashboard only when the project opted
 * in. `monomind init --dashboard` records that opt-in in
 * `.monomind/dashboard.json`; a plain `init` leaves it off.
 */

import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initCommand } from '../src/commands/init.js';
import { output } from '../src/output.js';
import type { CommandContext } from '../src/types.js';

output.setVerbosity('quiet');

vi.mock('child_process', () => ({
  execSync: vi.fn(() => {
    throw new Error('mocked: no real process execution in tests');
  }),
  execFileSync: vi.fn(() => {
    throw new Error('mocked: no real process execution in tests');
  }),
  exec: vi.fn(() => {
    throw new Error('mocked: no real process execution in tests');
  }),
  execFile: vi.fn(() => {
    throw new Error('mocked: no real process execution in tests');
  }),
  spawn: vi.fn(() => {
    const proc = new EventEmitter() as EventEmitter & { unref: () => void; kill: () => void };
    proc.unref = () => {};
    proc.kill = () => {};
    return proc;
  }),
}));

describe('init --dashboard (#423)', () => {
  let tmpDir: string;
  let fakeHome: string;
  let realHome: string | undefined;
  let ctx: CommandContext;
  const dashboardConf = () => path.join(tmpDir, '.monomind', 'dashboard.json');

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'monomind-init-dashboard-'));
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'monomind-init-dashboard-home-'));
    realHome = process.env.HOME;
    process.env.HOME = fakeHome;
    ctx = {
      args: [],
      flags: {
        _: [],
        yes: true,
        'no-watch': true,
        'no-start-all': true,
        'no-install': true,
        memory: false,
      },
      cwd: tmpDir,
      interactive: false,
    };
  });

  afterEach(() => {
    process.env.HOME = realHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  it('does not opt in to dashboard auto-start by default', async () => {
    expect((await initCommand.action!(ctx)).success).toBe(true);
    expect(fs.existsSync(dashboardConf())).toBe(false);
  }, 60000);

  it('writes {"autostart": true} with --dashboard', async () => {
    ctx.flags = { ...ctx.flags, dashboard: true };
    expect((await initCommand.action!(ctx)).success).toBe(true);
    expect(JSON.parse(fs.readFileSync(dashboardConf(), 'utf-8'))).toEqual({ autostart: true });
  }, 60000);

  it('parses --dashboard from the command line', async () => {
    const { CommandParser } = await import('../src/parser.js');
    const parser = new CommandParser();
    parser.registerCommand(initCommand);
    expect(parser.parse(['init', '--dashboard']).flags.dashboard).toBe(true);
  });
});
