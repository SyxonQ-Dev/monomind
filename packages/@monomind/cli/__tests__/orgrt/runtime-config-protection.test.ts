/**
 * #580 review: `.agents/skills` was not the only project config a
 * non-Claude operator session loads and acts on. `.gemini/settings.json`
 * hooks and helpers, `.codex/config.toml` hooks, `.kimi-code` plugin hooks,
 * `.opencode/plugins` (and the node_modules OpenCode installs for them),
 * `.agents/monomind/hook-bridge.mjs`, … are the same class as `.claude/`: a
 * role that writes one gets code run in the operator's next session there.
 * They are protected the way `.claude/` is; instruction files are not.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  authorityMaskArgs,
  authorityMaskAvailability,
  ensureAuthorityDirs,
  maskedCommand,
} from '../../src/orgrt/authority-mask.js';
import { OrgBus } from '../../src/orgrt/bus.js';
import {
  ensureOperatorProtectedPaths,
  maskReadOnlyPaths,
  operatorProtectedPaths,
  PROJECT_RUNTIME_CONFIG,
} from '../../src/orgrt/operator-protected-paths.js';
import { PlantWatch, plantCandidates } from '../../src/orgrt/planted-paths.js';
import { PolicyEngine } from '../../src/orgrt/policy.js';

const scratch = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));
const write = (root: string, rel: string, content = 'x') => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
};

// A file a role could plant under (or as) each protected entry.
const PLANTS: Record<string, string> = {
  '.agents/skills': '.agents/skills/evil/SKILL.md',
  '.agents/monomind': '.agents/monomind/hook-bridge.mjs',
  '.gemini': '.gemini/settings.json',
  '.codex': '.codex/config.toml',
  '.kimi-code': '.kimi-code/plugin/hooks/monomind-gate.mjs',
  '.opencode': '.opencode/plugins/evil.ts',
  'opencode.json': 'opencode.json',
  'opencode.jsonc': 'opencode.jsonc',
  '.qwen': '.qwen/settings.json',
  'crush.json': 'crush.json',
  '.crush.json': '.crush.json',
  '.pi': '.pi/extensions/evil.ts',
  '.clinerules': '.clinerules/hooks/PreToolUse',
  '.aider.conf.yml': '.aider.conf.yml',
  '.cursor': '.cursor/mcp.json',
  '.vscode/mcp.json': '.vscode/mcp.json',
  '.kiro': '.kiro/mcp.json',
  '.factory': '.factory/mcp.json',
};

// Stays writable: instructions (like CLAUDE.md) and runtime state.
const WRITABLE = [
  'AGENTS.md',
  'GEMINI.md',
  'QWEN.md',
  '.agents/shared_instructions.md',
  '.agents/rules/monomind.md',
  '.crush/crush.db',
  '.vscode/settings.json',
];

let home: string;
beforeEach(() => {
  home = scratch('rcp-home-');
  vi.stubEnv('HOME', home);
  vi.stubEnv('MONOMIND_ORGRT_OPERATOR_DIR', scratch('rcp-op-'));
});
afterEach(() => vi.unstubAllEnvs());

describe('#580 review: other runtimes’ project config is operator-protected', () => {
  it('every entry has a plant case', () => {
    expect(Object.keys(PLANTS).sort()).toEqual([...PROJECT_RUNTIME_CONFIG].sort());
  });

  it('is in the protected list and the plant watch for the org root and the role cwd, and is not pre-created', () => {
    const base = scratch('rcp-list-');
    const root = join(base, 'root');
    const cwd = join(base, 'wt');
    mkdirSync(root);
    const ctx = { home, env: { HOME: home }, orgRoot: root, cwd };
    const paths = operatorProtectedPaths(ctx);
    const plant = plantCandidates(ctx);
    for (const p of PROJECT_RUNTIME_CONFIG) {
      for (const r of [root, cwd]) {
        expect(paths, p).toContain(join(r, p));
        expect(plant, p).toContain(join(r, p));
      }
    }
    ensureOperatorProtectedPaths({ home, env: { HOME: home }, orgRoot: root });
    for (const p of PROJECT_RUNTIME_CONFIG) expect(existsSync(join(root, p)), p).toBe(false);
  });

  it('is read-only in the mask once it exists', () => {
    const root = scratch('rcp-mask-');
    for (const f of Object.values(PLANTS)) write(root, f);
    const ro = maskReadOnlyPaths({ home, env: {}, orgRoot: root, cwd: root, homeDenyWrite: [] });
    for (const p of PROJECT_RUNTIME_CONFIG) expect(ro, p).toContain(join(root, p));
  });

  it('file tools refuse writing it, still read it, and allow instructions and runtime state', async () => {
    const root = scratch('rcp-policy-');
    for (const f of Object.values(PLANTS)) write(root, f);
    const p = new PolicyEngine('dev', {} as never, new OrgBus('o', 'r', scratch('rcp-bus-')), root, [root], root);
    for (const f of Object.values(PLANTS)) {
      expect((await p.decide('Write', { file_path: join(root, f), content: 'x' })).behavior, f).toBe('deny');
      expect((await p.decide('Read', { file_path: join(root, f) })).behavior, f).toBe('allow');
    }
    for (const f of WRITABLE)
      expect((await p.decide('Write', { file_path: join(root, f), content: 'x' })).behavior, f).toBe('allow');
  });

  it('a signed policy.sandbox.allowWrite entry is the opt-in', async () => {
    const root = scratch('rcp-optin-');
    const p = new PolicyEngine(
      'dev',
      { sandbox: { allowWrite: ['.gemini'] } } as never,
      new OrgBus('o', 'r', scratch('rcp-bus-')),
      root,
      [root],
      root,
    );
    expect((await p.decide('Write', { file_path: join(root, '.gemini/settings.json'), content: 'x' })).behavior).toBe('allow');
    expect((await p.decide('Write', { file_path: join(root, '.codex/config.toml'), content: 'x' })).behavior).toBe('deny');
  });

  it('one a role creates while it is missing is quarantined', async () => {
    const root = scratch('rcp-plant-');
    const op = scratch('rcp-plant-op-');
    new PlantWatch(root, 'o', () => {}, op).add({ home, env: {}, orgRoot: root, cwd: root });
    write(root, '.codex/config.toml', '[[hooks.SessionStart]]\n');
    write(root, '.agents/monomind/hook-bridge.mjs', 'evil()');
    write(root, 'AGENTS.md', '# notes');
    const found = await new PlantWatch(root, 'o', () => {}, op).check();
    expect(found.map((f) => f.path).sort()).toEqual([join(root, '.agents', 'monomind'), join(root, '.codex')].sort());
    expect(existsSync(join(root, '.codex'))).toBe(false);
    expect(existsSync(join(root, 'AGENTS.md'))).toBe(true);
  });

  it.runIf(authorityMaskAvailability().available)('inside the real bubblewrap mask the existing ones are read-only', () => {
    const root = scratch('rcp-mroot-');
    const env = {} as NodeJS.ProcessEnv;
    ensureAuthorityDirs(home, env);
    for (const f of ['.gemini/settings.json', '.codex/config.toml', 'opencode.json', '.agents/monomind/hook-bridge.mjs'])
      write(root, f, 'orig');
    ensureOperatorProtectedPaths({ home, env, orgRoot: root });
    const [cmd, argv] = maskedCommand(authorityMaskArgs({ home, env, roots: [root], orgRoot: root, cwd: root }), 'bash', [
      '-c',
      [
        `echo evil > ${root}/.gemini/settings.json`,
        `echo evil > ${root}/.codex/config.toml`,
        `echo evil > ${root}/opencode.json`,
        `echo evil > ${root}/.agents/monomind/hook-bridge.mjs`,
        `mv ${root}/.agents ${root}/.agents-aside`,
        `echo ok > ${root}/AGENTS.md`,
        'true',
      ].join('; '),
    ]);
    spawnSync(cmd, argv, { encoding: 'utf8' });
    for (const f of ['.gemini/settings.json', '.codex/config.toml', 'opencode.json', '.agents/monomind/hook-bridge.mjs'])
      expect(spawnSync('cat', [join(root, f)], { encoding: 'utf8' }).stdout, f).toBe('orig');
    expect(existsSync(join(root, '.agents-aside'))).toBe(false);
    expect(existsSync(join(root, 'AGENTS.md'))).toBe(true);
  });
});
