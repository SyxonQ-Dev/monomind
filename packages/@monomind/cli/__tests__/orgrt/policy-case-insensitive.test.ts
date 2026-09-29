// packages/@monomind/cli/__tests__/orgrt/policy-case-insensitive.test.ts
/**
 * #496: on a case-insensitive filesystem (macOS APFS, Windows NTFS, vfat…)
 * `.SSH`, `.GIT`, `.Monomind/ORGS` and `Gates.JSON` are the same files as
 * their lower-case spellings, so the file-tool policy's deny checks must fold
 * case there; grants fold case only where the filesystem really does.
 *
 * The suite runs on Linux, so fs-case.ts's probe is mocked: `insensitive`
 * stands for a case-insensitive volume, `sensitive` for today's behaviour.
 */
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CaseSensitivity } from '../../src/orgrt/fs-case.js';

let probed: CaseSensitivity = 'sensitive';
vi.mock('../../src/orgrt/fs-case.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/orgrt/fs-case.js')>()),
  probeCase: () => probed,
}));

const { OrgBus } = await import('../../src/orgrt/bus.js');
const { PolicyEngine } = await import('../../src/orgrt/policy.js');
const { isWithin, pathFolds, samePath, globToRegExp } = await import(
  '../../src/orgrt/policy-paths.js'
);
const { isDashboardCredential } = await import('../../src/orgrt/file-roots.js');

const REAL_TMPDIR = realpathSync(tmpdir());
const scratch = (prefix: string) => realpathSync(mkdtempSync(join(REAL_TMPDIR, prefix)));
const mkBus = () => new OrgBus('o', 'r', scratch('pci-bus-'));

const savedHome = process.env.HOME;
beforeEach(() => {
  probed = 'sensitive';
});
afterEach(() => {
  process.env.HOME = savedHome;
});

/** An org root with a git checkout, an org definition, a decision file and a
 *  dashboard token, and a throwaway $HOME holding `.ssh/id_rsa`. */
function layout() {
  const root = scratch('pci-root-');
  mkdirSync(join(root, '.git'), { recursive: true });
  writeFileSync(join(root, '.git', 'config'), '[core]\n');
  mkdirSync(join(root, '.monomind', 'orgs', 'acme'), { recursive: true });
  writeFileSync(join(root, '.monomind', 'orgs', 'acme.json'), '{}\n');
  writeFileSync(join(root, '.monomind', 'orgs', 'acme', 'gates.json'), '[]\n');
  writeFileSync(join(root, '.monomind', 'dashboard-token'), 't\n');
  const home = scratch('pci-home-');
  mkdirSync(join(home, '.ssh'), { recursive: true });
  writeFileSync(join(home, '.ssh', 'id_rsa'), 'k\n');
  process.env.HOME = home;
  // $HOME as a root, as `policy.sandbox.allowWrite: [$HOME]` makes it: only
  // the deny list keeps `.ssh` out.
  const engine = new PolicyEngine('coder', {}, mkBus(), root, [home], root);
  return { root, home, engine };
}

const DENIED_VARIANTS = [
  ['Write', '.GIT/config', 'policy.git'],
  ['Edit', '.Git/CONFIG', 'policy.git'],
  ['Write', '.Monomind/ORGS/Acme.JSON', 'org authority state'],
  ['Write', '.monomind/ORGS/acme/Gates.json', 'org authority state'],
  ['Edit', '.MONOMIND/orgs/acme/GATES.JSON', 'org authority state'],
  ['Read', '.monomind/Dashboard-Token', 'dashboard credential'],
] as const;

describe('#496 — deny checks on a case-insensitive filesystem', () => {
  it.each(DENIED_VARIANTS)('%s %s is denied', async (tool, rel, why) => {
    probed = 'insensitive';
    const { root, engine } = layout();
    const d = await engine.decide(tool, { file_path: join(root, rel), content: 'x' });
    expect(d.behavior).toBe('deny');
    expect(d.behavior === 'deny' && d.message).toContain(why);
  });

  it.each(['.SSH/id_rsa', '.Ssh/config'])('Read ~/%s is denied (credential deny list)', async (rel) => {
    probed = 'insensitive';
    const { home, engine } = layout();
    const d = await engine.decide('Read', { file_path: join(home, rel) });
    expect(d.behavior === 'deny' && d.message).toContain('no role may touch');
  });

  it('fails closed when the probe cannot tell', async () => {
    probed = 'unknown';
    const { root, home, engine } = layout();
    expect((await engine.decide('Write', { file_path: join(root, '.GIT/config') })).behavior).toBe('deny');
    expect((await engine.decide('Read', { file_path: join(home, '.SSH/id_rsa') })).behavior).toBe('deny');
  });
});

describe('#496 — the same paths on a case-sensitive filesystem keep today\'s behaviour', () => {
  it.each(DENIED_VARIANTS)('%s %s is a different file and is allowed', async (tool, rel) => {
    const { root, engine } = layout();
    expect((await engine.decide(tool, { file_path: join(root, rel), content: 'x' })).behavior).toBe('allow');
  });

  it('Read ~/.SSH/id_rsa is a different file and is allowed; ~/.ssh/id_rsa is still denied', async () => {
    const { home, engine } = layout();
    expect((await engine.decide('Read', { file_path: join(home, '.SSH/id_rsa') })).behavior).toBe('allow');
    expect((await engine.decide('Read', { file_path: join(home, '.ssh/id_rsa') })).behavior).toBe('deny');
  });

  it('the exact spellings are still denied', async () => {
    const { root, engine } = layout();
    for (const rel of ['.git/config', '.monomind/orgs/acme.json', '.monomind/orgs/acme/gates.json'])
      expect((await engine.decide('Write', { file_path: join(root, rel), content: 'x' })).behavior).toBe('deny');
  });
});

