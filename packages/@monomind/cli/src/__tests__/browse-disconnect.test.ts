/**
 * `monomind browse …` must drop its CDP connection once the subcommand is done
 * (#408).
 *
 * bin/cli.js lets the event loop drain instead of calling process.exit()
 * (ADR-R001), so the CDP websocket a browse subcommand opened held every
 * `monomind browse get title` open until the 5 s FORCE_EXIT_MS watchdog
 * (5.3 s vs 0.3 s through the bare `monobrowse` bin, which does exit). The
 * wrapper in commands/browse.ts disconnects after the action settles — the
 * connection only, never the browser the next command reuses.
 */

import { describe, expect, it, vi } from 'vitest';

const events: string[] = [];
const disconnectSession = vi.fn(() => events.push('disconnect'));

vi.mock('@monoes/monobrowse/cli/commands', () => ({
  disconnectSession,
  default: {
    name: 'browse',
    description: 'base',
    subcommands: [
      {
        name: 'get',
        description: 'get',
        subcommands: [
          {
            name: 'title',
            description: 'title',
            action: async () => {
              events.push('action');
              return { success: true };
            },
          },
        ],
      },
      {
        name: 'eval',
        description: 'eval',
        action: async () => {
          events.push('action');
          throw new Error('boom');
        },
      },
    ],
  },
}));

async function sub(...path: string[]) {
  const { default: browse } = await import('../commands/browse.js');
  let cmd = browse;
  for (const name of path) {
    const next = cmd.subcommands?.find((s) => s.name === name);
    expect(next, `browse ${path.join(' ')}`).toBeDefined();
    cmd = next!;
  }
  return cmd;
}

const ctx = { args: [], flags: { _: [] }, cwd: process.cwd(), interactive: false };

describe('monomind browse disconnects CDP after a subcommand (#408)', () => {
  it('a nested subcommand resolves, then the connection is dropped', async () => {
    events.length = 0;
    const title = await sub('get', 'title');
    await expect(title.action!(ctx)).resolves.toEqual({ success: true });
    expect(events).toEqual(['action', 'disconnect']);
  });

  it('a subcommand that throws still drops the connection and rethrows', async () => {
    events.length = 0;
    const evalCmd = await sub('eval');
    await expect(evalCmd.action!(ctx)).rejects.toThrow('boom');
    expect(events).toEqual(['action', 'disconnect']);
  });

  it('keeps the Monomind-owned workflow/action/platform subcommands', async () => {
    for (const name of ['workflow', 'action', 'platform']) await sub(name);
  });
});
