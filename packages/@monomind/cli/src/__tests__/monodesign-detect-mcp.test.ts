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
      findings: Array<{ antipattern: string }>;
    };
    expect(res.findings.map((f) => f.antipattern)).toContain('low-contrast');
  }, 60_000);

  it('flags low contrast in inline HTML, labelled with the virtual path', async () => {
    const res = (await detect.handler({ content: LOW_CONTRAST, filePath: 'inline/page.html' })) as {
      findings: Array<{ antipattern: string; file: string }>;
    };
    const hit = res.findings.find((f) => f.antipattern === 'low-contrast');
    expect(hit?.file).toBe('inline/page.html');
  }, 60_000);
});
