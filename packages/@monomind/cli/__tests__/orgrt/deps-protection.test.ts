/**
 * #518 review, B1: an org role could write ~/.monomind/deps (the SDK
 * sandbox's allowWrite includes $HOME; the mask is `--dev-bind / /`) and
 * plant the SDK or Chrome that the unsandboxed daemon then runs, or point
 * npm elsewhere with ~/.npmrc. The deps dir and npm's config are now
 * write-denied in the file tools and the SDK sandbox, and read-only in the
 * mask, with its parent a mount point so it cannot be renamed aside.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  authorityMaskArgs,
  authorityMaskAvailability,
  maskedCommand,
} from '../../src/orgrt/authority-mask.js';
import { fileToolDenied, HOME_DENY_WRITE } from '../../src/orgrt/file-roots.js';
import { gitCommonDir, prepareGitGuard } from '../../src/orgrt/git-guard.js';
import { buildClaudeRestrictions } from '../../src/orgrt/role-sandbox.js';

const scratch = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));

describe('deps dir and npm config are write-denied to roles', () => {
  it('HOME_DENY_WRITE lists them, and the file tools deny them', () => {
    expect(HOME_DENY_WRITE).toEqual(expect.arrayContaining(['.monomind/deps', '.npmrc', '.config/npm']));
    const home = scratch('dp-home-');
    const denied = fileToolDenied(home, {});
    for (const p of ['.monomind/deps', '.npmrc', '.config/npm']) expect(denied).toContain(join(home, p));
    // $MONOMIND_HOME moves the deps dir; the deny follows it.
    const mm = scratch('dp-mm-');
    expect(fileToolDenied(home, { MONOMIND_HOME: mm })).toContain(join(mm, 'deps'));
  });

  it('the SDK sandbox denies writes to the deps dir (created first) and pins ~/.monomind as a mount point', () => {
    const base = scratch('dp-base-');
    const repo = join(base, 'repo');
    spawnSync('git', ['init', '-q', repo]);
    const guard = prepareGitGuard({
      level: 'read',
      stateDir: join(base, 'guard'),
      protectedGitDirs: [gitCommonDir(repo)!],
    })!;
    const home = scratch('dp-home-');
    const sb = buildClaudeRestrictions(guard, undefined, { cwd: repo, orgRoot: base, home, tmp: '/tmp', env: {} }, true)
      .sandbox as { filesystem: { denyWrite: string[]; allowWrite: string[] } };
    expect(existsSync(join(home, '.monomind', 'deps'))).toBe(true);
    expect(sb.filesystem.denyWrite).toContain(join(home, '.monomind', 'deps'));
    expect(sb.filesystem.allowWrite).toContain(join(home, '.monomind'));
  });

  it('the mask binds the deps dir read-only and its parent in place', () => {
    const home = scratch('dp-home-');
    const root = scratch('dp-root-');
    const args = authorityMaskArgs({ home, env: {}, roots: [root], orgRoot: root });
    const deps = join(home, '.monomind', 'deps');
    const at = args.indexOf('--ro-bind', args.indexOf(join(home, '.monomind')));
    expect(args.slice(at, at + 3)).toEqual(['--ro-bind', deps, deps]);
    expect(args).toEqual(expect.arrayContaining(['--bind', join(home, '.monomind')]));
  });
});

describe.runIf(authorityMaskAvailability().available)('inside the real mask', () => {
  it('a role can neither plant into the deps dir nor rename ~/.monomind aside', () => {
    const home = scratch('dp-home-');
    const root = scratch('dp-root-');
    const mm = join(home, '.monomind');
    const [cmd, argv] = maskedCommand(
      authorityMaskArgs({ home, env: {}, roots: [root], orgRoot: root }),
      'bash',
      [
        '-c',
        `mkdir ${mm}/deps/@anthropic-ai+claude-agent-sdk@0.3.226 2>/dev/null && echo PLANTED; ` +
          `mv ${mm} ${home}/.mm-aside 2>/dev/null && echo RENAMED; ` +
          `mv ${mm}/deps ${mm}/deps-aside 2>/dev/null && echo MOVED; true`,
      ],
    );
    const out = spawnSync(cmd, argv, { encoding: 'utf8' }).stdout;
    expect(out).not.toMatch(/PLANTED|RENAMED|MOVED/);
    expect(readdirSync(join(mm, 'deps'))).toEqual([]);
    expect(existsSync(join(home, '.mm-aside'))).toBe(false);
  });

  it('a masked role gets a read-only deps dir, so its install fails with EROFS', () => {
    const home = scratch('dp-home-');
    const root = scratch('dp-root-');
    mkdirSync(join(home, '.monomind', 'deps'), { recursive: true, mode: 0o700 });
    const [cmd, argv] = maskedCommand(
      authorityMaskArgs({ home, env: {}, roots: [root], orgRoot: root }),
      'bash',
      ['-c', `touch ${home}/.monomind/deps/x`],
    );
    expect(spawnSync(cmd, argv, { encoding: 'utf8' }).stderr).toMatch(/Read-only file system/);
  });
});
