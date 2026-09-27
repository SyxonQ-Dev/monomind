/**
 * Scoped manual-edit-buffer cleanup for live-accept.mjs: after a variant
 * accept rewrites a wrapper, drop only staged copy-edit ops whose text
 * appeared inside that wrapper's original block.
 *
 * Split out of live-accept.mjs. See that file for context.
 */
import { readBuffer as readManualEditsBuffer, writeBuffer as writeManualEditsBuffer } from './live/manual-edits-buffer.mjs';

export function scrubManualEditsAgainstOriginalBlock(originalBlockText, cwd = process.cwd(), pageUrl = null) {
  const originalBlock = String(originalBlockText || '');
  if (!originalBlock) return;
  if (!pageUrl) return;
  const buffer = readManualEditsBuffer(cwd);
  if (buffer.entries.length === 0) return;
  let mutated = false;
  for (const entry of buffer.entries) {
    if (entry.pageUrl !== pageUrl) continue;
    const before = entry.ops.length;
    entry.ops = entry.ops.filter((op) => {
      return !manualEditOpAppearsInBlock(op, originalBlock);
    });
    if (entry.ops.length !== before) mutated = true;
  }
  buffer.entries = buffer.entries.filter((entry) => entry.ops.length > 0);
  if (mutated) writeManualEditsBuffer(cwd, buffer);
}

function manualEditOpAppearsInBlock(op, originalBlock) {
  const candidates = [op?.newText, op?.originalText]
    .filter((text) => typeof text === 'string' && text.length > 0);
  return candidates.some((text) => originalBlockHasExactManualText(originalBlock, text));
}

function originalBlockHasExactManualText(originalBlock, text) {
  const needle = normalizeManualEditText(text);
  if (!needle) return false;
  return manualEditTextSegments(originalBlock).some((segment) => segment === needle);
}

function manualEditTextSegments(source) {
  return String(source || '')
    .replace(/<[^>]*>/g, '\n')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '\n')
    .replace(/<!--[\s\S]*?-->/g, '\n')
    .split(/\n+/)
    .map(normalizeManualEditText)
    .filter(Boolean);
}

function normalizeManualEditText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

// Compatibility export for older tests/callers. The unsafe file-wide scrub was
// removed; callers must pass accepted original-block text for scoped cleanup.
export function scrubManualEditsAgainstFile(_targetFile, cwd = process.cwd(), originalBlockText = '', pageUrl = null) {
  return scrubManualEditsAgainstOriginalBlock(originalBlockText, cwd, pageUrl);
}
