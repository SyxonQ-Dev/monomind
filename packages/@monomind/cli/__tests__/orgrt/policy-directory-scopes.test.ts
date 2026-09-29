// packages/@monomind/cli/__tests__/orgrt/policy-directory-scopes.test.ts
/**
 * #492: a fileWrite/fileRead entry with no glob characters names a directory
 * (or file) and grants that path AND everything beneath it. Before the fix
 * such an entry was matched as a glob, i.e. only the exact path, so every
 * file inside `…/growth/site` was denied while the deny message told the role
 * it "may use …/growth/site".
 */
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OrgBus } from '../../src/orgrt/bus.js';
import { PolicyEngine } from '../../src/orgrt/policy.js';
import { missingScopePathWarnings } from '../../src/orgrt/policy-paths.js';

const REAL_TMPDIR = realpathSync(tmpdir());
const scratch = (prefix: string) => realpathSync(mkdtempSync(join(REAL_TMPDIR, prefix)));
const mkBus = () => new OrgBus('o', 'r', scratch('pds-bus-'));
const msg = (d: { behavior: string; message?: string }) => (d.behavior === 'deny' ? d.message : '');

let prevHome: string | undefined;
afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  prevHome = undefined;
});

/** A growth-shaped layout outside the org workdir: `site`, its shared-prefix
 *  sibling `site-old`, and a nested file. */
function growth() {
  const cwd = scratch('pds-cwd-');
  const base = scratch('pds-growth-');
  const site = join(base, 'site');
  mkdirSync(join(site, 'blog', 'posts'), { recursive: true });
  mkdirSync(join(base, 'site-old'), { recursive: true });
  writeFileSync(join(site, 'index.html'), '<html/>\n');
  writeFileSync(join(site, 'blog', 'posts', 'a.md'), '# a\n');
  writeFileSync(join(base, 'site-old', 'index.html'), '<html/>\n');
  return { cwd, base, site };
}

describe('#492 — absolute directory scope (the issue shape: a bare absolute directory)', () => {
  it('allows a file directly inside it, a deeper nested file, and the directory itself', async () => {
    const { cwd, site } = growth();
    const p = new PolicyEngine('site-seo', { fileWrite: [site] }, mkBus(), cwd);
    expect((await p.decide('Write', { file_path: join(site, 'index.html'), content: 'x' })).behavior).toBe(
      'allow',
    );
    expect(
      (await p.decide('Edit', { file_path: join(site, 'blog', 'posts', 'a.md'), old_string: 'a', new_string: 'b' }))
        .behavior,
    ).toBe('allow');
    expect((await p.decide('Write', { file_path: join(site, 'new', 'deep', 'f.css'), content: 'x' })).behavior).toBe(
      'allow',
    );
    // The directory itself (a Grep rooted at it, under the matching read scope).
    const r = new PolicyEngine('site-seo', { fileRead: [site] }, mkBus(), cwd);
    expect((await r.decide('Grep', { path: site, pattern: 'x' })).behavior).toBe('allow');
  });

  it('denies a sibling that shares the prefix (site-old vs site)', async () => {
    const { cwd, base, site } = growth();
    const p = new PolicyEngine('site-seo', { fileWrite: [site] }, mkBus(), cwd);
    const d = await p.decide('Write', { file_path: join(base, 'site-old', 'index.html'), content: 'x' });
    expect(d.behavior).toBe('deny');
    const d2 = await p.decide('Write', { file_path: `${site}-old`, content: 'x' });
    expect(d2.behavior).toBe('deny');
  });

  it('a trailing slash on the entry means the same directory', async () => {
    const { cwd, site } = growth();
    const p = new PolicyEngine('site-seo', { fileWrite: [`${site}/`] }, mkBus(), cwd);
    expect((await p.decide('Write', { file_path: join(site, 'index.html'), content: 'x' })).behavior).toBe(
      'allow',
    );
  });

  it('read scope behaves the same', async () => {
    const { cwd, base, site } = growth();
    const p = new PolicyEngine('analyst', { fileRead: [site] }, mkBus(), cwd);
    expect((await p.decide('Read', { file_path: join(site, 'blog', 'posts', 'a.md') })).behavior).toBe('allow');
    expect((await p.decide('Glob', { path: site, pattern: '**/*.md' })).behavior).toBe('allow');
    expect((await p.decide('Read', { file_path: join(base, 'site-old', 'index.html') })).behavior).toBe('deny');
  });

  it('a symlink inside the directory scope that points outside it is denied', async () => {
    const { cwd, site } = growth();
    const outside = scratch('pds-outside-');
    writeFileSync(join(outside, 'secret.txt'), 'nope\n');
    symlinkSync(outside, join(site, 'esc'));
    const p = new PolicyEngine('site-seo', { fileWrite: [site], fileRead: [site] }, mkBus(), cwd);
    expect((await p.decide('Read', { file_path: join(site, 'esc', 'secret.txt') })).behavior).toBe('deny');
    expect((await p.decide('Write', { file_path: join(site, 'esc', 'new.txt'), content: 'x' })).behavior).toBe(
      'deny',
    );
  });

  it('a fileToolDenied path inside a directory scope is still denied', async () => {
    prevHome = process.env.HOME;
    const home = scratch('pds-home-');
    process.env.HOME = home;
    mkdirSync(join(home, '.ssh'), { recursive: true });
    writeFileSync(join(home, '.ssh', 'id_rsa'), 'FAKE-KEY\n');
    const cwd = scratch('pds-cwd-');
    const p = new PolicyEngine('coder', { fileRead: [home], fileWrite: [home] }, mkBus(), cwd);
    expect((await p.decide('Read', { file_path: join(home, '.ssh', 'id_rsa') })).behavior).toBe('deny');
    expect((await p.decide('Write', { file_path: join(home, '.bashrc'), content: 'x' })).behavior).toBe('deny');
    // …while an ordinary file in the same directory scope is allowed.
    expect((await p.decide('Write', { file_path: join(home, 'notes.txt'), content: 'x' })).behavior).toBe('allow');
  });

  it('the .git write check still applies inside a directory scope', async () => {
    const { cwd, site } = growth();
    mkdirSync(join(site, '.git'), { recursive: true });
    const p = new PolicyEngine('site-seo', { fileWrite: [site] }, mkBus(), cwd);
    const d = await p.decide('Write', { file_path: join(site, '.git', 'config'), content: 'x' });
    expect(d.behavior).toBe('deny');
  });
});

