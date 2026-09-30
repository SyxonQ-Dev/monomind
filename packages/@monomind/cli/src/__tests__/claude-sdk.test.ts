/**
 * #522: the Claude runtime runs an installed Claude Code when one is usable,
 * instead of the 300 MB copy bundled with the SDK.
 */
import type { Stats } from 'node:fs';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeAgentRunner } from '../orgrt/agent-runner-claude.js';
import {
  CLAUDE_PATH_ENV,
  type ClaudeProbe,
  claudeCandidates,
  compatibleClaudeVersion,
  defaultClaudeProbe,
  findInstalledClaude,
  SDK_BUNDLED_CLAUDE_VERSION,
  sdkLoadOptions,
} from '../orgrt/claude-sdk.js';
import { OPTIONAL_DEPENDENCIES } from '../utils/optional-deps.js';

const HOME = '/home/op';
const ME = 1000;

interface Node {
  uid: number;
  mode: number;
  file?: boolean;
  exec?: boolean;
  /** Real path, when this is a symlink. */
  to?: string;
  version?: string;
}

/** A probe over an in-memory file system. Directories not listed are
 *  root-owned 0755; files must be listed. */
function fakeProbe(nodes: Record<string, Node>, env: NodeJS.ProcessEnv = {}) {
  const version = vi.fn(async (f: string) => {
    const v = nodes[f]?.version;
    if (!v) throw new Error('no version');
    return `${v} (Claude Code)\n`;
  });
  const log = vi.fn();
  const probe: ClaudeProbe = {
    env: { PATH: '/usr/local/bin:/usr/bin', ...env },
    home: HOME,
    platform: 'linux',
    uid: ME,
    realpath: (p) => {
      const n = nodes[p];
      if (n?.to) return n.to;
      if (n) return p;
      throw Object.assign(new Error(`ENOENT ${p}`), { code: 'ENOENT' });
    },
    stat: (p) => {
      const n = nodes[p] ?? { uid: p.startsWith(HOME) ? ME : 0, mode: 0o755 };
      return { uid: n.uid, mode: n.mode, isFile: () => !!n.file } as unknown as Stats;
    },
    isExecutable: (p) => nodes[p]?.exec !== false,
    version,
    log,
  };
  return { probe, version, log };
}

const rootBin = (v = '2.1.283'): Node => ({ uid: 0, mode: 0o755, file: true, version: v });
const userBin = (v = '2.1.283'): Node => ({ uid: ME, mode: 0o755, file: true, version: v });

describe('claudeCandidates', () => {
  it('looks at PATH, then ~/.local/bin, then ~/.claude/local, skipping relative PATH entries', () => {
    expect(
      claudeCandidates({ PATH: `/usr/bin:bin::/opt/c/bin:/usr/bin` }, HOME, 'linux').map(
        (c) => c.path,
      ),
    ).toEqual([
      '/usr/bin/claude',
      '/opt/c/bin/claude',
      `${HOME}/.local/bin/claude`,
      `${HOME}/.claude/local/claude`,
    ]);
  });

  it(`${CLAUDE_PATH_ENV} is the only candidate when set, and "bundled" turns detection off`, () => {
    expect(
      claudeCandidates({ PATH: '/usr/bin', [CLAUDE_PATH_ENV]: '/x/claude' }, HOME, 'linux'),
    ).toEqual([{ path: '/x/claude', explicit: true }]);
    expect(
      claudeCandidates({ PATH: '/usr/bin', [CLAUDE_PATH_ENV]: 'bundled' }, HOME, 'linux'),
    ).toEqual([]);
  });

  it('looks for claude.exe on Windows', () => {
    expect(claudeCandidates({ PATH: 'C:\\bin' }, 'C:\\Users\\op', 'win32')[0].path).toMatch(
      /claude\.exe$/,
    );
  });
});

describe('compatibleClaudeVersion', () => {
  it.each([
    ['2.1.226 (Claude Code)', true],
    ['2.1.283 (Claude Code)', true],
    ['2.2.0', true],
    ['2.1.225 (Claude Code)', false],
    ['2.0.999', false],
    ['1.9.0', false],
    ['3.0.0', false],
    ['claude', false],
  ])('%s -> %s', (out, ok) => {
    expect(compatibleClaudeVersion(out).ok).toBe(ok);
  });

  it('SDK_BUNDLED_CLAUDE_VERSION is what the pinned SDK bundles', () => {
    const require = createRequire(import.meta.url);
    const entry = require.resolve('@anthropic-ai/claude-agent-sdk');
    const dir = dirname(entry);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    expect(pkg.version).toBe(OPTIONAL_DEPENDENCIES['@anthropic-ai/claude-agent-sdk'].version);
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    expect(manifest.version).toBe(SDK_BUNDLED_CLAUDE_VERSION);
  });
});

