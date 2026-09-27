// Split out of cap-documents.ts (file-size sweep). Pure move: no behaviour change.

// ── RTF text extraction (no dep) ───────────────────────────────────
// Skips destination groups ({\*\...}), extracts visible text, handles
// \'xx hex escapes, \par/\line/\tab, and ignores all other control words.
export function extractRtfText(content: string): string {
  let depth = 0;
  let skipDepth = 0;
  let result = '';
  let i = 0;
  while (i < content.length) {
    const ch = content[i];
    if (ch === '{') {
      depth++;
      // Check for destination group {\*\...} — skip entirely
      if (i + 2 < content.length && content[i + 1] === '\\' && content[i + 2] === '*') {
        skipDepth = depth;
      }
      i++;
      continue;
    }
    if (ch === '}') {
      if (depth === skipDepth) skipDepth = 0;
      depth = Math.max(0, depth - 1);
      i++;
      continue;
    }
    if (skipDepth > 0) {
      i++;
      continue;
    }
    if (ch === '\\') {
      i++;
      if (i >= content.length) break;
      const next = content[i];
      if (next === '\n' || next === '\r') {
        result += '\n';
        i++;
        continue;
      }
      // Escaped literal chars
      if (next === '{' || next === '}' || next === '\\') {
        result += next;
        i++;
        continue;
      }
      // Hex escape \'xx
      if (next === "'" && i + 2 < content.length) {
        const code = parseInt(content.substring(i + 1, i + 3), 16);
        if (!Number.isNaN(code)) result += String.fromCharCode(code);
        i += 3;
        continue;
      }
      // Control word: letter sequence + optional signed integer + optional trailing space
      let word = '';
      while (i < content.length && /[a-zA-Z]/.test(content[i])) {
        word += content[i];
        i++;
      }
      while (i < content.length && /[-\d]/.test(content[i])) i++;
      if (i < content.length && content[i] === ' ') i++;
      if (word === 'par' || word === 'line') result += '\n';
      else if (word === 'tab') result += '\t';
      continue;
    }
    result += ch;
    i++;
  }
  return result
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