describe('#492 — relative directory scope', () => {
  it('resolves against the org workdir and grants everything beneath it', async () => {
    const cwd = scratch('pds-cwd-');
    mkdirSync(join(cwd, 'reports', '2026', 'q3'), { recursive: true });
    mkdirSync(join(cwd, 'reports-old'), { recursive: true });
    const p = new PolicyEngine('analyst', { fileWrite: ['reports'], fileRead: ['./reports'] }, mkBus(), cwd);
    expect((await p.decide('Write', { file_path: 'reports/summary.md', content: 'x' })).behavior).toBe('allow');
    expect((await p.decide('Write', { file_path: join(cwd, 'reports', '2026', 'q3', 'a.md'), content: 'x' })).behavior).toBe(
      'allow',
    );
    expect((await p.decide('Read', { file_path: 'reports/2026/q3/a.md' })).behavior).toBe('allow');
    expect((await p.decide('Grep', { path: 'reports', pattern: 'x' })).behavior).toBe('allow');
    expect((await p.decide('Write', { file_path: 'reports-old/a.md', content: 'x' })).behavior).toBe('deny');
    expect((await p.decide('Write', { file_path: 'other.md', content: 'x' })).behavior).toBe('deny');
  });

  it('a relative directory entry that escapes every root is still refused', async () => {
    const cwd = scratch('pds-cwd-');
    const p = new PolicyEngine('analyst', { fileWrite: ['..'] }, mkBus(), cwd);
    const d = await p.decide('Write', { file_path: join(cwd, '..', 'x.md'), content: 'x' });
    expect(d.behavior).toBe('deny');
  });
});

describe('#492 — glob entries keep their glob semantics', () => {
  it('a relative glob still matches only what the glob says', async () => {
    const cwd = scratch('pds-cwd-');
    mkdirSync(join(cwd, 'src', 'deep'), { recursive: true });
    const p = new PolicyEngine('coder', { fileWrite: ['src/*.ts'] }, mkBus(), cwd);
    expect((await p.decide('Write', { file_path: 'src/a.ts', content: 'x' })).behavior).toBe('allow');
    expect((await p.decide('Write', { file_path: 'src/deep/a.ts', content: 'x' })).behavior).toBe('deny');
    expect((await p.decide('Write', { file_path: 'src/a.js', content: 'x' })).behavior).toBe('deny');
  });

  it('an absolute glob still matches only what the glob says', async () => {
    const { cwd, site } = growth();
    const p = new PolicyEngine('site-seo', { fileWrite: [`${site}/*.html`] }, mkBus(), cwd);
    expect((await p.decide('Write', { file_path: join(site, 'index.html'), content: 'x' })).behavior).toBe('allow');
    expect((await p.decide('Write', { file_path: join(site, 'blog', 'posts', 'a.md'), content: 'x' })).behavior).toBe(
      'deny',
    );
  });
});

describe('#492 — the deny message says how each scope entry matches', () => {
  it('labels a bare path as a directory grant and a wildcard entry as a glob', async () => {
    const { cwd, base, site } = growth();
    const p = new PolicyEngine('site-seo', { fileWrite: [site, 'src/**/*.ts'] }, mkBus(), cwd);
    // Inside the workdir but outside every scope entry: the scope deny.
    const d = await p.decide('Write', { file_path: 'notes.md', content: 'x' });
    expect(d.behavior).toBe('deny');
    expect(msg(d)).toContain(`${site} (directory: this path and everything beneath it)`);
    expect(msg(d)).toContain('src/**/*.ts (glob)');
    // Outside every root: the root deny also names the absolute directory grant.
    const e = await p.decide('Write', { file_path: join(base, 'site-old', 'index.html'), content: 'x' });
    expect(e.behavior).toBe('deny');
    expect(msg(e)).toContain(`write scope also grants ${site} (directory: this path and everything beneath it)`);
  });
});

describe('#492 — org validate warns about a missing bare scope path', () => {
  it('warns for an absolute non-glob entry that does not exist, and only for that', () => {
    const { site } = growth();
    const missing = join(site, 'nope');
    const w = missingScopePathWarnings([
      { id: 'seo', policy: { fileWrite: [site, missing, `${missing}/**`, 'relative/dir'], fileRead: [missing] } },
    ]);
    expect(w).toHaveLength(2);
    expect(w[0]).toContain(`role "seo": policy.fileWrite entry ${missing} does not exist`);
    expect(w[1]).toContain('policy.fileRead');
  });
});
