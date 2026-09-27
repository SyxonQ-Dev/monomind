// live-wrap CLI arg parsing + buffered manual-edit reconciliation helpers.
// Split out of live-wrap.mjs (file-size sweep — pure move, no behaviour
// change).

import path from 'node:path';

function argVal(args, flag) {
  const prefix = `${flag}=`;
  for (const arg of args) {
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  }
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}

function pendingEntriesThatMayAffectWrap(entries, targetFile, originalLines, selectionStartLine, cwd) {
  const targetAbs = path.resolve(cwd, targetFile);
  return (entries || []).filter((entry) => {
    return (entry.ops || []).some((op) => {
      return manualEditMayAffectWrap(op, targetAbs, originalLines, selectionStartLine, cwd);
    });
  });
}

function manualEditMayAffectWrap(op, targetFile, originalLines, selectionStartLine, cwd) {
  const targetAbs = path.resolve(cwd, targetFile);
  if (manualEditHintFallsInsideSelection(op, targetAbs, originalLines, selectionStartLine, cwd)) return true;
  if (manualEditLocatorMatchesSelection(op, originalLines)) return true;
  if (typeof op?.originalText === 'string' && op.originalText.length > 0) {
    return originalLines.join('\n').includes(op.originalText);
  }
  return false;
}

function manualEditHintFallsInsideSelection(op, targetAbs, originalLines, selectionStartLine, cwd) {
  const hintFile = op?.sourceHint?.file;
  const hintedLine = Number(op?.sourceHint?.line);
  if (!hintFile || !Number.isFinite(hintedLine)) return false;
  const hintAbs = path.isAbsolute(hintFile) ? hintFile : path.resolve(cwd, hintFile);
  if (path.resolve(hintAbs) !== targetAbs) return false;
  const hintedIndex = hintedLine - 1 - selectionStartLine;
  return hintedIndex >= 0
    && hintedIndex < originalLines.length
    && typeof op?.originalText === 'string'
    && originalLines[hintedIndex].includes(op.originalText);
}

function manualEditLocatorMatchesSelection(op, originalLines) {
  if (!op || typeof op.originalText !== 'string' || op.originalText.length === 0) return false;
  return originalLines.some((line) => (
    line.includes(op.originalText) && lineMatchesManualEditLocator(line, op)
  ));
}

function applyBufferedManualEditToLines(originalLines, selectionStartLine, op) {
  if (
    !op
    || typeof op.originalText !== 'string'
    || op.originalText.length === 0
    || typeof op.newText !== 'string'
  ) {
    return { lines: originalLines, changed: false };
  }

  const replaceLine = (lineIndex) => ({
    lines: originalLines.map((line, index) => (
      index === lineIndex ? replaceOnce(line, op.originalText, op.newText) : line
    )),
    changed: true,
  });

  const hintedLine = Number(op.sourceHint?.line);
  if (Number.isFinite(hintedLine)) {
    const hintedIndex = hintedLine - 1 - selectionStartLine;
    if (hintedIndex >= 0 && hintedIndex < originalLines.length && originalLines[hintedIndex].includes(op.originalText)) {
      return replaceLine(hintedIndex);
    }
  }

  const locatorMatches = [];
  for (let index = 0; index < originalLines.length; index += 1) {
    const line = originalLines[index];
    if (!line.includes(op.originalText)) continue;
    if (!lineMatchesManualEditLocator(line, op)) continue;
    locatorMatches.push(index);
  }
  if (locatorMatches.length === 1) return replaceLine(locatorMatches[0]);

  const originalBlock = originalLines.join('\n');
  if (countOccurrences(originalBlock, op.originalText) === 1) {
    return {
      lines: replaceOnce(originalBlock, op.originalText, op.newText).split('\n'),
      changed: true,
    };
  }

  return { lines: originalLines, changed: false };
}

function lineMatchesManualEditLocator(line, op) {
  if (op.tag) {
    const tagRe = new RegExp(`<\\s*${escapeRegExp(op.tag)}(?=[\\s>/]|$)`, 'i');
    if (!tagRe.test(line)) return false;
  }

  if (op.elementId) {
    const id = escapeRegExp(op.elementId);
    const idRe = new RegExp(`\\bid\\s*=\\s*["']${id}["']`);
    if (!idRe.test(line)) return false;
  }

  const classes = Array.isArray(op.classes) ? op.classes.filter(Boolean) : [];
  for (const className of classes) {
    if (!line.includes(className)) return false;
  }

  return true;
}

function replaceOnce(value, needle, replacement) {
  const index = value.indexOf(needle);
  if (index === -1) return value;
  return value.slice(0, index) + replacement + value.slice(index + needle.length);
}

function countOccurrences(value, needle) {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  while (true) {
    index = value.indexOf(needle, index);
    if (index === -1) return count;
    count += 1;
    index += needle.length;
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export {
  argVal,
  pendingEntriesThatMayAffectWrap,
  manualEditMayAffectWrap,
  manualEditHintFallsInsideSelection,
  manualEditLocatorMatchesSelection,
  applyBufferedManualEditToLines,
  lineMatchesManualEditLocator,
  replaceOnce,
  countOccurrences,
  escapeRegExp,
};
