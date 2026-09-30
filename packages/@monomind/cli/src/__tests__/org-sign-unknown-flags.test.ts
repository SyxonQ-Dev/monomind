// `monomind org sign` fails closed on an option it does not know: an older
// build silently ignored `--expect-hash` and signed with exit 0. The CLI
// parser allows unknown flags globally; `org sign` checks its own.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../prompt.js', () => ({
  confirm: async () => {
    throw new Error('must not prompt');
  },
}));

import { signAction, signSubcommand } from '../commands/org-sign.js';
import { AGENT_CONTEXT_ENV_MARKERS } from '../orgrt/agent-context.js';
import { computeOrgDefHash, setOrgSignatureEnforcement } from '../orgrt/org-signature.js';
import { ORG_DIR } from '../orgrt/types.js';
import { CommandParser } from '../parser.js';
import type { CommandContext } from '../types.js';

let root: string;
let opDir: string;
let temps: string[] = [];
const tempDir = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
};
beforeEach(() => {
  setOrgSignatureEnforcement(true);
  for (const k of AGENT_CONTEXT_ENV_MARKERS) vi.stubEnv(k, undefined);
  vi.stubEnv('HOME', tempDir('osu-home-cap-'));
  opDir = join(tempDir('osu-op-cap-'), 'operator');
  vi.stubEnv('MONOMIND_ORGRT_OPERATOR_DIR', opDir);
  root = tempDir('osu-root-cap-');
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  setOrgSignatureEnforcement(false);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const d of temps) rmSync(d, { recursive: true, force: true });
  temps = [];
});

const ORG = '{"name":"fx","roles":[{"id":"boss","type":"boss","reports_to":null}]}';
function writeOrg(name = 'fx'): void {
  mkdirSync(join(root, ORG_DIR), { recursive: true });
  writeFileSync(join(root, ORG_DIR, `${name}.json`), ORG.replace('"fx"', `"${name}"`));
}
const hashOf = (name = 'fx') =>
  computeOrgDefHash(JSON.parse(ORG.replace('"fx"', `"${name}"`)), root);
const opFiles = (): string[] =>
  (existsSync(opDir) ? readdirSync(opDir, { recursive: true }) : []).map(String);
const lines = () =>
  (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));

/** Parse argv the way the CLI does (unknown flags allowed globally), then
 *  run `org sign` with the result — so camelCase/kebab mirrors, global
 *  defaults and short aliases are all present, as in a real invocation. */
async function run(argv: string[], cwd = root) {
  const parser = new CommandParser({ allowUnknownFlags: true });
  parser.registerCommand({ name: 'org', description: 'org', subcommands: [signSubcommand] });
  const parsed = parser.parse(['org', 'sign', ...argv]);
  expect(parser.validateFlags(parsed.flags, signSubcommand)).toEqual([]);
  const ctx = { args: parsed.positional, flags: parsed.flags, cwd, interactive: false };
  return signAction(ctx as CommandContext);
}

describe('org sign: unknown options', () => {
  it.each([
    [['fx', '--yes', '--expect-hsh', 'a'.repeat(64)], '--expect-hsh'],
    [['fx', '--yes', '--bogus'], '--bogus'],
    [['fx', '--yes', '--no-expect-hash'], '--no-expect-hash'],
    [['fx', '-y', '-z'], '--z'],
    [['--all', '--yes', '--forceSign'], '--force-sign'],
  ])('%j exits 2, names the option and writes nothing', async (argv, shown) => {
    writeOrg();
    const r = await run(argv);
    expect(r).toMatchObject({ success: false, exitCode: 2 });
    expect(r?.message).toContain(shown);
    expect(r?.message).toContain('nothing signed');
    expect(lines().join('\n')).toContain(shown);
    expect(opFiles()).toEqual([]);
  });

  it('names each unknown option once, whatever spelling the parser mirrors', async () => {
    writeOrg();
    const r = await run(['fx', '--yes', '--expect-hsh', 'x', '--foo-bar']);
    expect(r?.message).toMatch(/unknown options --expect-hsh, --foo-bar /);
  });

  it('is refused before --check and before the role-context refusal', async () => {
    writeOrg();
    expect(await run(['fx', '--check', '--bogus'])).toMatchObject({ exitCode: 2 });
    vi.stubEnv(AGENT_CONTEXT_ENV_MARKERS[0], '1');
    const r = await run(['fx', '--yes', '--bogus']);
    expect(r).toMatchObject({ exitCode: 2 });
    expect(opFiles()).toEqual([]);
  });

  it('checks direct callers too (flags passed without the parser)', async () => {
    writeOrg();
    const r = await signAction({
      args: ['fx'],
      flags: { _: [], yes: true, expectHsh: 'x' },
      cwd: root,
      interactive: false,
    } as CommandContext);
    expect(r).toMatchObject({ success: false, exitCode: 2 });
    expect(opFiles()).toEqual([]);
  });
});

describe('org sign: every known option still works', () => {
  it('--check, --format json, --project (and global flags)', async () => {
    writeOrg();
    const elsewhere = tempDir('osu-cwd-cap-');
    const r = await run(
      ['fx', '--check', '--format', 'json', '--project', root, '--no-color', '--quiet', '-v'],
      elsewhere,
    );
    expect(r?.exitCode).toBe(1); // unsigned
    expect(JSON.parse(lines().at(-1) as string).orgs[0]).toMatchObject({
      org: 'fx',
      state: 'unsigned',
      hash: hashOf(),
    });
    expect(opFiles()).toEqual([]);
  });

  it('--format json without --yes: the review as JSON', async () => {
    writeOrg();
    const r = await run(['fx', '--format', 'json']);
    expect(r?.success).toBe(true);
    expect(JSON.parse(lines().at(-1) as string)).toMatchObject({ org: 'fx', hash: hashOf() });
    expect(opFiles()).toEqual([]);
  });

  it('--yes and --expect-hash sign one org', async () => {
    writeOrg();
    const r = await run(['fx', '--yes', '--expect-hash', hashOf()]);
    expect(r?.success).toBe(true);
    expect(opFiles().length).toBeGreaterThan(0);
  });

  it('-y with --all and --expect-hash <org>=<hex> for each org', async () => {
    writeOrg('fx');
    writeOrg('gx');
    const r = await run([
      '--all',
      '-y',
      '--expect-hash',
      `fx=${hashOf('fx')}`,
      '--expect-hash',
      `gx=${hashOf('gx')}`,
    ]);
    expect(r?.success).toBe(true);
  });

  it('declares exactly the options it accepts', () => {
    expect(signSubcommand.options?.map((o) => o.name).sort()).toEqual([
      'all',
      'check',
      'expect-hash',
      'project',
      'yes',
    ]);
  });
});
