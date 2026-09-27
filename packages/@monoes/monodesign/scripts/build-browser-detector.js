#!/usr/bin/env node
/**
 * Build the browser anti-pattern detector bundle.
 *
 * Concatenates the pure detection modules and the browser-injected UI into a
 * single IIFE that runs in any page (detector page, live overlay, extension).
 * Imports/exports are stripped because the bundle is a flat script, not a
 * module. From the registry only the `ANTIPATTERNS` array literal is inlined,
 * rebuilt from its per-category data modules (the browser path never uses the
 * registry helper functions).
 *
 * Output: cli/engine/detect-antipatterns-browser.js
 *
 * Run: node scripts/build-browser-detector.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(__dirname, '..');
const engineDir = path.join(pkgRoot, 'cli', 'engine');

// Source modules, in inline order. Each entry names the module and how to
// transform its raw source into flat script text.
const MODULES = [
  { rel: 'shared/constants.mjs', transform: stripImportsExports },
  { rel: 'registry/antipatterns.mjs', transform: extractAntipatternsArray },
  { rel: 'shared/color.mjs', transform: stripImportsExports },
  { rel: 'shared/fonts.mjs', transform: stripImportsExports },
  // rules/checks.mjs is only a barrel over these; inline them in source order.
  { rel: 'rules/checks-pure.mjs', transform: stripImportsExports },
  { rel: 'rules/checks-html.mjs', transform: stripImportsExports },
  { rel: 'rules/checks-background.mjs', transform: stripImportsExports },
  { rel: 'rules/checks-dom.mjs', transform: stripImportsExports },
  { rel: 'rules/checks-css-values.mjs', transform: stripImportsExports },
  { rel: 'rules/checks-dom-effects.mjs', transform: stripImportsExports },
  { rel: 'rules/checks-quality.mjs', transform: stripImportsExports },
  { rel: 'rules/checks-element.mjs', transform: stripImportsExports },
  { rel: 'rules/checks-page.mjs', transform: stripImportsExports },
  { rel: 'rules/checks-overflow.mjs', transform: stripImportsExports },
  { rel: 'rules/checks-stylesheet.mjs', transform: stripImportsExports },
  { rel: 'browser/injected/index.mjs', transform: stripImportsExports },
];

const HEADER = `/**
 * Anti-Pattern Browser Detector for Monodesign
 * Copyright (c) 2026 Paul Bakaus
 * SPDX-License-Identifier: Apache-2.0
 *
 * GENERATED -- do not edit. Source: cli/engine/browser/injected/index.mjs
 * Rebuild: node scripts/build-browser-detector.js
 *
 * Usage: <script src="detect-antipatterns-browser.js"></script>
 * Re-scan: window.monodesignScan()
 */
(function () {
if (typeof window === 'undefined') return;
`;

// Remove leading `import ... from '...';` statements (single- and multi-line)
// and any `export { ... };` blocks / `export ` declaration prefixes. Leaves a
// clean flat-script body with a single leading + trailing newline trimmed.
function stripImportsExports(src) {
  let out = src;
  // Multi-line or single-line import blocks.
  out = out.replace(/^import\s+[\s\S]*?from\s+['"][^'"]+['"];?\n/gm, '');
  out = out.replace(/^import\s+['"][^'"]+['"];?\n/gm, '');
  // Trailing (or inline) `export { ... };` blocks.
  out = out.replace(/^export\s*\{[\s\S]*?\};?\n?/gm, '');
  // `export const/function/class ...` → strip the keyword only.
  out = out.replace(/^export\s+(?=(const|let|var|function|class|async)\b)/gm, '');
  return trimBlankEdges(out);
}

// The registry's `ANTIPATTERNS` array is spread from per-category data
// modules, in this order. The bundle rebuilds the same array literal from
// their bodies — the browser bundle never calls the registry helper functions.
const ANTIPATTERN_CATEGORY_MODULES = [
  'registry/antipatterns-slop.mjs',
  'registry/antipatterns-quality.mjs',
  'registry/antipatterns-provider.mjs',
];

// Inline ONLY the `const ANTIPATTERNS = [ ... ];` array literal, assembled
// from each category module's array body.
function extractAntipatternsArray() {
  const bodies = ANTIPATTERN_CATEGORY_MODULES.map((rel) =>
    extractArrayBody(fs.readFileSync(path.join(engineDir, rel), 'utf-8'), rel),
  );
  return `const ANTIPATTERNS = [\n${bodies.join('\n\n')}\n];`;
}

// The body (lines between `= [` and the closing `];`) of a category module's
// single `const X = [ ... ];` array.
function extractArrayBody(src, rel) {
  const open = /const \w+ = \[\r?\n/.exec(src);
  if (!open) throw new Error(`antipattern array not found in ${rel}`);
  const start = open.index + open[0].length;
  // First line that is exactly `];` closes the array. Tolerate CRLF: a Windows
  // checkout with core.autocrlf=true hands this script \r\n, and an LF-only
  // pattern then finds no close and reports the array as malformed.
  const closeRe = /\r?\n\];\r?\n/g;
  closeRe.lastIndex = start;
  const m = closeRe.exec(src);
  if (!m) throw new Error(`antipattern array close not found in ${rel}`);
  return src.slice(start, m.index);
}

function trimBlankEdges(text) {
  return text.replace(/^\n+/, '').replace(/\n+$/, '');
}

let output = HEADER;
for (const mod of MODULES) {
  const abs = path.join(engineDir, mod.rel);
  const raw = fs.readFileSync(abs, 'utf-8');
  const body = mod.transform(raw);
  output += `// --- cli/engine/${mod.rel} ---\n${body}\n\n`;
}
output += '})();\n';

const outPath = path.join(engineDir, 'detect-antipatterns-browser.js');
// --check: fail (exit 1) when the committed bundle differs from what the
// sources build, instead of writing it. The bundle is what browsers run, so a
// stale one silently ships old detection logic.
if (process.argv.includes('--check')) {
  const current = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : '';
  if (current !== output) {
    console.error(`${outPath} is stale — run: node scripts/build-browser-detector.js`);
    process.exit(1);
  }
  console.log(`${outPath} is up to date`);
} else {
  fs.writeFileSync(outPath, output);
  console.log(`Wrote ${outPath} (${output.split('\n').length} lines)`);
}
