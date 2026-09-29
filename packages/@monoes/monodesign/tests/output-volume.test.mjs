// #424: detection flooded its output — hundreds of identical findings, false
// contrast failures on translucent/overlay backgrounds, and whole-file
// dry-run diffs. These pin the grouped report, unverified contrast, and
// line-level hunks.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { detectHtml, groupFindings } from '../cli/engine/detect-antipatterns.mjs';
import { unifiedDiff } from '../cli/engine/fix/index.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'bin', 'cli.js');

function tempHtml(html) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'monodesign-volume-'));
  const file = path.join(dir, 'index.html');
  fs.writeFileSync(file, html);
  return { dir, file };
}

const page = (css, body) =>
  `<!doctype html><html><head><style>${css}</style></head><body>${body}</body></html>`;

describe('groupFindings', () => {
  const f = (antipattern, snippet, line = 0, file = 'a.html', severity = 'warning') =>
    ({ antipattern, name: antipattern, description: 'd', severity, file, line, snippet });

  it('collapses (rule, snippet) duplicates with a count and deduped example locations', () => {
    const groups = groupFindings([
      f('low-contrast', '2:1 text #eee on #fff'),
      f('low-contrast', '2:1  text #eee on #fff '),
      f('low-contrast', '2:1 text #eee on #fff', 0, 'b.html'),
      f('low-contrast', '3:1 text #ccc on #fff'),
      f('tiny-text', '10px body text', 4),
    ]);
    assert.equal(groups.length, 3);
    const top = groups[0];
    assert.equal(top.antipattern, 'low-contrast');
    assert.equal(top.count, 3);
    assert.equal(top.fileCount, 2);
    assert.deepEqual(top.locations, [{ file: 'a.html' }, { file: 'b.html' }]);
    assert.deepEqual(groups[2].locations, [{ file: 'a.html', line: 4 }]);
  });

  it('orders by severity, keeps a rule together, and caps example locations', () => {
    const many = Array.from({ length: 10 }, (_, i) => f('tiny-text', '10px body text', i + 1));
    const groups = groupFindings(
      [f('overused-font', 'Inter', 0, 'a.html', 'advisory'), ...many, f('low-contrast', 'x'), f('low-contrast', 'y')],
      { maxLocations: 2 },
    );
    assert.deepEqual(groups.map(g => g.antipattern), ['tiny-text', 'low-contrast', 'low-contrast', 'overused-font']);
    assert.equal(groups[0].count, 10);
    assert.equal(groups[0].locations.length, 2);
  });
});

describe('detect CLI text output', () => {
  const rows = Array.from({ length: 25 }, (_, i) => `<p class="t">Faint paragraph ${'abcdefghijklmnopqrstuvwxy'[i]} here.</p>`).join('');
  const { dir, file } = tempHtml(page('body{background:#fff}.t{color:#eee;font-size:16px}', rows));
  const run = (...args) => spawnSync(process.execPath, [CLI, 'detect', '--no-config', ...args, file], {
    cwd: dir, encoding: 'utf-8', timeout: 30000,
  });

  it('prints one line per unique finding with its count by default', () => {
    const { stderr, status } = run();
    assert.equal(status, 2);
    assert.match(stderr, /×25 {2}1\.2:1 \(need 4\.5:1\) — text #eeeeee on #ffffff/);
    assert.equal(stderr.match(/text #eeeeee on #ffffff/g).length, 1);
    assert.match(stderr, /25 anti-patterns found \(1 unique\)/);
  });

  it('--no-group lists every occurrence', () => {
    const { stderr } = run('--no-group');
    assert.equal(stderr.match(/text #eeeeee on #ffffff/g).length, 25);
  });
});

describe('contrast on backgrounds the static analyser cannot resolve', () => {
  it('does not report translucent-overlay contrast as a failure', async () => {
    // White text on a 30%-black overlay above a dark hero: readable in a
    // browser, but statically the overlay is skipped and the fallback surface
    // is a guess.
    const { file } = tempHtml(page(
      '.hero{background:rgba(0,0,0,0.3);padding:24px}.hero p{color:#fff;font-size:16px}',
      '<div class="hero"><p>Readable headline on a dark photo overlay.</p></div>',
    ));
    const findings = await detectHtml(file, {});
    assert.equal(findings.filter(f => f.antipattern === 'low-contrast').length, 0);
    const all = await detectHtml(file, { includeUnverified: true });
    const hit = all.find(f => f.antipattern === 'low-contrast');
    assert.equal(hit?.unverified, true);
  });

  it('does not report translucent text as a definite failure', async () => {
    const { file } = tempHtml(page(
      'body{background:#fff}.t{color:rgba(230,230,230,0.9);font-size:16px}',
      '<p class="t">Faded helper copy on a white page.</p>',
    ));
    const findings = await detectHtml(file, {});
    assert.equal(findings.filter(f => f.antipattern === 'low-contrast').length, 0);
  });

  it('still reports opaque low contrast', async () => {
    const { file } = tempHtml(page(
      'body{background:#fff}.t{color:#eee;font-size:16px}',
      '<p class="t">Genuinely faint text on an opaque white page.</p>',
    ));
    const hit = (await detectHtml(file, {})).find(f => f.antipattern === 'low-contrast');
    assert.ok(hit);
    assert.equal(hit.unverified, undefined);
  });

  it('CLI hides unverified checks with a count, --include-unverified lists them', () => {
    const { dir, file } = tempHtml(page(
      '.hero{background:rgba(0,0,0,0.3);padding:24px}.hero p{color:#fff;font-size:16px}',
      '<div class="hero"><p>Readable headline on a dark photo overlay.</p></div>',
    ));
    const run = (...args) => spawnSync(process.execPath, [CLI, 'detect', '--no-config', ...args, file], {
      cwd: dir, encoding: 'utf-8', timeout: 30000,
    });
    const hidden = run();
    assert.equal(hidden.status, 0);
    assert.match(hidden.stderr, /1 contrast check could not be verified statically/);
    const shown = run('--json', '--include-unverified');
    assert.equal(shown.status, 2);
    assert.ok(JSON.parse(shown.stdout).some(f => f.antipattern === 'low-contrast' && f.unverified));
  });
});

describe('fix --dry-run diff', () => {
  it('emits one small hunk per distant edit instead of the whole span', () => {
    const before = Array.from({ length: 200 }, (_, i) => `.r${i} { font-size: 16px; }`);
    const after = before.slice();
    after[10] = '.r10 { font-size: 12px; }';
    after[190] = '.r190 { font-size: 12px; }';
    const diff = unifiedDiff(`${before.join('\n')}\n`, `${after.join('\n')}\n`, 'x.css');
    const hunks = diff.split('\n').filter(l => l.startsWith('@@'));
    assert.deepEqual(hunks, ['@@ -8,7 +8,7 @@', '@@ -188,7 +188,7 @@']);
    assert.equal(diff.split('\n').length, 20);
  });

  it('handles inserted and deleted lines', () => {
    const diff = unifiedDiff('a\nb\nc\nd\n', 'a\nx\nc\nd\ne\n', 'y.css');
    assert.equal(diff, '--- a/y.css\n+++ b/y.css\n@@ -1,4 +1,5 @@\n a\n-b\n+x\n c\n d\n+e');
  });
});