describe('#496 — grants match case variants only on a case-insensitive filesystem', () => {
  function site() {
    const cwd = scratch('pci-cwd-');
    mkdirSync(join(cwd, 'site'), { recursive: true });
    mkdirSync(join(cwd, 'docs'), { recursive: true });
    return cwd;
  }
  const cases = [
    ['a directory entry', (cwd: string) => [join(cwd, 'site')], 'Site/index.html'],
    ['a relative directory entry', () => ['site'], 'SITE/index.html'],
    ['a relative glob', () => ['docs/**'], 'Docs/a.md'],
    ['an absolute glob', (cwd: string) => [`${cwd}/docs/**`], 'DOCS/a.md'],
  ] as const;

  it.each(cases)('%s matches a case variant when insensitive', async (_n, scope, rel) => {
    probed = 'insensitive';
    const cwd = site();
    const p = new PolicyEngine('w', { fileWrite: scope(cwd) }, mkBus(), cwd);
    expect((await p.decide('Write', { file_path: join(cwd, rel), content: 'x' })).behavior).toBe('allow');
  });

  it.each(cases)('%s does not match it when sensitive or unknown', async (_n, scope, rel) => {
    for (const mode of ['sensitive', 'unknown'] as const) {
      probed = mode;
      const cwd = site();
      const p = new PolicyEngine('w', { fileWrite: scope(cwd) }, mkBus(), cwd);
      expect((await p.decide('Write', { file_path: join(cwd, rel), content: 'x' })).behavior).toBe('deny');
    }
  });

  it('a folded grant never reaches a sibling with a shared prefix', async () => {
    probed = 'insensitive';
    const cwd = site();
    mkdirSync(join(cwd, 'site-old'));
    const p = new PolicyEngine('w', { fileWrite: [join(cwd, 'site')] }, mkBus(), cwd);
    expect((await p.decide('Write', { file_path: join(cwd, 'Site-Old/x'), content: 'x' })).behavior).toBe('deny');
  });
});

describe('#496 — comparators', () => {
  it('pathFolds: denies fold on darwin/win32 or unless known sensitive; grants only when known insensitive', () => {
    probed = 'sensitive';
    expect(pathFolds('/x', 'linux')).toEqual({ deny: 'exact', allow: 'exact' });
    expect(pathFolds('/x', 'darwin')).toEqual({ deny: 'deny', allow: 'exact' });
    expect(pathFolds('/x', 'win32')).toEqual({ deny: 'deny', allow: 'exact' });
    probed = 'unknown';
    expect(pathFolds('/x', 'linux')).toEqual({ deny: 'deny', allow: 'exact' });
    probed = 'insensitive';
    expect(pathFolds('/x', 'linux')).toEqual({ deny: 'deny', allow: 'case' });
  });

  it('deny folding also ignores NFC/NFD differences; grant folding does not', () => {
    const nfc = '/h/café';
    const nfd = '/h/café/x';
    expect(isWithin(nfc, nfd, 'deny')).toBe(true);
    expect(isWithin(nfc, nfd, 'case')).toBe(false);
    expect(isWithin(nfc, nfd)).toBe(false);
  });

  it('isWithin / samePath / globToRegExp / isDashboardCredential by fold', () => {
    expect(isWithin('/a/Site', '/a/site/x', 'case')).toBe(true);
    expect(isWithin('/a/Site', '/a/site/x')).toBe(false);
    expect(isWithin('/a/site', '/a/site-old', 'case')).toBe(false);
    expect(samePath('/a/Site', '/a/site', 'case')).toBe(true);
    expect(samePath('/a/Site', '/a/site')).toBe(false);
    expect(globToRegExp('docs/**', 'case').test('DOCS/a.md')).toBe(true);
    expect(globToRegExp('docs/**').test('DOCS/a.md')).toBe(false);
    expect(isDashboardCredential('/p/.monomind/Dashboard-Token-3000', 'deny')).toBe(true);
    expect(isDashboardCredential('/p/.monomind/Dashboard-Token-3000')).toBe(false);
  });
});

describe('#496 — the filesystem probe (real, unmocked)', () => {
  it('sees this Linux temp dir as case-sensitive, `/` as unknown, and ignores a look-alike symlink', async () => {
    const { probeCase } = await vi.importActual<typeof import('../../src/orgrt/fs-case.js')>(
      '../../src/orgrt/fs-case.js',
    );
    const dir = scratch('pci-probe-');
    mkdirSync(join(dir, 'abc'));
    expect(probeCase(join(dir, 'abc', 'missing', 'file'))).toBe('sensitive');
    expect(probeCase('/')).toBe('unknown');
    // A role planting `ABC -> abc` must not make the probe report folding.
    const other = scratch('pci-probe-');
    mkdirSync(join(other, 'abc'));
    symlinkSync(join(other, 'abc'), join(other, 'ABC'));
    expect(probeCase(join(other, 'abc', 'x'))).toBe('sensitive');
  });
});
