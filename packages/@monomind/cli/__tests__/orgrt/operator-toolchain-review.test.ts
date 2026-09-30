// packages/@monomind/cli/__tests__/orgrt/operator-toolchain-review.test.ts
/**
 * #527 security review: writable PATH directories and symlinked PATH
 * entries (fnm), pnpm's home as a whole with the role's store moved out,
 * RUSTUP_HOME and the XDG base directories (B1); mise's trust store and
 * direnv's allow list (B2); a protected tree inside the org root that must
 * not be renamed aside (M1); directories created up front so the operator's
 * own installs never look planted (M2); toolchain config files (M3). Every
 * path is under a temp dir: no real toolchain or home is touched.
 */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  authorityMaskArgs,
  authorityMaskAvailability,
  ensureAuthorityDirs,
  maskedCommand,
} from '../../src/orgrt/authority-mask.js';
import {
  ensureOperatorProtectedPaths,
  operatorMountPoints,
  operatorProtectedPaths,
} from '../../src/orgrt/operator-protected-paths.js';
import {
  mountPointAncestors,
  operatorToolchainPaths,
  resetToolchainMemo,
  toolchainPaths,
  toolchainRoleEnv,
} from '../../src/orgrt/operator-toolchain-paths.js';

const dirs: string[] = [];
const scratch = (p: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), p)));
  dirs.push(d);
  return d;
};
beforeEach(() => resetToolchainMemo());
afterEach(() => {
  vi.restoreAllMocks();
  resetToolchainMemo();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const exe = (p: string) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, '#!/bin/sh\necho REAL\n');
  chmodSync(p, 0o755);
};
const probe = (home: string, env: NodeJS.ProcessEnv, exclude?: string[]) =>
  toolchainPaths({ home, env, execPath: join(home, 'none'), packageRoot: null, exclude });

describe('B1: PATH, pnpm, rustup, XDG', () => {
  it('every writable PATH directory is covered, except one inside a work tree', () => {
    const home = scratch('tr-p-');
    const tools = join(home, 'tools/bin');
    const proj = join(home, 'proj');
    mkdirSync(tools, { recursive: true });
    mkdirSync(join(proj, 'node_modules/.bin'), { recursive: true });
    const env = { PATH: [tools, join(proj, 'node_modules/.bin'), '/usr/bin', 'rel/bin'].join(':') };
    expect(probe(home, env)).toEqual(expect.arrayContaining([tools, join(proj, 'node_modules/.bin')]));
    expect(probe(home, env, [proj])).not.toContain(join(proj, 'node_modules/.bin'));
    expect(probe(home, env)).not.toContain('/usr/bin');
  });

  it('a symlink on the way to a PATH entry: its dedicated directory (fnm_multishells); a general one is only reported', () => {
    const home = scratch('tr-fnm-');
    const install = join(home, '.local/share/fnm/node-versions/v22/installation');
    exe(join(install, 'bin/node'));
    const shells = join(home, '.local/state/fnm_multishells');
    mkdirSync(shells, { recursive: true });
    symlinkSync(install, join(shells, '123_abc'));
    const paths = probe(home, { PATH: join(shells, '123_abc/bin') });
    expect(paths).toEqual(expect.arrayContaining([shells, join(home, '.local/share/fnm')]));

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    symlinkSync(join(install, 'bin'), join(home, 'nodebin'));
    const general = probe(home, { PATH: join(home, 'nodebin') });
    expect(general).not.toContain(home);
    expect(warn.mock.calls.flat().join('\n')).toMatch(/goes through the symlink .*nodebin/);
  });

  it('pnpm’s home is protected whole and the role’s store moves beside it; an operator-set store is kept', () => {
    const home = scratch('tr-pn-');
    const pnpm = join(home, '.local/share/pnpm');
    mkdirSync(join(pnpm, 'store'), { recursive: true });
    expect(probe(home, {})).toContain(pnpm);
    expect(toolchainRoleEnv(home, {})).toEqual({
      npm_config_manage_package_manager_versions: 'false',
      npm_config_store_dir: join(home, '.local/share/pnpm-store'),
    });
    expect(toolchainRoleEnv(home, { npm_config_store_dir: '/x' }).npm_config_store_dir).toBeUndefined();
    expect(toolchainRoleEnv(scratch('tr-nopn-'), {}).npm_config_store_dir).toBeUndefined();
  });

  it('RUSTUP_HOME (default ~/.rustup) and the XDG base directories', () => {
    const home = scratch('tr-x-');
    const alt = scratch('tr-xa-');
    mkdirSync(join(home, '.rustup'));
    expect(probe(home, {})).toContain(join(home, '.rustup'));
    mkdirSync(join(alt, 'rustup'));
    expect(probe(home, { RUSTUP_HOME: join(alt, 'rustup') })).toContain(join(alt, 'rustup'));
    for (const d of ['data/mise', 'data/fnm', 'data/pnpm', 'config/mise']) mkdirSync(join(alt, d), { recursive: true });
    const env = {
      XDG_DATA_HOME: join(alt, 'data'),
      XDG_STATE_HOME: join(alt, 'state'),
      XDG_CONFIG_HOME: join(alt, 'config'),
    };
    const paths = probe(home, env);
    for (const d of ['data/mise', 'data/fnm', 'data/pnpm', 'config/mise']) expect(paths).toContain(join(alt, d));
    // The XDG dirs themselves are never protected.
    for (const d of ['data', 'state', 'config']) expect(paths).not.toContain(join(alt, d));
    // The memo is keyed by them.
    expect(operatorToolchainPaths(home, env)).toContain(join(alt, 'data/mise'));
    expect(operatorToolchainPaths(home, {})).not.toContain(join(alt, 'data/mise'));
  });
});

