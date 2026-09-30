/**
 * #420: init's doctor pass installs the Claude Code CLI only when Claude Code
 * is selected, the CLI is missing, someone is at a terminal, and they say
 * yes. Everywhere else it prints the install command. A claude binary in
 * ~/.local/bin or ~/.claude/local counts as installed.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  claude: 'warn' as 'pass' | 'warn',
  answer: false,
  confirms: 0,
  doctorFlags: [] as Record<string, unknown>[],
  info: [] as string[],
}));

vi.mock('../commands/doctor.js', () => ({
  doctorCommand: {
    action: vi.fn(async (ctx: { flags: Record<string, unknown> }) => {
      state.doctorFlags.push(ctx.flags);
      return { success: true, data: { passed: 1, warnings: 0, failed: 0 } };
    }),
  },
}));
vi.mock('../commands/doctor-env-checks.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../commands/doctor-env-checks.js')>()),
  checkClaudeCode: vi.fn(async () => ({ name: 'Claude Code CLI', status: state.claude })),
}));
vi.mock('../prompt.js', () => ({
  confirm: vi.fn(async () => {
    state.confirms++;
    return state.answer;
  }),
}));

const { runDoctorFix } = await import('../init/init-post-steps.js');
const { output } = await import('../output.js');

const result = () =>
  ({ created: { directories: [], files: [] }, updated: [], skipped: [] }) as never;

describe('runDoctorFix Claude Code install gate (#420)', () => {
  const tty = { in: process.stdin.isTTY, out: process.stdout.isTTY, ci: process.env.CI };
  const setTty = (on: boolean) => {
    Object.defineProperty(process.stdin, 'isTTY', { value: on, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: on, configurable: true });
  };

  beforeEach(() => {
    Object.assign(state, { claude: 'warn', answer: false, confirms: 0, doctorFlags: [], info: [] });
    vi.spyOn(output, 'printInfo').mockImplementation((line: string) => {
      state.info.push(line);
    });
    delete process.env.CI;
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', { value: tty.in, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: tty.out, configurable: true });
    if (tty.ci === undefined) delete process.env.CI;
    else process.env.CI = tty.ci;
    vi.restoreAllMocks();
  });

  it('non-interactive: never installs, never asks, prints the command', async () => {
    setTty(false);
    await runDoctorFix('/x', result(), true, true);
    expect(state.confirms).toBe(0);
    expect(state.doctorFlags[0].install).toBe(false);
    expect(state.info.join('\n')).toContain('npm install -g @anthropic-ai/claude-code');
  });

  it('interactive: asks, and installs only on yes', async () => {
    setTty(true);
    state.answer = true;
    await runDoctorFix('/x', result(), true, true);
    expect(state.confirms).toBe(1);
    expect(state.doctorFlags[0].install).toBe(true);

    state.answer = false;
    await runDoctorFix('/x', result(), true, true);
    expect(state.doctorFlags[1].install).toBe(false);
  });

  it('does not ask when Claude Code is not selected, already installed, or --no-install', async () => {
    setTty(true);
    await runDoctorFix('/x', result(), true, false);
    state.claude = 'pass';
    await runDoctorFix('/x', result(), true, true);
    state.claude = 'warn';
    await runDoctorFix('/x', result(), false, true);
    expect(state.confirms).toBe(0);
    expect(state.doctorFlags.map((f) => f.install)).toEqual([false, false, false]);
  });

  it('CI=true counts as non-interactive even on a TTY', async () => {
    setTty(true);
    process.env.CI = 'true';
    await runDoctorFix('/x', result(), true, true);
    expect(state.confirms).toBe(0);
    expect(state.doctorFlags[0].install).toBe(false);
  });
});

describe('checkClaudeCode finds a claude outside PATH (#420)', () => {
  const saved = { HOME: process.env.HOME, PATH: process.env.PATH };
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'mm420c-'));
    process.env.HOME = home;
    process.env.PATH = path.join(home, 'empty-bin');
  });

  afterEach(() => {
    process.env.HOME = saved.HOME;
    process.env.PATH = saved.PATH;
    fs.rmSync(home, { recursive: true, force: true });
  });

  const check = async () => {
    const real = await vi.importActual<typeof import('../commands/doctor-env-checks.js')>(
      '../commands/doctor-env-checks.js',
    );
    return real.checkClaudeCode();
  };

  it.each([
    ['.local', 'bin'],
    ['.claude', 'local'],
  ])('treats ~/%s/%s/claude as installed', async (a, b) => {
    fs.mkdirSync(path.join(home, a, b), { recursive: true });
    fs.writeFileSync(path.join(home, a, b, 'claude'), '#!/bin/sh\n', { mode: 0o755 });
    const r = await check();
    expect(r.status).toBe('pass');
    expect(r.message).toContain(path.join(home, a, b, 'claude'));
  });

  it('reports it missing otherwise', async () => {
    expect((await check()).status).toBe('warn');
  });
});
