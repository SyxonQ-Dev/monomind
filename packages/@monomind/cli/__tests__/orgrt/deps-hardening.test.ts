/**
 * #526 follow-ups to the #518 review, with a temp HOME throughout:
 *   (2) HOME_DENY_WRITE entries that did not exist were dropped from the SDK
 *       sandbox's denyWrite and missing from the mask, so a role could create
 *       ~/.npmrc, ~/.config/npm or an rc file. The harmless ones are now
 *       created empty before a role starts; on macOS a missing one is denied
 *       by path.
 *   (3) a custom MONOMIND_HOME under a writable root could be renamed aside
 *       through an ancestor: every such ancestor is now a mount point, in the
 *       SDK sandbox's allowWrite and in the mask.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  authorityMaskArgs,
  authorityMaskAvailability,
  maskedCommand,
} from '../../src/orgrt/authority-mask.js';
import { HOME_DENY_WRITE } from '../../src/orgrt/file-roots.js';
import { gitCommonDir, prepareGitGuard } from '../../src/orgrt/git-guard.js';
import {
  ensureOperatorProtectedPaths,
  GITCONFIG_STUB,
  HOME_DENY_WRITE_NOT_STUBBED,
  HOME_DENY_WRITE_STUB_DIRS,
  HOME_DENY_WRITE_STUB_FILES,
  ZSH_STUBS,
} from '../../src/orgrt/operator-protected-paths.js';
import { buildClaudeRestrictions } from '../../src/orgrt/role-sandbox.js';
import { renameGuardDirs } from '../../src/orgrt/sandbox-deny-write.js';

const dirs: string[] = [];
const scratch = (p: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), p)));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function restrictions(o: {
  home: string;
  base: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}) {
  const repo = join(o.base, 'repo');
  spawnSync('git', ['init', '-q', repo]);
  const guard = prepareGitGuard({
    level: 'read',
    stateDir: join(o.base, 'guard'),
    protectedGitDirs: [gitCommonDir(repo) as string],
  });
  return buildClaudeRestrictions(
    guard as NonNullable<typeof guard>,
    undefined,
    {
      cwd: repo,
      orgRoot: o.base,
      home: o.home,
      tmp: o.base,
      env: o.env ?? {},
      platform: o.platform,
    },
    true,
  ).sandbox as { filesystem: { denyWrite: string[]; allowWrite: string[] } };
}

const bound = (args: string[], flag: string, p: string) =>
  args.findIndex((a, i) => a === flag && args[i + 1] === p && args[i + 2] === p);

describe('(2) missing HOME_DENY_WRITE entries are stubbed before a role starts', () => {
  it('creates the harmless ones empty, and none that would change behaviour', () => {
    const home = scratch('dh-home-');
    ensureOperatorProtectedPaths({ home, env: {} });
    for (const f of [...HOME_DENY_WRITE_STUB_FILES, GITCONFIG_STUB]) {
      expect(lstatSync(join(home, f)).isFile(), f).toBe(true);
      expect(readFileSync(join(home, f), 'utf8'), f).toBe('');
    }
    for (const d of HOME_DENY_WRITE_STUB_DIRS) {
      const st = lstatSync(join(home, d));
      expect(st.isDirectory(), d).toBe(true);
      expect(st.mode & 0o777, d).toBe(0o700);
      expect(readdirSync(join(home, d)), d).toEqual([]);
    }
    for (const f of ['.bash_profile', '.bash_login', '.claude.json', ...ZSH_STUBS])
      expect(existsSync(join(home, f)), f).toBe(false);
    expect(existsSync(join(home, '.claude', '.config.json'))).toBe(false);
  });

  it('leaves existing files alone, adds zsh stubs only beside a zsh file, and ~/.gitconfig only without an XDG git config', () => {
    const home = scratch('dh-home-');
    writeFileSync(join(home, '.npmrc'), 'registry=https://example.invalid/\n');
    writeFileSync(join(home, '.zshrc'), 'echo hi\n');
    mkdirSync(join(home, '.config', 'git'), { recursive: true });
    writeFileSync(join(home, '.config', 'git', 'config'), '[user]\n');
    ensureOperatorProtectedPaths({ home, env: {} });
    expect(readFileSync(join(home, '.npmrc'), 'utf8')).toBe('registry=https://example.invalid/\n');
    expect(readFileSync(join(home, '.zshrc'), 'utf8')).toBe('echo hi\n');
    for (const f of ZSH_STUBS) expect(existsSync(join(home, f)), f).toBe(true);
    expect(existsSync(join(home, '.gitconfig'))).toBe(false);
    // $XDG_CONFIG_HOME moves git's XDG config.
    const home2 = scratch('dh-home-');
    const xdg = scratch('dh-xdg-');
    mkdirSync(join(xdg, 'git'));
    writeFileSync(join(xdg, 'git', 'config'), '[user]\n');
    ensureOperatorProtectedPaths({ home: home2, env: { XDG_CONFIG_HOME: xdg } });
    expect(existsSync(join(home2, '.gitconfig'))).toBe(false);
  });

  it('accounts for every HOME_DENY_WRITE entry', () => {
    const handled = [
      ...HOME_DENY_WRITE_STUB_DIRS,
      ...HOME_DENY_WRITE_STUB_FILES,
      GITCONFIG_STUB,
      ...ZSH_STUBS,
      ...HOME_DENY_WRITE_NOT_STUBBED,
    ];
    expect([...HOME_DENY_WRITE].sort()).toEqual([...new Set(handled)].sort());
  });

  it('the SDK sandbox denies the stubs, and the mask binds them read-only', () => {
    const home = scratch('dh-home-');
    const base = scratch('dh-base-');
    ensureOperatorProtectedPaths({ home, env: {}, orgRoot: base });
    const fs = restrictions({ home, base, platform: 'linux' }).filesystem;
    const args = authorityMaskArgs({ home, env: {}, roots: [base], orgRoot: base });
    for (const p of ['.npmrc', '.config/npm', '.config/git', '.bashrc', '.gitconfig', '.ssh']) {
      expect(fs.denyWrite, p).toContain(join(home, p));
      expect(bound(args, '--ro-bind', join(home, p)), p).toBeGreaterThan(-1);
    }
  });

  it('on macOS a missing one is still denied, by path (seatbelt), when its parent exists', () => {
    const home = scratch('dh-home-');
    const base = scratch('dh-base-');
    const fs = restrictions({ home, base, platform: 'darwin' }).filesystem;
    expect(fs.denyWrite).toContain(join(home, '.bash_profile'));
    expect(fs.denyWrite).toContain(join(home, '.npmrc'));
    // ~/.config is missing: denying ~/.config/npm would make seatbelt deny
    // creating ~/.config itself (the SDK denies every ancestor), so it is left out.
    expect(fs.denyWrite).not.toContain(join(home, '.config', 'npm'));
    // Linux keeps dropping what does not exist (bwrap binds only existing paths).
    const linux = restrictions({ home, base, platform: 'linux' }).filesystem;
    expect(linux.denyWrite).not.toContain(join(home, '.bash_profile'));
  });
});

describe('(3) a custom MONOMIND_HOME cannot be renamed aside through an ancestor', () => {
  it('renameGuardDirs lists the ancestors whose parent is writable, top down', () => {
    const base = scratch('dh-base-');
    const mm = join(base, 'a', 'b', 'mm');
    mkdirSync(mm, { recursive: true });
    const inBase = (p: string) => p === base || p.startsWith(`${base}/`);
    expect(renameGuardDirs(mm, inBase)).toEqual([
      join(base, 'a'),
      join(base, 'a', 'b'),
      mm,
    ]);
  });

  it('the SDK sandbox makes each one a mount point (allowWrite), and nothing outside the writable roots', () => {
    const home = scratch('dh-home-');
    const base = scratch('dh-base-');
    const mm = join(base, 'repo', 'x', 'mm');
    mkdirSync(mm, { recursive: true });
    const fs = restrictions({ home, base, env: { MONOMIND_HOME: mm } }).filesystem;
    for (const d of [join(base, 'repo'), join(base, 'repo', 'x'), mm])
      expect(fs.allowWrite, d).toContain(d);
    expect(fs.denyWrite).toContain(join(mm, 'deps'));
    expect(fs.allowWrite.some((d) => d === '/' || d === '/home')).toBe(false);
  });

  it('the mask binds each ancestor before the monomind home it holds', () => {
    const home = scratch('dh-home-');
    const base = scratch('dh-base-');
    const mm = join(base, 'a', 'b', 'mm');
    mkdirSync(mm, { recursive: true });
    const args = authorityMaskArgs({ home, env: { MONOMIND_HOME: mm }, roots: [base], orgRoot: base });
    const ro = bound(args, '--ro-bind', mm);
    expect(ro).toBeGreaterThan(-1);
    for (const d of [join(base, 'a'), join(base, 'a', 'b')]) {
      const at = bound(args, '--bind', d);
      expect(at, d).toBeGreaterThan(-1);
      expect(at, d).toBeLessThan(ro);
    }
    expect(bound(args, '--ro-bind', join(mm, 'deps'))).toBeGreaterThan(-1);
  });
});

describe.runIf(authorityMaskAvailability().available)('inside the real mask', () => {
  it('(3) a role can neither rename an ancestor of MONOMIND_HOME aside nor plant a deps dir', () => {
    const home = scratch('dh-home-');
    const base = scratch('dh-base-');
    const mm = join(base, 'a', 'b', 'mm');
    mkdirSync(mm, { recursive: true });
    const env = { MONOMIND_HOME: mm };
    const [cmd, argv] = maskedCommand(
      authorityMaskArgs({ home, env, roots: [base], orgRoot: base }),
      'bash',
      [
        '-c',
        `mv ${base}/a ${base}/a-aside 2>/dev/null && echo RENAMED-A; ` +
          `mv ${base}/a/b ${base}/a/b-aside 2>/dev/null && echo RENAMED-B; ` +
          `mv ${mm} ${base}/a/b/mm-aside 2>/dev/null && echo RENAMED-MM; ` +
          `mkdir ${mm}/deps/@anthropic-ai+claude-agent-sdk@0.3.226 2>/dev/null && echo PLANTED; ` +
          `echo ok > ${base}/work.txt && echo WROTE; true`,
      ],
    );
    const out = spawnSync(cmd, argv, { encoding: 'utf8' }).stdout;
    expect(out).toContain('WROTE');
    expect(out).not.toMatch(/RENAMED|PLANTED/);
    expect(existsSync(join(base, 'a-aside'))).toBe(false);
    expect(readdirSync(join(mm, 'deps'))).toEqual([]);
  });

  it('(2) a role can write none of the stubbed npm and shell config', () => {
    const home = scratch('dh-home-');
    const base = scratch('dh-base-');
    ensureOperatorProtectedPaths({ home, env: {}, orgRoot: base });
    const [cmd, argv] = maskedCommand(
      authorityMaskArgs({ home, env: {}, roots: [base], orgRoot: base }),
      'bash',
      [
        '-c',
        `echo registry=evil > ${home}/.npmrc 2>/dev/null && echo NPMRC; ` +
          `echo registry=evil > ${home}/.config/npm/npmrc 2>/dev/null && echo XDGNPM; ` +
          `echo evil >> ${home}/.bashrc 2>/dev/null && echo BASHRC; ` +
          `echo '[core]' > ${home}/.config/git/config 2>/dev/null && echo GITXDG; ` +
          `mv ${home}/.npmrc ${home}/.npmrc-aside 2>/dev/null && echo MOVED; true`,
      ],
    );
    const out = spawnSync(cmd, argv, { encoding: 'utf8' }).stdout;
    expect(out).not.toMatch(/NPMRC|XDGNPM|BASHRC|GITXDG|MOVED/);
    expect(readFileSync(join(home, '.npmrc'), 'utf8')).toBe('');
    expect(existsSync(join(home, '.config', 'npm', 'npmrc'))).toBe(false);
  });
});