describe('B2: what an operator shell trusts on cd', () => {
  it('mise’s trust store, ~/.mise.toml and a present ~/.tool-versions; direnv’s allow list — created up front', () => {
    const home = scratch('tr-m-');
    mkdirSync(join(home, '.local/share/mise'), { recursive: true });
    mkdirSync(join(home, '.local/share/direnv'), { recursive: true });
    const env = {} as NodeJS.ProcessEnv;
    ensureOperatorProtectedPaths({ home, env });
    const state = join(home, '.local/state/mise');
    for (const d of ['trusted-configs', 'ignored-configs']) expect(existsSync(join(state, d))).toBe(true);
    expect(existsSync(join(home, '.local/share/direnv/allow'))).toBe(true);
    const paths = operatorProtectedPaths({ home, env });
    for (const p of [join(state, 'trusted-configs'), join(state, 'ignored-configs'), join(home, '.mise.toml'), join(home, '.local/share/direnv/allow')])
      expect(paths).toContain(p);
    expect(paths).not.toContain(join(home, '.tool-versions'));
    writeFileSync(join(home, '.tool-versions'), 'node 22\n');
    resetToolchainMemo();
    expect(operatorProtectedPaths({ home, env })).toContain(join(home, '.tool-versions'));
    const alt = scratch('tr-ms-');
    mkdirSync(join(alt, 'trusted-configs'));
    expect(operatorProtectedPaths({ home, env: { MISE_STATE_DIR: alt } })).toContain(join(alt, 'trusted-configs'));
  });

  it('nothing for mise or direnv where neither is in use', () => {
    const home = scratch('tr-none-');
    ensureOperatorProtectedPaths({ home, env: {} });
    expect(existsSync(join(home, '.local/state/mise'))).toBe(false);
    expect(operatorProtectedPaths({ home, env: {} })).not.toContain(join(home, '.mise.toml'));
  });
});

describe('M1–M3', () => {
  it('M1: a protected tree inside the org root gets mount points up to the root, not past it', () => {
    const root = scratch('tr-root-');
    const nvm = join(root, 'tools/nvm');
    mkdirSync(nvm, { recursive: true });
    expect(mountPointAncestors([nvm], { home: scratch('tr-h-'), roots: [root] })).toEqual([join(root, 'tools')]);
    const home = scratch('tr-h2-');
    expect(operatorMountPoints({ home, env: { NVM_DIR: nvm }, orgRoot: root, cwd: root })).toContain(
      join(root, 'tools'),
    );
  });

  it('M2: expected-but-absent install dirs are created at org start, only under $HOME', () => {
    const home = scratch('tr-pre-');
    const outside = scratch('tr-out-');
    mkdirSync(join(home, '.bun'));
    const env = {
      PNPM_HOME: join(home, 'pnpm-home'),
      PATH: [join(home, '.cargo/bin'), join(home, 'go/bin')].join(':'),
      NVM_DIR: join(outside, 'nvm'),
    };
    ensureOperatorProtectedPaths({ home, env });
    for (const d of ['pnpm-home', '.bun/bin', '.bun/install/global', '.cargo/bin', 'go/bin'])
      expect(existsSync(join(home, d)), d).toBe(true);
    // An absent path outside $HOME is neither created nor watched.
    expect(existsSync(join(outside, 'nvm'))).toBe(false);
  });

  it('M3: toolchain config files, honouring XDG_CONFIG_HOME', () => {
    const home = scratch('tr-cfg-');
    const cfg = scratch('tr-xc-');
    const paths = operatorProtectedPaths({ home, env: { XDG_CONFIG_HOME: cfg } });
    for (const p of ['.bunfig.toml', '.cargo/env', '.cargo/config.toml', '.yarnrc.yml', '.default-npm-packages'])
      expect(paths).toContain(join(home, p));
    for (const p of ['pnpm/rc', 'go/env']) expect(paths).toContain(join(cfg, p));
    expect(operatorProtectedPaths({ home, env: {} })).toContain(join(home, '.config/pnpm/rc'));
  });

  it('the list is recomputed at the next org or session start', () => {
    const home = scratch('tr-memo-');
    expect(operatorToolchainPaths(home, {})).not.toContain(join(home, '.nvm'));
    mkdirSync(join(home, '.nvm'));
    ensureOperatorProtectedPaths({ home, env: {} });
    expect(operatorToolchainPaths(home, {})).toContain(join(home, '.nvm'));
  });
});

