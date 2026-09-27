// Building, inserting, and removing the injected live script-tag block in
// an HTML/JSX entry file, with line-ending-preserving splicing. Split out of
// live-inject.mjs (file-size sweep — pure move, no behaviour change).

const MARKER_OPEN_TEXT = 'monodesign-live-start';
const MARKER_CLOSE_TEXT = 'monodesign-live-end';
// Query param name live-server.mjs checks on every protected route.
const AUTH_QUERY_KEY = 'token';

function commentOpen(syntax) { return syntax === 'jsx' ? '{/*' : '<!--'; }
function commentClose(syntax) { return syntax === 'jsx' ? '*/}' : '-->'; }

function buildTagBlock(syntax, port, authCred, filePath) {
  const open = commentOpen(syntax);
  const close = commentClose(syntax);
  // Astro processes <script> tags by default and rewrites src to its own
  // bundled URL. is:inline opts out so the literal external src survives.
  const isAstro = typeof filePath === 'string' && filePath.endsWith('.astro');
  const scriptAttrs = isAstro ? 'is:inline ' : '';
  const authQuery = new URLSearchParams();
  authQuery.set(AUTH_QUERY_KEY, authCred);
  return (
    open + ' ' + MARKER_OPEN_TEXT + ' ' + close + '\n' +
    '<script ' + scriptAttrs + 'src="http://localhost:' + port + '/live.js?' + authQuery.toString() + '"></script>\n' +
    open + ' ' + MARKER_CLOSE_TEXT + ' ' + close + '\n'
  );
}

function detectLineEnding(content) {
  if (content.includes('\r\n')) return '\r\n';
  if (content.includes('\r')) return '\r';
  return '\n';
}

function normalizeLineEndings(content, lineEnding) {
  return lineEnding === '\n' ? content : content.replace(/\n/g, lineEnding);
}

function readLineEndingAt(content, index) {
  if (content[index] === '\r' && content[index + 1] === '\n') return '\r\n';
  if (content[index] === '\n') return '\n';
  if (content[index] === '\r') return '\r';
  return '';
}

function insertTag(content, config, port, authCred, filePath) {
  const lineEnding = detectLineEnding(content);
  const block = normalizeLineEndings(buildTagBlock(config.commentSyntax, port, authCred, filePath), lineEnding);
  // insertBefore: match the LAST occurrence. Anchors like `</body>` naturally
  // belong at the end, and the same literal can appear earlier in code blocks
  // within rendered documentation pages.
  if (config.insertBefore) {
    const idx = content.lastIndexOf(config.insertBefore);
    if (idx === -1) return content;
    return content.slice(0, idx) + block + content.slice(idx);
  }
  // insertAfter: match the FIRST occurrence — typical anchors like `<head>` or
  // `<body>` open near the top of the document.
  const idx = content.indexOf(config.insertAfter);
  if (idx === -1) return content;
  const after = idx + config.insertAfter.length;
  // Preserve an existing trailing newline if the anchor already has one.
  // Slice the remainder from the original anchor offset, not prefix.length:
  // in the no-newline case prefix is one char longer than the anchor (the
  // appended '\n'), so slicing by prefix.length would drop the first real
  // character after the anchor (#227).
  const existingNewline = readLineEndingAt(content, after);
  const prefix = content.slice(0, after) + (existingNewline || lineEnding);
  const rest = content.slice(after + existingNewline.length);
  return prefix + block + rest;
}

/**
 * Remove the live script block. Matches either HTML or JSX comment markers
 * regardless of config (so stale tags from a wrong config can still be cleaned).
 *
 * Indent-preserving: captures any whitespace immediately preceding the opener
 * marker and re-emits it in place of the removed block. `insertTag` inserted
 * the block *after* the original line's indent and *before* the anchor (e.g.
 * `</body>`), which moved the indent onto the opener line and left the anchor
 * unindented. Replacing the whole block (plus its trailing newline) with just
 * the captured indent hands the indent back to the anchor that follows.
 */
function removeTag(content, _syntax) {
  const patterns = [
    /([ \t]*)<!--\s*monodesign-live-start\s*-->[\s\S]*?<!--\s*monodesign-live-end\s*-->([ \t]*(?:\r\n|\n|\r|$)?)/,
    /([ \t]*)\{\/\*\s*monodesign-live-start\s*\*\/\}[\s\S]*?\{\/\*\s*monodesign-live-end\s*\*\/\}([ \t]*(?:\r\n|\n|\r|$)?)/,
  ];
  for (const pat of patterns) {
    let changed = false;
    let next = content;
    do {
      content = next;
      next = content.replace(pat, (_match, leadingIndent, trailing = '') => {
        if (/[\r\n]/.test(trailing)) return leadingIndent;
        return leadingIndent || trailing || '';
      });
      if (next !== content) changed = true;
    } while (next !== content);
    if (changed) return next;
  }
  return content;
}

export {
  commentOpen,
  commentClose,
  buildTagBlock,
  detectLineEnding,
  normalizeLineEndings,
  readLineEndingAt,
  insertTag,
  removeTag,
};
