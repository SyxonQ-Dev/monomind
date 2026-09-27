/**
 * CSS sanitization for accepted Svelte component variants in
 * live/svelte-component.mjs: stripping preview-only selectors, rewriting
 * `:scope`/`@scope` and param-conditional selectors down to the plain CSS
 * that lands in the route source's <style> block.
 *
 * Split out of live/svelte-component.mjs. See that file for context.
 */

export function appendCssToSvelteStyle(lines, cssLines) {
  const closeIdx = findLastStyleCloseLine(lines);
  const prepared = ['', ...cssLines.map((line) => (line.trim() === '' ? '' : `  ${line.trimStart()}`))];
  if (closeIdx === -1) {
    return [...lines, '', '<style>', ...prepared.slice(1), '</style>'];
  }
  return [
    ...lines.slice(0, closeIdx),
    ...prepared,
    ...lines.slice(closeIdx),
  ];
}

function findLastStyleCloseLine(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/<\/style\s*>/.test(lines[i])) return i;
  }
  return -1;
}

export function bakeParamValuesInCss(cssLines, paramValues) {
  if (!paramValues || Object.keys(paramValues).length === 0) return cssLines;
  return cssLines.map((line) => {
    let out = line;
    for (const [key, value] of Object.entries(paramValues)) {
      const varName = `--p-${key}`;
      out = out.replace(new RegExp(`var\\(${escapeRegExp(varName)}(?:,\\s*[^)]+)?\\)`, 'g'), String(value));
    }
    return out;
  });
}

export function sanitizeAcceptedSvelteCss(cssLines, variantNum, paramValues = null, rootTag = 'div') {
  const css = String((cssLines || []).join('\n'));
  if (!/data-monodesign-variant|monodesign-variant-ready/.test(css)) return cssLines;

  const rules = parseCssRules(css);
  const output = [];
  for (const rule of rules) {
    appendSanitizedCssRule(output, rule, variantNum, paramValues, rootTag);
  }
  return output.join('\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '');
}

function appendSanitizedCssRule(output, rule, variantNum, paramValues, rootTag) {
  const prelude = rule.prelude.trim();
  const body = rule.body.trim();
  if (!prelude || !body || /--monodesign-variant-ready\s*:/.test(body)) return;

  if (/^@scope\b/i.test(prelude)) {
    if (/data-monodesign-variant/.test(prelude) && !selectorHasVariant(prelude, variantNum)) return;
    const inner = parseCssRules(body);
    for (const innerRule of inner) {
      const rewrittenPrelude = rewriteAcceptedSvelteSelector(innerRule.prelude, variantNum, paramValues, rootTag, true);
      if (!rewrittenPrelude || /--monodesign-variant-ready\s*:/.test(innerRule.body)) continue;
      output.push(formatCssRule(rewrittenPrelude, innerRule.body.trim()));
    }
    return;
  }

  const rewrittenPrelude = rewriteAcceptedSvelteSelector(prelude, variantNum, paramValues, rootTag, false);
  if (!rewrittenPrelude) return;
  output.push(formatCssRule(rewrittenPrelude, body));
}

function parseCssRules(css) {
  const rules = [];
  const text = String(css || '');
  let i = 0;
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i])) i++;
    const preludeStart = i;
    while (i < text.length && text[i] !== '{') i++;
    if (i >= text.length) break;
    const prelude = text.slice(preludeStart, i).trim();
    i++;
    const bodyStart = i;
    let depth = 1;
    let quote = null;
    let comment = false;
    while (i < text.length && depth > 0) {
      const ch = text[i];
      const next = text[i + 1];
      if (comment) {
        if (ch === '*' && next === '/') {
          comment = false;
          i += 2;
          continue;
        }
        i++;
        continue;
      }
      if (quote) {
        if (ch === '\\') {
          i += 2;
          continue;
        }
        if (ch === quote) quote = null;
        i++;
        continue;
      }
      if (ch === '/' && next === '*') {
        comment = true;
        i += 2;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        i++;
        continue;
      }
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      i++;
    }
    const body = text.slice(bodyStart, Math.max(bodyStart, i - 1));
    if (prelude) rules.push({ prelude, body });
  }
  return rules;
}

function rewriteAcceptedSvelteSelector(prelude, variantNum, paramValues, rootTag, fromScope) {
  const selectors = splitSelectorList(prelude);
  const rewritten = [];
  for (const selector of selectors) {
    const next = rewriteAcceptedSvelteSelectorPart(selector, variantNum, paramValues, rootTag, fromScope);
    if (next) rewritten.push(next);
  }
  return rewritten.join(', ');
}

function rewriteAcceptedSvelteSelectorPart(selector, variantNum, paramValues, rootTag, fromScope) {
  let out = selector.trim();
  const hasVariant = /data-monodesign-variant/.test(out);
  if (hasVariant && !selectorHasVariant(out, variantNum)) return '';
  if (hasVariant) {
    out = out.replace(variantSelectorRegex(variantNum), '');
    out = out.replace(/\[data-monodesign-variant=(["']).*?\1\]/g, '');
  }

  const paramResult = rewriteParamSelectors(out, paramValues);
  if (!paramResult.keep) return '';
  out = paramResult.selector;

  out = out
    .replace(/:scope(?:\[[^\]]+\])?\s*>\s*/g, '')
    .replace(/:scope(?:\[[^\]]+\])?/g, rootTag || '')
    .replace(/\s+/g, ' ')
    .trim();

  out = out.replace(/^[>+~]\s*/, '').trim();
  if (!out && (hasVariant || fromScope)) return rootTag || ':global(*)';
  return out;
}

function rewriteParamSelectors(selector, paramValues) {
  let keep = true;
  const next = selector.replace(/\[data-p-([A-Za-z0-9_-]+)(?:=(["'])(.*?)\2)?\]/g, (_match, key, _quote, expected) => {
    if (!paramValues || !Object.hasOwn(paramValues, key)) return '';
    const actual = paramValues[key];
    if (expected != null && String(actual) !== String(expected)) {
      keep = false;
      return '';
    }
    if (expected == null && (actual === false || actual == null || actual === 'false' || actual === 'off' || actual === '0')) {
      keep = false;
      return '';
    }
    return '';
  });
  return { keep, selector: next };
}

function splitSelectorList(prelude) {
  const selectors = [];
  let start = 0;
  let bracket = 0;
  let paren = 0;
  let quote = null;
  for (let i = 0; i < prelude.length; i++) {
    const ch = prelude[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '[') bracket++;
    else if (ch === ']') bracket = Math.max(0, bracket - 1);
    else if (ch === '(') paren++;
    else if (ch === ')') paren = Math.max(0, paren - 1);
    else if (ch === ',' && bracket === 0 && paren === 0) {
      selectors.push(prelude.slice(start, i));
      start = i + 1;
    }
  }
  selectors.push(prelude.slice(start));
  return selectors;
}

function selectorHasVariant(selector, variantNum) {
  return variantSelectorRegex(variantNum).test(selector);
}

function variantSelectorRegex(variantNum) {
  return new RegExp(`\\[data-monodesign-variant=(["'])${escapeRegExp(String(variantNum))}\\1\\]`, 'g');
}

function formatCssRule(selector, body) {
  return `${selector} { ${body.trim()} }`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