describe.runIf(authorityMaskAvailability().available)('inside the real bubblewrap mask (#527 review)', () => {
  it('no plant on PATH, in pnpm’s home, in fnm’s multishells, mise’s trust store or direnv’s allow list; no rename inside the org root', () => {
    const home = scratch('tr-bw-');
    const root = scratch('tr-bwr-');
    const tools = join(home, 'tools/bin');
    mkdirSync(tools, { recursive: true });
    const pnpm = join(home, '.local/share/pnpm');
    mkdirSync(join(pnpm, 'store'), { recursive: true });
    mkdirSync(join(home, '.local/share/mise'), { recursive: true });
    mkdirSync(join(home, '.local/share/direnv'), { recursive: true });
    const install = join(home, '.local/share/fnm/node-versions/v22/installation');
    exe(join(install, 'bin/node'));
    const shells = join(home, '.local/state/fnm_multishells');
    mkdirSync(shells, { recursive: true });
    symlinkSync(install, join(shells, '1_a'));
    const nvm = join(root, 'tools/nvm');
    mkdirSync(nvm, { recursive: true });
    const env = {
      HOME: home,
      PATH: [tools, pnpm, join(shells, '1_a/bin')].join(':'),
      NVM_DIR: nvm,
    } as NodeJS.ProcessEnv;
    ensureAuthorityDirs(home, env);
    ensureOperatorProtectedPaths({ home, env, orgRoot: root });
    const trusted = join(home, '.local/state/mise/trusted-configs');
    const allow = join(home, '.local/share/direnv/allow');
    const [cmd, argv] = maskedCommand(authorityMaskArgs({ home, env, roots: [root], orgRoot: root, cwd: root }), 'bash', [
      '-c',
      [
        `echo x > ${tools}/git 2>/dev/null; echo "P1=$?"`,
        `echo x > ${pnpm}/node 2>/dev/null; echo "P2=$?"`,
        `echo x > ${pnpm}/store/x 2>/dev/null; echo "P3=$?"`,
        `ln -sfn /tmp ${shells}/1_a 2>/dev/null; echo "P4=$?"`,
        `echo x > ${trusted}/evil 2>/dev/null; echo "P5=$?"`,
        `echo x > ${allow}/evil 2>/dev/null; echo "P6=$?"`,
        `mv ${root}/tools ${root}/tools.x 2>/dev/null; echo "P7=$?"`,
        `mv ${home}/.local/state ${home}/.local/state.x 2>/dev/null; echo "P8=$?"`,
        `echo ok > ${root}/work.txt; echo "CWDW=$?"`,
      ].join('; '),
    ]);
    const out = spawnSync(cmd, argv, { encoding: 'utf8' });
    const text = `${out.stdout}${out.stderr}`;
    for (const k of ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8']) expect(text, text).not.toMatch(new RegExp(`${k}=0\\b`));
    expect(text).toMatch(/CWDW=0/);
    for (const p of [join(tools, 'git'), join(pnpm, 'node'), join(trusted, 'evil'), join(allow, 'evil')])
      expect(existsSync(p), p).toBe(false);
    expect(realpathSync(join(shells, '1_a'))).toBe(install);
    for (const p of [join(root, 'tools'), join(home, '.local/state')]) expect(existsSync(p)).toBe(true);
  });
});