describe('findInstalledClaude', () => {
  it('uses the first system-installed candidate, resolved to its real path', async () => {
    const { probe, version } = fakeProbe({
      '/usr/bin/claude': { uid: 0, mode: 0o777, to: '/usr/lib/claude/bin/claude' },
      '/usr/lib/claude/bin/claude': rootBin(),
      [`${HOME}/.local/bin/claude`]: rootBin(),
    });
    expect(await findInstalledClaude(probe)).toEqual({
      path: '/usr/lib/claude/bin/claude',
      skipped: [],
    });
    expect(version).toHaveBeenCalledExactlyOnceWith('/usr/lib/claude/bin/claude');
  });

  it('refuses a binary this user owns (role-writable) without running it, and goes on', async () => {
    const { probe, version } = fakeProbe({
      '/usr/local/bin/claude': { uid: ME, mode: 0o777, to: `${HOME}/.local/share/claude/2.1.283` },
      [`${HOME}/.local/share/claude/2.1.283`]: userBin(),
      '/usr/bin/claude': rootBin(),
    });
    const r = await findInstalledClaude(probe);
    expect(r.path).toBe('/usr/bin/claude');
    expect(r.skipped).toEqual([
      `/usr/local/bin/claude: ${HOME}/.local/share/claude/2.1.283 is owned by uid ${ME}, not root, so org roles may write it`,
    ]);
    expect(version).toHaveBeenCalledExactlyOnceWith('/usr/bin/claude');
  });

  it('refuses a root-owned binary under a directory this user owns', async () => {
    const { probe } = fakeProbe({ [`${HOME}/.local/bin/claude`]: rootBin() }, { PATH: '' });
    const r = await findInstalledClaude(probe);
    expect(r.path).toBeUndefined();
    expect(r.skipped[0]).toContain(`${HOME}/.local/bin is owned by uid ${ME}`);
  });

  it('refuses a binary under a group- or other-writable directory', async () => {
    const { probe } = fakeProbe(
      {
        '/opt/shared': { uid: 0, mode: 0o775 },
        '/opt/shared/claude': rootBin(),
      },
      { PATH: '/opt/shared' },
    );
    const r = await findInstalledClaude(probe);
    expect(r.path).toBeUndefined();
    expect(r.skipped[0]).toContain('/opt/shared is writable by group or others');
  });

  it('refuses a version older than the bundled one or of another major, and goes on', async () => {
    const { probe } = fakeProbe({
      '/usr/local/bin/claude': rootBin('2.1.100'),
      '/usr/bin/claude': rootBin('2.1.226'),
    });
    const r = await findInstalledClaude(probe);
    expect(r.path).toBe('/usr/bin/claude');
    expect(r.skipped[0]).toMatch(
      /is Claude Code 2\.1\.100, and the Claude runtime needs 2\.x, 2\.1\.226 or newer/,
    );
    const other = fakeProbe({ '/usr/bin/claude': rootBin('3.0.0') });
    expect((await findInstalledClaude(other.probe)).path).toBeUndefined();
  });

  it('falls back to the bundled binary when nothing is installed', async () => {
    const { probe, version } = fakeProbe({});
    expect(await findInstalledClaude(probe)).toEqual({ skipped: [] });
    expect(version).not.toHaveBeenCalled();
  });

  it('cannot vouch for any found binary without file ownership (Windows)', async () => {
    const { probe } = fakeProbe({ '/usr/bin/claude': rootBin() });
    probe.uid = undefined;
    expect((await findInstalledClaude(probe)).path).toBeUndefined();
  });

  it(`accepts ${CLAUDE_PATH_ENV} in a directory this user owns (the operator's choice)`, async () => {
    const { probe } = fakeProbe(
      {
        [`${HOME}/bin/claude`]: { uid: ME, mode: 0o755, to: `${HOME}/.local/share/claude/v` },
        [`${HOME}/.local/share/claude/v`]: userBin(),
      },
      { [CLAUDE_PATH_ENV]: `${HOME}/bin/claude` },
    );
    expect((await findInstalledClaude(probe)).path).toBe(`${HOME}/.local/share/claude/v`);
  });

  it(`reports a refused ${CLAUDE_PATH_ENV} and does not substitute another binary`, async () => {
    for (const [nodes, why] of [
      [{ '/x/claude': { ...userBin(), mode: 0o775 } }, /is writable by group or others/],
      [{ '/x/claude': { ...userBin(), uid: 4242 } }, /owned by uid 4242, not by this user or root/],
      [{ '/x/claude': { ...userBin(), exec: false } }, /is not executable/],
      [{ '/x/claude': userBin('2.0.1') }, /is Claude Code 2\.0\.1/],
      [{}, /it does not exist/],
    ] as const) {
      const { probe, log } = fakeProbe(
        { ...nodes, '/usr/bin/claude': rootBin() },
        { [CLAUDE_PATH_ENV]: '/x/claude' },
      );
      expect((await findInstalledClaude(probe)).path).toBeUndefined();
      expect(log.mock.calls[0][0]).toMatch(why);
      expect(log.mock.calls[0][0]).toMatch(/Using the Claude Agent SDK's bundled Claude Code/);
    }
    const rel = fakeProbe({}, { [CLAUDE_PATH_ENV]: 'claude' });
    expect((await findInstalledClaude(rel.probe)).path).toBeUndefined();
    expect(rel.log.mock.calls[0][0]).toMatch(/not an absolute path/);
  });
});

describe('sdkLoadOptions', () => {
  it('skips the platform package when a binary was found', () => {
    expect(sdkLoadOptions({ path: '/usr/bin/claude', skipped: [] })).toEqual({
      withoutSdkBinary: true,
    });
    expect(sdkLoadOptions({ skipped: [] })).toEqual({});
  });

  it('tells the operator how to use a refused binary', () => {
    const { note } = sdkLoadOptions({ skipped: ['/home/op/.local/bin/claude: owned by uid 1000'] });
    expect(note).toContain('/home/op/.local/bin/claude: owned by uid 1000');
    expect(note).toContain(CLAUDE_PATH_ENV);
  });
});

describe('with a real binary', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  const script = (version: string): string => {
    dir = mkdtempSync(join(tmpdir(), 'mm-claude-'));
    const file = join(dir, 'claude-real');
    writeFileSync(file, `#!/bin/sh\necho '${version} (Claude Code)'\n`);
    chmodSync(file, 0o755);
    symlinkSync(file, join(dir, 'claude'));
    return join(dir, 'claude');
  };

  it.skipIf(process.platform === 'win32')(
    'runs `--version` and returns the real path',
    async () => {
      const link = script('2.1.300');
      const found = await findInstalledClaude(
        defaultClaudeProbe({ PATH: '', [CLAUDE_PATH_ENV]: link }),
      );
      expect(found.path).toBe(realpathSync(join(dirname(link), 'claude-real')));
    },
  );

  it.skipIf(process.platform === 'win32')('falls back when the version is too old', async () => {
    const link = script('2.1.1');
    const probe = { ...defaultClaudeProbe({ PATH: '', [CLAUDE_PATH_ENV]: link }), log: vi.fn() };
    expect((await findInstalledClaude(probe)).path).toBeUndefined();
    expect(probe.log).toHaveBeenCalledOnce();
  });
});

describe('ClaudeAgentRunner', () => {
  const run = async (executable?: string) => {
    const query = vi.fn((_: { options: Record<string, unknown> }) =>
      (async function* () {
        yield { type: 'result', session_id: 's', subtype: 'success', is_error: false };
      })(),
    );
    const runner = new ClaudeAgentRunner(undefined, async () => ({
      query: query as never,
      tool: (() => ({})) as never,
      createSdkMcpServer: (() => ({})) as never,
      ...(executable ? { executable } : {}),
    }));
    const args = {
      prompt: 'hi',
      systemPrompt: '',
      tools: [],
      cwd: '/',
      model: 'haiku',
      maxTurns: 1,
    };
    for await (const _ of runner.run(args as never)) {
      // drain
    }
    return query.mock.calls[0][0].options;
  };

  it('passes the installed Claude Code to query() as pathToClaudeCodeExecutable', async () => {
    expect((await run('/usr/bin/claude')).pathToClaudeCodeExecutable).toBe('/usr/bin/claude');
  });

  it('leaves the option out when the bundled binary is used', async () => {
    expect(await run()).not.toHaveProperty('pathToClaudeCodeExecutable');
  });
});
