/**
 * CHANGELOG.md merge driver for parallel release sessions.
 *
 * ## The failure this pins
 *
 * On 2026-09-26 several sessions ran the release org back to back
 * (2.16.7 … 2.16.12). Each release turned `## [Unreleased]` into
 * `## [2.16.x] — <date>` on origin while the session's local main had added
 * new entries under `## [Unreleased]` in the same place, so every
 * `git merge origin/main` stopped on a CHANGELOG.md conflict. It was always
 * resolved the same way by hand: keep the released section verbatim and move
 * the new local entries into a fresh `## [Unreleased]` above it.
 *
 * scripts/merge-changelog.mjs does that as a git merge driver
 * (`%O %A %B`), and leaves an ordinary conflict for anything else.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DRIVER = join(REPO_ROOT, 'scripts', 'merge-changelog.mjs');
const FIXTURES = join(REPO_ROOT, 'tests', 'fixtures', 'merge-changelog');

const temps: string[] = [];
const scratch = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  while (temps.length) rmSync(temps.pop() as string, { recursive: true, force: true });
});

/** Runs the driver the way git does: O=base, A=ours (result goes here), B=theirs. */
function drive(base: string, ours: string, theirs: string) {
  const dir = scratch('merge-changelog-');
  const [o, a, b] = ['base', 'ours', 'theirs'].map((n) => join(dir, `${n}.md`));
  writeFileSync(o, base);
  writeFileSync(a, ours);
  writeFileSync(b, theirs);
  const r = spawnSync('node', [DRIVER, o, a, b], { encoding: 'utf8' });
  return { status: r.status, stderr: r.stderr, result: readFileSync(a, 'utf8') };
}

const HEAD = '# Changelog\n\nAll notable changes.\n\n';
const V1 = '## [1.0.0] — 2026-01-01\n\n### Fixed\n\n- **Old fix.** Released long ago.\n\n';

