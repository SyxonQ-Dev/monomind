// packages/@monomind/cli/__tests__/orgrt/policy-case-insensitive.test.ts
/**
 * #496: on a case-insensitive filesystem (macOS APFS, Windows NTFS, vfat,
 * exfat, a Linux casefold dir) `.SSH`, `.GIT`, `.Monomind/ORGS` and
 * `Gates.JSON` are the same files as their lower-case spellings.
 *
 * Deny checks fold unconditionally (case, NFKC, full case folding, trailing
 * dots, `:stream`), whatever the filesystem probe says. Grants fold only on
 * darwin/win32 where the probe shows the filesystem folds case, and only
 * the not-yet-existing tail of a path. The probe is mocked for the engine
 * tests; its own tests below run it for real.
 */
import { linkSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
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
const { grantWithin, isWithin, pathFolds, segmentsBelow } = await import(
  '../../src/orgrt/policy-paths.js'
);
const { onDiskSpelling } = await import('../../src/orgrt/policy-scopes.js');
const { isDashboardCredential } = await import('../../src/orgrt/file-roots.js');

const REAL_TMPDIR = realpathSync(tmpdir());
const scratch = (prefix: string) => realpathSync(mkdtempSync(join(REAL_TMPDIR, prefix)));
const mkBus = () => new OrgBus('o', 'r', scratch('pci-bus-'));

const savedHome = process.env.HOME;
const savedPlatform = process.platform;
const setPlatform = (p: NodeJS.Platform) =>
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
beforeEach(() => {
  probed = 'sensitive';
});
afterEach(() => {
  process.env.HOME = savedHome;
  setPlatform(savedPlatform);
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

const ROOT_VARIANTS = [
  ['Write', '.GIT/config', 'policy.git'],
  ['Edit', '.Git/CONFIG', 'policy.git'],
  ['Write', '.g\u0131t/config', 'policy.git'], // dotless ı (NTFS upcases it to I)
  ['Write', '.git./config', 'policy.git'], // trailing dot (Windows, vfat, exfat)
  ['Write', '.Monomind/ORGS/Acme.JSON', 'org authority state'],
  ['Write', '.monomind/ORGS/acme/Gates.json', 'org authority state'],
  ['Edit', '.MONOMIND/orgs/acme/GATES.JSON', 'org authority state'],
  ['Write', '.monomind/org\u017f/acme/gates.json', 'org authority state'], // long s ſ
  ['Write', '.monomind/orgs/acme.json.', 'org authority state'],
  ['Read', '.monomind/Dashboard-Token', 'dashboard credential'],
  ['Read', '.monomind/da\u017fhboard-token', 'dashboard credential'],
  ['Read', '.monomind/dashboard-to\u212Aen', 'dashboard credential'], // Kelvin sign K
] as const;

const HOME_VARIANTS = [
  '.SSH/id_rsa',
  '.Ssh/config',
  '.\u017fsh/id_rsa', // .ſsh
  '.\u00dfh/id_rsa', // .ßh → .ssh
  '.\u1e9eh/id_rsa', // .ẞh → .ssh
  '.GITCONFIG',
  '.BashRC',
  '.con\ufb01g/gh/hosts.yml', // ﬁ ligature
  '.pro\ufb01le',
  '.ssh./id_rsa',
];

describe('#496 — deny checks fold on every filesystem, whatever the probe says', () => {
  it.each(ROOT_VARIANTS)('%s %s is denied', async (tool, rel, why) => {
    for (const mode of ['sensitive', 'insensitive', 'unknown'] as const) {
      probed = mode;
      const { root, engine } = layout();
      const d = await engine.decide(tool, { file_path: join(root, rel), content: 'x' });
      expect(d.behavior === 'deny' && d.message).toContain(why);
    }
  });

  it.each(HOME_VARIANTS)('~/%s is denied (credential / guard deny list)', async (rel) => {
    for (const mode of ['sensitive', 'insensitive'] as const) {
      probed = mode;
      const { home, engine } = layout();
      const d = await engine.decide('Read', { file_path: join(home, rel) });
      expect(d.behavior === 'deny' && d.message).toContain('no role may touch');
    }
  });

  it('a probe that calls the casefold root case-sensitive does not relax a deny', async () => {
    // The nearest existing dir of `~/.GITCONFIG` is $HOME itself — on a
    // casefold mount, a probe of $HOME's own name sees its parent, which is
    // case-sensitive. Mocked here as `sensitive`: the deny still folds.
    probed = 'sensitive';
    const { home, engine } = layout();
    for (const rel of ['.GITCONFIG', '.BashRC'])
      expect((await engine.decide('Write', { file_path: join(home, rel), content: 'x' })).behavior).toBe(
        'deny',
      );
    expect(pathFolds(join(home, '.GITCONFIG'), 'linux').deny).toBe('deny');
  });

  it('a name that NFKC-folds to `..` stays a name: it cannot lift a path out of a denied dir', () => {
    expect(isWithin('/h/.ssh', '/h/.ssh/\uff0e\uff0e/x', 'deny')).toBe(true);
  });

  it('ordinary files next to the protected ones are still allowed', async () => {
    const { root, home, engine } = layout();
    for (const p of [join(root, 'src/a.ts'), join(home, 'notes.txt'), join(root, '.monomind/orgs/acme/reports/r.md')])
      expect((await engine.decide('Write', { file_path: p, content: 'x' })).behavior).toBe('allow');
  });
});

describe('#496 — grants fold only the not-yet-existing tail, only on darwin/win32 where the probe says so', () => {
  function site() {
    const cwd = scratch('pci-cwd-');
    mkdirSync(join(cwd, 'site'), { recursive: true });
    return cwd;
  }
  const cases = [
    ['an absolute directory entry', (cwd: string) => [join(cwd, 'site')]],
    ['a relative directory entry', () => ['site']],
  ] as const;

  it.each(cases)('%s matches a new, differently-cased path when darwin + insensitive', async (_n, scope) => {
    setPlatform('darwin');
    probed = 'insensitive';
    const cwd = site();
    const p = new PolicyEngine('w', { fileWrite: scope(cwd) }, mkBus(), cwd);
    expect((await p.decide('Write', { file_path: join(cwd, 'Site/index.html'), content: 'x' })).behavior).toBe(
      'allow',
    );
  });

  it.each(cases)('%s does not fold on Linux, or when the probe is not sure', async (_n, scope) => {
    for (const [platform, mode] of [
      ['linux', 'insensitive'],
      ['darwin', 'sensitive'],
      ['darwin', 'unknown'],
    ] as const) {
      setPlatform(platform);
      probed = mode;
      const cwd = site();
      const p = new PolicyEngine('w', { fileWrite: scope(cwd) }, mkBus(), cwd);
      expect((await p.decide('Write', { file_path: join(cwd, 'Site/index.html'), content: 'x' })).behavior).toBe(
        'deny',
      );
    }
  });

  it('never folds into an EXISTING differently-cased directory (grant /x/app, write /x/APP/cf2/sub/x)', async () => {
    setPlatform('darwin');
    probed = 'insensitive';
    const cwd = scratch('pci-cwd-');
    mkdirSync(join(cwd, 'app'));
    mkdirSync(join(cwd, 'APP', 'cf2'), { recursive: true });
    const p = new PolicyEngine('w', { fileWrite: [join(cwd, 'app')] }, mkBus(), cwd);
    expect((await p.decide('Write', { file_path: join(cwd, 'APP/cf2/sub/x'), content: 'x' })).behavior).toBe(
      'deny',
    );
    expect(grantWithin(join(cwd, 'app'), join(cwd, 'APP/cf2/sub/x'), 'case', 'darwin')).toBe(false);
  });

  it('globs never fold', async () => {
    setPlatform('darwin');
    probed = 'insensitive';
    const cwd = site();
    const p = new PolicyEngine('w', { fileWrite: ['site/**'] }, mkBus(), cwd);
    expect((await p.decide('Write', { file_path: join(cwd, 'SITE/new/a.md'), content: 'x' })).behavior).toBe(
      'deny',
    );
  });

  it('a folded grant never reaches a sibling with a shared prefix', () => {
    expect(grantWithin('/nope/site', '/nope/Site-Old/x', 'case', 'darwin')).toBe(false);
    expect(grantWithin('/nope/site', '/nope/Site/x', 'case', 'darwin')).toBe(true);
    expect(grantWithin('/nope/site', '/nope/Site/x', 'exact', 'darwin')).toBe(false);
  });
});

describe('#496 — a directory entry spelled in another case is not refused as a symlink', () => {
  it('onDiskSpelling: case-only difference, no symlink, darwin/win32 only', () => {
    const base = scratch('pci-ods-');
    mkdirSync(join(base, 'Site'));
    expect(onDiskSpelling(join(base, 'site'), join(base, 'Site'), 'darwin')).toBe(true);
    expect(onDiskSpelling(join(base, 'site'), join(base, 'Site'), 'linux')).toBe(false);
    expect(onDiskSpelling(join(base, 'site'), join(base, 'other'), 'darwin')).toBe(false);
    symlinkSync(join(base, 'Site'), join(base, 'link'));
    expect(onDiskSpelling(join(base, 'link'), join(base, 'LINK'), 'darwin')).toBe(false);
  });
});

describe('#496 — comparators', () => {
  it('pathFolds: deny always folds; allow only on darwin/win32 when the probe says insensitive', () => {
    for (const mode of ['sensitive', 'unknown', 'insensitive'] as const) {
      probed = mode;
      expect(pathFolds('/x', 'linux')).toEqual({ deny: 'deny', allow: 'exact' });
    }
    probed = 'insensitive';
    expect(pathFolds('/x', 'darwin')).toEqual({ deny: 'deny', allow: 'case' });
    expect(pathFolds('/x', 'win32')).toEqual({ deny: 'deny', allow: 'case' });
    probed = 'unknown';
    expect(pathFolds('/x', 'darwin')).toEqual({ deny: 'deny', allow: 'exact' });
  });

  it('deny folding covers NFC/NFD, NFKC and full case folding', () => {
    expect(isWithin('/h/caf\u00e9', '/h/cafe\u0301/x', 'deny')).toBe(true);
    expect(isWithin('/h/.ssh', '/h/.\u017f\u017fh', 'deny')).toBe(true);
    expect(isWithin('/h/.ssh', '/h/.\u00dfh', 'deny')).toBe(true);
    expect(isWithin('/h/.config', '/h/.con\ufb01g', 'deny')).toBe(true);
    expect(isWithin('/h/.ssh', '/h/.\u017fsh')).toBe(false);
  });

  it('isDashboardCredential by fold', () => {
    expect(isDashboardCredential('/p/.monomind/Dashboard-Token-3000', 'deny')).toBe(true);
    expect(isDashboardCredential('/p/.monomind/dashboard-token.', 'deny')).toBe(true);
    expect(isDashboardCredential('/p/.monomind/Dashboard-Token-3000')).toBe(false);
  });

  it('a `\\\\?\\` or UNC spelling is never within a drive-letter root (the roots check fails closed)', () => {
    expect(segmentsBelow('C:\\work', '\\\\?\\C:\\work\\x', 'win32', 'exact')).toBeNull();
    expect(segmentsBelow('C:\\work', '\\\\server\\share\\work\\x', 'win32', 'exact')).toBeNull();
    expect(segmentsBelow('C:\\work', 'c:\\WORK\\x', 'win32', 'deny')).toEqual(['x']);
  });
});

describe('#496 — the filesystem probe (real, unmocked)', async () => {
  const { probeCase } = await vi.importActual<typeof import('../../src/orgrt/fs-case.js')>(
    '../../src/orgrt/fs-case.js',
  );

  it('sees this Linux temp dir as case-sensitive and `/`-only paths as unknown', () => {
    const dir = scratch('pci-probe-');
    mkdirSync(join(dir, 'abc'));
    writeFileSync(join(dir, 'abc', 'f'), '');
    expect(probeCase(join(dir, 'abc', 'missing', 'file'))).toBe('sensitive');
    expect(probeCase('/')).toBe('unknown');
  });

  it('ignores a look-alike symlink', () => {
    const other = scratch('pci-probe-');
    mkdirSync(join(other, 'abc'));
    symlinkSync(join(other, 'abc'), join(other, 'ABC'));
    expect(probeCase(join(other, 'abc', 'x'))).not.toBe('insensitive');
  });

  it('an inner probe faked with a case-variant hard link disagrees with the outer probe → unknown', () => {
    const dir = scratch('pci-probe-');
    mkdirSync(join(dir, 'abc'));
    writeFileSync(join(dir, 'abc', 'x'), '');
    linkSync(join(dir, 'abc', 'x'), join(dir, 'abc', 'X'));
    expect(probeCase(join(dir, 'abc', 'new'))).toBe('unknown');
  });
});

describe('#496 — the Bash git classifier matches git and interpreters in any case', async () => {
  const { checkGitPolicy } = await import('../../src/orgrt/policy-git.js');
  it.each([
    'GIT push',
    '/usr/bin/GIT push',
    'git.EXE push',
    'Git.exe push origin main',
    "'C:\\Program Files\\Git\\bin\\GIT.exe' push",
    'BASH -c "git push"',
    'bash -c "GIT push"',
    'Python3 -c "import os; os.system(\'git push\')"',
    'ENV -i git push',
  ])('%s is denied at level read', (cmd) => {
    expect(checkGitPolicy(cmd, 'read')).not.toBeNull();
  });

  it('read-only git in any case is still allowed at level read', () => {
    expect(checkGitPolicy('GIT status', 'read')).toBeNull();
    expect(checkGitPolicy('/usr/bin/Git log --oneline', 'read')).toBeNull();
  });
});
