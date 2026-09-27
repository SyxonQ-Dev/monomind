// live-wrap element search: locating the target file and the element's
// start/end lines in its source. Split out of live-wrap.mjs (file-size
// sweep — pure move, no behaviour change).

import fs from 'node:fs';
import path from 'node:path';
import { isGeneratedFile } from './lib/is-generated.mjs';

const EXTENSIONS = ['.html', '.jsx', '.tsx', '.vue', '.svelte', '.astro'];

/**
 * Search project files for the query string (class name, ID, etc.)
 * Returns the first matching file path, or null.
 */
function findFileWithQuery(query, cwd, genOpts = {}) {
  const searchDirs = ['src', 'app', 'pages', 'components', 'public', 'views', 'templates', '.'];
  const seen = new Set();

  for (const dir of searchDirs) {
    const absDir = path.join(cwd, dir);
    if (!fs.existsSync(absDir)) continue;
    const result = searchDir(absDir, query, seen, 0, genOpts);
    if (result) return result;
  }
  return null;
}

function searchDir(dir, query, seen, depth, genOpts) {
  if (depth > 5) return null; // don't go too deep
  const realDir = fs.realpathSync(dir);
  if (seen.has(realDir)) return null;
  seen.add(realDir);

  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return null; }

  // Check files first
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!EXTENSIONS.includes(ext)) continue;

    const filePath = path.join(dir, entry.name);
    if (!genOpts.includeGenerated && isGeneratedFile(filePath, genOpts)) continue;
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      if (content.includes(query)) return filePath;
    } catch { /* skip unreadable files */ }
  }

  // Then recurse into directories. Always skip node_modules and .git (never
  // project content). dist/build/out are left to the isGeneratedFile guard so
  // the includeGenerated second-pass can still find the element there and
  // report `generatedMatch`.
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const result = searchDir(path.join(dir, entry.name), query, seen, depth + 1, genOpts);
    if (result) return result;
  }

  return null;
}

/**
 * Regex that matches a tag opener on a line. Allows the tag name to be
 * followed by whitespace, `>`, `/`, or end-of-line so that multi-line JSX
 * openers (e.g. `<section\n  className="..."\n>`) are recognised.
 */
const OPENER_RE = /<([A-Za-z][A-Za-z0-9]*)(?=[\s/>]|$)/;

/**
 * Find the element's start and end line in the file.
 *
 * `query` is a class name, attribute fragment (`class="..."`, `className="..."`,
 * `id="..."`), or a raw text snippet. Because a query can appear on a
 * continuation line of a multi-line tag (e.g. the `className="..."` row of a
 * `<section\n  className="..."\n>` JSX tag), we walk backward from the match
 * line to find the actual tag opener. When `tag` is provided, opener candidates
 * must match that tag name.
 */
/**
 * Return the smallest leading-whitespace count across a set of lines,
 * ignoring blank lines (whose indent isn't load-bearing). Used to compute
 * the common base indent of a multi-line picked element so reindenting
 * under the wrapper preserves the relative depth between lines.
 */
function minLeadingSpaces(lines) {
  let min = Infinity;
  for (const l of lines) {
    if (l.trim() === '') continue;
    const m = l.match(/^(\s*)/);
    if (m && m[1].length < min) min = m[1].length;
  }
  return min === Infinity ? 0 : min;
}

function findElement(lines, query, tag = null) {
  // Iterate all matches — the first substring hit isn't always the right one.
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes(query)) continue;

    const stripped = lines[i].trim();
    if (stripped.startsWith('<!--') || stripped.startsWith('{/*') || stripped.startsWith('//')) continue;
    // Skip lines already inside a variant wrapper
    if (lines[i].includes('data-monodesign-variant')) continue;

    const openerLine = findOpenerLine(lines, i, tag);
    if (openerLine === -1) continue;

    const endLine = findClosingLine(lines, openerLine);
    return { startLine: openerLine, endLine };
  }

  return null;
}

/**
 * Like findElement, but returns every match. Used for ambiguity detection
 * when the agent passes --text: when the same className appears on multiple
 * sibling elements (a list of cards, repeated section variants, etc.),
 * first-match silently lands on the wrong branch. Returning all matches lets
 * the caller narrow by textContent or fail with a structured ambiguity error.
 */