describe('merge-changelog driver', () => {
  it('resolves the real 2.16.8 conflict exactly as it was resolved by hand', () => {
    const read = (n: string) => readFileSync(join(FIXTURES, '2.16.8', `${n}.md`), 'utf8');
    const r = drive(read('base'), read('ours'), read('theirs'));
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.result).toBe(read('expected'));
  });

  it('keeps the released section verbatim and moves every local-only entry, grouped, into a new Unreleased', () => {
    const base = `${HEAD}## [Unreleased]\n\n### Fixed\n\n- **A.** a\n\n${V1}`;
    const ours = `${HEAD}## [Unreleased]\n\n### Added\n\n- **New feature.** n\n\n### Fixed\n\n- **Local fix.** l\n- **A.** a\n\n${V1}`;
    const released = '## [1.1.0] — 2026-02-01\n\n### Fixed\n\n- **A.** a\n- **B.** b\n\n';
    const theirs = `${HEAD}${released}${V1}`;
    const r = drive(base, ours, theirs);
    expect(r.status).toBe(0);
    expect(r.result).toBe(
      `${HEAD}## [Unreleased]\n\n### Added\n\n- **New feature.** n\n\n### Fixed\n\n- **Local fix.** l\n\n${released}${V1}`,
    );
  });

  it('dedupes: an entry the release already carries, or one repeated locally, appears once or not at all', () => {
    const base = `${HEAD}## [Unreleased]\n\n${V1}`;
    const ours = `${HEAD}## [Unreleased]\n\n### Fixed\n\n- **Shipped.** s\n- **Mine.** m\n- **Mine.** m\n\n${V1}`;
    const released = '## [1.1.0] — 2026-02-01\n\n### Fixed\n\n- **Shipped.** s\n\n';
    const r = drive(base, ours, `${HEAD}${released}${V1}`);
    expect(r.status).toBe(0);
    expect(r.result).toBe(
      `${HEAD}## [Unreleased]\n\n### Fixed\n\n- **Mine.** m\n\n${released}${V1}`,
    );
  });

  it("keeps theirs' own post-release Unreleased entries and adds ours after them", () => {
    const base = `${HEAD}## [Unreleased]\n\n### Fixed\n\n- **A.** a\n\n${V1}`;
    const ours = `${HEAD}## [Unreleased]\n\n### Fixed\n\n- **A.** a\n- **Ours.** o\n\n${V1}`;
    const released = '## [1.1.0] — 2026-02-01\n\n### Fixed\n\n- **A.** a\n\n';
    const theirs = `${HEAD}## [Unreleased]\n\n### Changed\n\n- **Theirs.** t\n\n${released}${V1}`;
    const r = drive(base, ours, theirs);
    expect(r.status).toBe(0);
    expect(r.result).toBe(
      `${HEAD}## [Unreleased]\n\n### Changed\n\n- **Theirs.** t\n\n### Fixed\n\n- **Ours.** o\n\n${released}${V1}`,
    );
  });

  it("keeps theirs' subsection order as written, even when it is not Keep a Changelog order", () => {
    const base = `${HEAD}## [Unreleased]\n\n### Fixed\n\n- **F.** f\n\n### Removed\n\n- **R.** r\n\n${V1}`;
    const ours = `${HEAD}## [Unreleased]\n\n### Fixed\n\n- **F.** f\n- **Ours.** o\n\n### Removed\n\n- **R.** r\n\n${V1}`;
    const theirs = `${HEAD}## [Unreleased]\n\n### Fixed\n\n- **F.** f\n- **Theirs.** t\n\n### Removed\n\n- **R.** r\n\n${V1}`;
    const r = drive(base, ours, theirs);
    expect(r.status).toBe(0);
    expect(r.result).toBe(
      `${HEAD}## [Unreleased]\n\n### Fixed\n\n- **F.** f\n- **Theirs.** t\n- **Ours.** o\n\n### Removed\n\n- **R.** r\n\n${V1}`,
    );
  });

  it('keeps multi-line entries whole', () => {
    const base = `${HEAD}## [Unreleased]\n\n${V1}`;
    const entry = '- **Long.** first line\n  continued here\n  and here';
    const ours = `${HEAD}## [Unreleased]\n\n### Fixed\n\n${entry}\n\n${V1}`;
    const theirs = `${HEAD}## [Unreleased]\n\n${V1}`;
    const r = drive(base, ours, theirs);
    expect(r.status).toBe(0);
    expect(r.result).toBe(`${HEAD}## [Unreleased]\n\n### Fixed\n\n${entry}\n\n${V1}`);
  });

  it('takes theirs when our side changed nothing', () => {
    const base = `${HEAD}## [Unreleased]\n\n### Fixed\n\n- **A.** a\n\n${V1}`;
    const theirs = `${HEAD}## [1.1.0] — 2026-02-01\n\n### Fixed\n\n- **A.** a\n\n${V1}`;
    const r = drive(base, base, theirs);
    expect(r.status).toBe(0);
    expect(r.result).toBe(theirs);
  });

  describe('any other shape falls back to an ordinary conflict (non-zero exit, markers in %A)', () => {
    const base = `${HEAD}## [Unreleased]\n\n### Fixed\n\n- **A.** a\n\n${V1}`;
    const theirs = `${HEAD}## [1.1.0] — 2026-02-01\n\n### Fixed\n\n- **A.** a\n\n${V1}`;

    it('our side edited a released section', () => {
      const ours = `${HEAD}## [Unreleased]\n\n### Fixed\n\n- **A.** a\n\n${V1.replace('Released long ago.', 'Edited.')}`;
      const r = drive(base, ours, theirs.replace('Released long ago.', 'Also edited.'));
      expect(r.status).not.toBe(0);
      expect(r.result).toMatch(/^<<<<<<< /m);
      expect(r.result).toMatch(/^>>>>>>> /m);
    });

    it('our side reworded an Unreleased entry that the release also reworded', () => {
      const ours = `${HEAD}## [Unreleased]\n\n### Fixed\n\n- **A.** reworded\n\n${V1}`;
      const r = drive(base, ours, theirs.replace('- **A.** a', '- **A.** polished'));
      expect(r.status).not.toBe(0);
      expect(r.result).toMatch(/^<<<<<<< /m);
    });

    it('but a text merge git would complete cleanly stays clean, exactly as without the driver', () => {
      const ours = `${HEAD}## [Unreleased]\n\n### Fixed\n\n- **A.** reworded\n\n${V1}`;
      const r = drive(base, ours, theirs);
      expect(r.status).toBe(0);
      expect(r.result).toBe(theirs.replace('- **A.** a', '- **A.** reworded'));
    });

    it('both sides released a version', () => {
      const ours = `${HEAD}## [1.0.1] — 2026-01-15\n\n### Fixed\n\n- **A.** a\n\n${V1}`;
      const r = drive(base, ours, theirs);
      expect(r.status).not.toBe(0);
      expect(r.result).toMatch(/^<<<<<<< /m);
    });
  });

  it('as a registered driver, `git merge` of a release into diverged local work completes on its own', () => {
    const repo = scratch('merge-changelog-git-');
    const git = (...args: string[]) =>
      execFileSync(
        'git',
        [
          '-c',
          'user.name=t',
          '-c',
          'user.email=t@example.invalid',
          '-c',
          'commit.gpgsign=false',
          ...args,
        ],
        { cwd: repo, encoding: 'utf8', stdio: 'pipe' },
      );
    const read = (n: string) => readFileSync(join(FIXTURES, '2.16.8', `${n}.md`), 'utf8');
    git('init', '-q', '-b', 'main');
    mkdirSync(join(repo, 'scripts'));
    writeFileSync(join(repo, 'scripts', 'merge-changelog.mjs'), readFileSync(DRIVER));
    writeFileSync(join(repo, '.gitattributes'), 'CHANGELOG.md merge=monomind-changelog\n');
    writeFileSync(join(repo, 'CHANGELOG.md'), read('base'));
    git('add', '.');
    git('commit', '-qm', 'base');
    git('checkout', '-qb', 'release');
    writeFileSync(join(repo, 'CHANGELOG.md'), read('theirs'));
    git('commit', '-qam', 'chore(release): publish 2.16.8');
    git('checkout', '-q', 'main');
    writeFileSync(join(repo, 'CHANGELOG.md'), read('ours'));
    git('commit', '-qam', 'fix: local work');

    git(
      '-c',
      'merge.monomind-changelog.driver=node scripts/merge-changelog.mjs %O %A %B',
      'merge',
      '--no-edit',
      'release',
    );
    expect(readFileSync(join(repo, 'CHANGELOG.md'), 'utf8')).toBe(read('expected'));
    expect(git('status', '--porcelain')).toBe('');
  });
});
