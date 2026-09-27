/**
 * Accepting a chosen Svelte component variant back into route source for
 * live/svelte-component.mjs: restoring prop expressions, merging the
 * original element's top-level attributes, and splicing the markup (and any
 * baked CSS) into the source file.
 *
 * Split out of live/svelte-component.mjs. See that file for context.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  parseSvelteComponentFile,
  substitutePropsWithExprs,
} from './svelte-component-markup.mjs';
import {
  appendCssToSvelteStyle,
  bakeParamValuesInCss,
  sanitizeAcceptedSvelteCss,
} from './svelte-component-css.mjs';
import {
  removeSvelteComponentSession,
  resolveSourceFile,
} from './svelte-component-session.mjs';

export function inlineSvelteComponentAccept(manifest, variantNum, paramValues = null, cwd = process.cwd()) {
  const sourceFile = resolveSourceFile(manifest.sourceFile, cwd);
  const variantPath = path.join(cwd, manifest.componentDir, `v${variantNum}.svelte`);
  const resultBase = {
    file: manifest.sourceFile,
    sourceFile: manifest.sourceFile,
    previewMode: 'svelte-component',
    componentDir: manifest.componentDir,
    carbonize: false,
  };
  if (!fs.existsSync(variantPath)) {
    return { handled: false, error: `Variant ${variantNum} not found`, ...resultBase };
  }

  const { markup, cssLines } = parseSvelteComponentFile(fs.readFileSync(variantPath, 'utf-8'));
  if (manifest.mode === 'insert') {
    return inlineSvelteComponentInsertAccept({
      manifest,
      markup,
      cssLines,
      variantNum,
      paramValues,
      sourceFile,
      resultBase,
      cwd,
    });
  }

  const rootTag = matchOpeningTag(markup)?.tag || 'div';
  const contract = manifest.propContract || [];
  const mergedMarkup = mergeOriginalTopLevelAttrs(markup, manifest.originalMarkup || '');
  const restoredMarkup = substitutePropsWithExprs(mergedMarkup, contract)
    .split('\n')
    .map((line) => line.trimEnd());

  const sourceContent = fs.readFileSync(sourceFile, 'utf-8');
  const sourceLines = sourceContent.split('\n');
  const start = Number(manifest.sourceStartLine) - 1;
  const end = Number(manifest.sourceEndLine) - 1;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end >= sourceLines.length) {
    return { handled: false, error: `Invalid source line range for ${manifest.sourceFile}`, ...resultBase };
  }

  const indent = sourceLines[start].match(/^(\s*)/)?.[1] || '';
  const indentedMarkup = restoredMarkup.map((line) => {
    if (line.trim() === '') return '';
    return indent + line.trimStart();
  });

  let newLines = [
    ...sourceLines.slice(0, start),
    ...indentedMarkup,
    ...sourceLines.slice(end + 1),
  ];

  const sanitizedCss = sanitizeAcceptedSvelteCss(cssLines, variantNum, paramValues, rootTag);
  const bakedCss = bakeParamValuesInCss(sanitizedCss, paramValues);
  if (bakedCss.length > 0) {
    newLines = appendCssToSvelteStyle(newLines, bakedCss);
  }

  try {
    fs.writeFileSync(sourceFile, newLines.join('\n'), 'utf-8');
  } catch (err) {
    return { handled: false, error: `Failed to write Svelte source: ${err.message}`, ...resultBase };
  }
  removeSvelteComponentSession(manifest.id, cwd);

  return {
    handled: true,
    ...resultBase,
  };
}

function inlineSvelteComponentInsertAccept({
  manifest,
  markup,
  cssLines,
  variantNum,
  paramValues,
  sourceFile,
  resultBase,
  cwd,
}) {
  if (!svelteMarkupHasVisibleContent(markup)) {
    return { handled: false, error: 'Accepted Svelte insert variant is empty', ...resultBase };
  }
  if (/\bdata-monodesign-[\w-]*\s*=/.test(markup)) {
    return { handled: false, error: 'Accepted Svelte insert variant contains preview-only data-monodesign attributes', ...resultBase };
  }

  const rootTag = matchOpeningTag(markup)?.tag || 'div';
  const restoredMarkup = String(markup || '')
    .split('\n')
    .map((line) => line.trimEnd());
  const sourceContent = fs.readFileSync(sourceFile, 'utf-8');
  const sourceLines = sourceContent.split('\n');
  const insertIndex = Number(manifest.insertLine) - 1;
  if (!Number.isInteger(insertIndex) || insertIndex < 0 || insertIndex > sourceLines.length) {
    return { handled: false, error: `Invalid insert line for ${manifest.sourceFile}`, ...resultBase };
  }

  const nearbyLine = sourceLines[insertIndex] ?? sourceLines[insertIndex - 1] ?? '';
  const indent = nearbyLine.match(/^(\s*)/)?.[1] || '';
  const indentedMarkup = restoredMarkup.map((line) => {
    if (line.trim() === '') return '';
    return indent + line.trimStart();
  });

  let newLines = [
    ...sourceLines.slice(0, insertIndex),
    ...indentedMarkup,
    ...sourceLines.slice(insertIndex),
  ];

  const sanitizedCss = sanitizeAcceptedSvelteCss(cssLines, variantNum, paramValues, rootTag);
  const bakedCss = bakeParamValuesInCss(sanitizedCss, paramValues);
  if (bakedCss.length > 0) {
    newLines = appendCssToSvelteStyle(newLines, bakedCss);
  }

  try {
    fs.writeFileSync(sourceFile, newLines.join('\n'), 'utf-8');
  } catch (err) {
    return { handled: false, error: `Failed to write Svelte source: ${err.message}`, ...resultBase };
  }
  removeSvelteComponentSession(manifest.id, cwd);

  return {
    handled: true,
    ...resultBase,
  };
}

function svelteMarkupHasVisibleContent(markup) {
  const text = String(markup || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length > 0) return true;
  return /<(img|svg|canvas|video|audio|picture|input|button|select|textarea)\b/i.test(markup || '');
}

function mergeOriginalTopLevelAttrs(markup, originalMarkup) {
  const variantOpen = matchOpeningTag(markup);
  const originalOpen = matchOpeningTag(originalMarkup);
  if (!variantOpen || !originalOpen) return markup;
  if (variantOpen.tag.toLowerCase() !== originalOpen.tag.toLowerCase()) return markup;

  const variantAttrs = parseAttrSegments(variantOpen.attrs);
  const originalAttrs = parseAttrSegments(originalOpen.attrs);
  const additions = [];
  let attrs = variantOpen.attrs;

  const originalClass = originalAttrs.get('class');
  const variantClass = variantAttrs.get('class');
  if (originalClass && variantClass) {
    const merged = mergeStaticClassAttr(originalClass, variantClass);
    if (merged) {
      attrs = attrs.slice(0, variantClass.start) + merged + attrs.slice(variantClass.end);
      variantAttrs.set('class', { ...variantClass, raw: merged });
    }
  } else if (originalClass && !variantClass) {
    additions.push(originalClass.raw);
  }

  for (const [name, attr] of originalAttrs) {
    if (name === 'class') continue;
    if (!variantAttrs.has(name)) additions.push(attr.raw);
  }

  if (additions.length === 0 && attrs === variantOpen.attrs) return markup;
  const nextOpen = variantOpen.prefix
    + variantOpen.tag
    + attrs
    + additions.map((attr) => ` ${attr.trim()}`).join('')
    + variantOpen.close;
  return markup.slice(0, variantOpen.index) + nextOpen + markup.slice(variantOpen.index + variantOpen.raw.length);
}

function matchOpeningTag(markup) {
  const match = String(markup || '').match(/^(\s*<)([A-Za-z][\w:-]*)([^>]*?)(\/?>)/);
  if (!match) return null;
  return {
    raw: match[0],
    prefix: match[1],
    tag: match[2],
    attrs: match[3] || '',
    close: match[4],
    index: match.index || 0,
  };
}

function parseAttrSegments(attrs) {
  const out = new Map();
  const re = /([A-Za-z_:][\w:.-]*)(?:\s*=\s*(?:"[^"]*"|'[^']*'|\{[^}]*\}|[^\s"'>=]+))?/g;
  let match;
  while ((match = re.exec(attrs))) {
    const raw = match[0];
    const name = match[1];
    out.set(name, {
      name,
      raw,
      start: match.index,
      end: match.index + raw.length,
    });
  }
  return out;
}

function mergeStaticClassAttr(originalClass, variantClass) {
  const originalValue = originalClass.raw.match(/class\s*=\s*(["'])(.*?)\1/);
  const variantValue = variantClass.raw.match(/class\s*=\s*(["'])(.*?)\1/);
  if (!originalValue || !variantValue) return null;
  const quote = variantValue[1];
  const classes = [
    ...variantValue[2].split(/\s+/),
    ...originalValue[2].split(/\s+/),
  ].filter(Boolean);
  return `class=${quote}${[...new Set(classes)].join(' ')}${quote}`;
}
