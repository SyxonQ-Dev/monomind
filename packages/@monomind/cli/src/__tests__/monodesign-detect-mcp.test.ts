/**
 * #353: monodesign_detect ran the regex text engine on HTML, so every
 * cascade-dependent finding (contrast, computed sizes) was missing where
 * `monodesign detect` reported it. HTML now goes through the static-HTML
 * engine like the CLI — for a file target and for inline content.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { monodesignTools } from '../mcp-tools/monodesign-tools.js';

const LOW_CONTRAST =
  '<!doctype html><html><head><style>body{background:#fff}.t{color:#eee;font-size:14px}</style></head>' +
  '<body><p class="t">Low contrast text the cascade-aware engine must flag.</p></body></html>';

const detect = monodesignTools.find((t) => t.name === 'monodesign_detect');
if (!detect) throw new Error('monodesign_detect tool not registered');

const dir = mkdtempSync(join(tmpdir(), 'monodesign-detect-mcp-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('monodesign_detect uses the HTML engine for HTML (#353)', () => {
  it('flags low contrast in an HTML file target', async () => {
    const file = join(dir, 'page.html');
    writeFileSync(file, LOW_CONTRAST);
    const res = (await detect.handler({ target: file })) as {
      count: number;
      groups: Array<{ antipattern: string }>;
    };
    expect(res.groups.map((g) => g.antipattern)).toContain('low-contrast');
  }, 60_000);

  it('flags low contrast in inline HTML, labelled with the virtual path', async () => {
    const res = (await detect.handler({
      content: LOW_CONTRAST,
      filePath: 'inline/page.html',
      verbose: true,
    })) as {
      findings: Array<{ antipattern: string; file: string }>;
    };
    const hit = res.findings.find((f) => f.antipattern === 'low-contrast');
    expect(hit?.file).toBe('inline/page.html');
  }, 60_000);
});

type Grouped = {
  count: number;
  uniqueCount: number;
  groups: Array<{ antipattern: string; count: number; locations: string[] }>;
  more?: string;
  unverified?: number;
};

describe('monodesign_detect groups and caps its response (#424)', () => {
  it('collapses repeated findings into one group with a count', async () => {
    const rows = Array.from(
      { length: 30 },
      () => '<p class="t">Faint repeated paragraph.</p>',
    ).join('');
    const html = LOW_CONTRAST.replace('</body>', `${rows}</body>`);
    const res = (await detect.handler({ content: html, filePath: 'rows.html' })) as Grouped;
    const contrast = res.groups.filter((g) => g.antipattern === 'low-contrast');
    expect(contrast).toHaveLength(1);
    expect(contrast[0].count).toBe(31);
    expect(contrast[0].locations).toEqual(['rows.html']);
    expect(res.count).toBeGreaterThanOrEqual(31);
  }, 60_000);

  it('caps grouped output at 20 groups and points at the next page', async () => {
    // 25 distinct text colours → 25 distinct low-contrast groups.
    const css = Array.from(
      { length: 25 },
      (_, i) => `.c${i}{color:#e${(i % 10).toString()}e${(i % 16).toString(16)}ee;font-size:14px}`,
    ).join('');
    const body = Array.from(
      { length: 25 },
      (_, i) => `<p class="c${i}">Faint text variant.</p>`,
    ).join('');
    const html = `<!doctype html><html><head><style>body{background:#fff}${css}</style></head><body>${body}</body></html>`;
    const res = (await detect.handler({ content: html, filePath: 'many.html' })) as Grouped;
    expect(res.uniqueCount).toBeGreaterThan(20);
    expect(res.groups).toHaveLength(20);
    expect(res.more).toContain('offset=20');
    const next = (await detect.handler({
      content: html,
      filePath: 'many.html',
      offset: 20,
    })) as Grouped;
    expect(next.groups).toHaveLength(res.uniqueCount - 20);
    expect(next.more).toBeUndefined();
  }, 60_000);

  it('does not count contrast on a translucent overlay as a failure', async () => {
    const html =
      '<!doctype html><html><head><style>.hero{background:rgba(0,0,0,0.3);padding:24px}.hero p{color:#fff;font-size:16px}</style></head>' +
      '<body><div class="hero"><p>Readable headline on a dark photo overlay.</p></div></body></html>';
    const res = (await detect.handler({ content: html, filePath: 'hero.html' })) as Grouped;
    expect(res.groups.map((g) => g.antipattern)).not.toContain('low-contrast');
    expect(res.unverified).toBe(1);
    const all = (await detect.handler({
      content: html,
      filePath: 'hero.html',
      include_unverified: true,
    })) as Grouped;
    expect(all.groups.map((g) => g.antipattern)).toContain('low-contrast');
  }, 60_000);
});
