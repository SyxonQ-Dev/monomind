/**
 * #520: `design detect <url>` ignored the positional target, because the
 * `--target` option's parser default `.` always won over `ctx.args[0]`.
 * The positional is now used when `-t/--target` is not given explicitly.
 */
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.fn((..._args: unknown[]) => {
  const child = new EventEmitter();
  setImmediate(() => child.emit('close', 0));
  return child;
});

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: (...args: unknown[]) => spawnMock(...args),
}));
vi.mock('@monoes/monobrowse', () => ({ findChrome: () => '/usr/bin/chrome' }));
vi.mock('../browser/managed-chrome.js', () => ({ ensureManagedChrome: vi.fn() }));
vi.mock('../output.js', () => {
  const id = (s: string) => s;
  return {
    output: {
      writeln: vi.fn(),
      bold: id,
      dim: id,
      warning: id,
      printError: vi.fn(),
      printList: vi.fn(),
    },
  };
});

import { designCommand } from '../commands/design-detect.js';
import { CommandParser } from '../parser.js';

function subcommand(name: string) {
  const cmd = designCommand.subcommands?.find((sc) => sc.name === name);
  if (!cmd?.action) throw new Error(`no ${name} subcommand`);
  return cmd;
}

/** Parses argv like the CLI does and returns the target forwarded to monodesign. */
async function forwardedTarget(argv: string[]): Promise<string> {
  const parser = new CommandParser({ allowUnknownFlags: true });
  parser.registerCommand(designCommand);
  const parsed = parser.parse(argv);
  await subcommand(argv[1]).action?.({
    args: parsed.positional,
    flags: parsed.flags,
    cwd: process.cwd(),
    interactive: false,
  });
  expect(spawnMock).toHaveBeenCalledTimes(1);
  const forwardArgs = spawnMock.mock.calls[0][1] as string[];
  expect(forwardArgs[1]).toBe(argv[1]);
  return forwardArgs[2];
}

beforeEach(() => {
  spawnMock.mockClear();
});

describe('design detect target (#520)', () => {
  it('uses a positional URL', async () => {
    expect(await forwardedTarget(['design', 'detect', 'https://example.com'])).toBe(
      'https://example.com',
    );
  });

  it('uses a positional path', async () => {
    expect(await forwardedTarget(['design', 'detect', './src'])).toBe('./src');
  });

  it('still honours -t and --target', async () => {
    expect(await forwardedTarget(['design', 'detect', '-t', 'https://example.com'])).toBe(
      'https://example.com',
    );
    spawnMock.mockClear();
    expect(await forwardedTarget(['design', 'detect', '--target', './src'])).toBe('./src');
  });

  it('defaults to the current directory', async () => {
    expect(await forwardedTarget(['design', 'detect'])).toBe('.');
  });

  it('design fix uses a positional path too', async () => {
    expect(await forwardedTarget(['design', 'fix', './src', '--dry-run'])).toBe('./src');
  });
});