function findAllElements(lines, query, tag = null) {
  const out = [];
  const seen = new Set();
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes(query)) continue;
    const stripped = lines[i].trim();
    if (stripped.startsWith('<!--') || stripped.startsWith('{/*') || stripped.startsWith('//')) continue;
    if (lines[i].includes('data-monodesign-variant')) continue;
    const openerLine = findOpenerLine(lines, i, tag);
    if (openerLine === -1) continue;
    if (seen.has(openerLine)) continue; // multiple matches inside the same element
    seen.add(openerLine);
    const endLine = findClosingLine(lines, openerLine);
    out.push({ startLine: openerLine, endLine });
  }
  return out;
}

/**
 * Narrow a candidate set to those whose source body matches a meaningful
 * prefix of the picked element's textContent. The compare strips tags and
 * JSX expressions, then checks two whitespace normalizations side-by-side:
 *
 *   - single-space ("hero two second card body")
 *   - no-whitespace ("herotwosecondcardbody")
 *
 * Both are needed because `el.textContent` concatenates sibling text without
 * inserting whitespace (e.g. `<h1>Hero Two</h1><p>Second…</p>` reads as
 * `"Hero TwoSecond…"`), while the source has whitespace between tags. If
 * EITHER normalization matches, the candidate keeps. A snippet shorter than
 * 8 chars after stripping is too weak to disambiguate — the caller falls
 * back to first-match.
 */
function filterByText(candidates, lines, text) {
  const trimmed = text.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 80);
  // Too short to disambiguate. Return [] so the caller's `filtered.length
  // === 0` branch fires (fall back to first-match) — the previous
  // `candidates.slice()` return forced `filtered.length > 1` and surfaced
  // a spurious `element_ambiguous` error on every short-text picker event
  // with multiple candidates.
  if (trimmed.length < 8) return [];
  const targetSpaced = trimmed;
  const targetCompact = trimmed.replace(/\s+/g, '');

  return candidates.filter((c) => {
    const body = lines.slice(c.startLine, c.endLine + 1).join(' ');
    const inner = body
      .replace(/<[^>]*>/g, ' ')   // strip HTML/JSX tags
      .replace(/\{[^}]*\}/g, ' ')  // strip JSX expressions
      .toLowerCase();
    const sourceSpaced = inner.replace(/\s+/g, ' ').trim();
    const sourceCompact = inner.replace(/\s+/g, '');
    return sourceSpaced.includes(targetSpaced) || sourceCompact.includes(targetCompact);
  });
}

/**
 * Resolve a match line to the real tag opener. If the match line itself opens
 * a tag, return it. Otherwise walk up to 10 lines backward looking for the
 * first tag opener. If `tag` is specified, the opener must match that tag
 * name; an opener with a different tag name aborts the backward walk for this
 * match (we don't jump across element boundaries).
 *
 * Returns the line index of the opener, or -1 if none can be resolved.
 */
function findOpenerLine(lines, matchLine, tag) {
  const self = lines[matchLine].match(OPENER_RE);
  if (self) {
    if (!tag || self[1] === tag) return matchLine;
    return -1;
  }
  const MAX_BACKWALK = 10;
  for (let i = matchLine - 1; i >= Math.max(0, matchLine - MAX_BACKWALK); i--) {
    const opener = lines[i].match(OPENER_RE);
    if (!opener) continue;
    if (!tag || opener[1] === tag) return i;
    // Different tag name than requested — abort; we're inside a non-target opener.
    return -1;
  }
  return -1;
}

/**
 * Starting from a line with an opening tag, find the line with the matching
 * closing tag by counting tag nesting depth.
 */
function findClosingLine(lines, start) {
  const openMatch = lines[start].match(OPENER_RE);
  if (!openMatch) return start; // caller passed a non-opener; nothing to span

  const tagName = openMatch[1];
  let depth = 0;
  const openRe = new RegExp(`<${tagName}(?=[\\s/>]|$)`, 'g');
  const selfCloseRe = new RegExp(`<${tagName}[^>]*/>`, 'g');
  const closeRe = new RegExp(`</${tagName}\\s*>`, 'g');

  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    const opens = (line.match(openRe) || []).length;
    const selfCloses = (line.match(selfCloseRe) || []).length;
    const closes = (line.match(closeRe) || []).length;

    depth += opens - selfCloses - closes;

    if (depth <= 0) return i;
  }

  // If we can't find the close, return a reasonable guess
  return Math.min(start + 50, lines.length - 1);
}

export {
  findFileWithQuery,
  searchDir,
  OPENER_RE,
  minLeadingSpaces,
  findElement,
  findAllElements,
  filterByText,
  findOpenerLine,
  findClosingLine,
};
