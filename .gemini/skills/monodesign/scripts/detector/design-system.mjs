import { resolveLengthPx } from './rules/checks.mjs';
import {
  parseFrontmatter,
  normalizeFontName,
  cssColorLabel,
  colorKey,
  parseDesignColor,
  normalizeDesignSystem,
  loadDesignSystemForCwd,
} from './design-system-parse.mjs';
import {
  isAllowedFont,
  isAllowedColorRaw,
  isAllowedRadiusRaw,
  isAllowedFontSizeRaw,
  checkSourceDesignSystem,
  collectStaticDesignSystemFindings,
} from './design-system-checks.mjs';

function canonicalDesignFindingKey(item) {
  if (!item?.antipattern?.startsWith?.('design-system-')) return null;
  const value = item.ignoreValue || item.value || '';
  if (item.antipattern === 'design-system-font') {
    const context = /google fonts/i.test(item.snippet || '') ? 'google-font' : 'font';
    const font = normalizeFontName(value);
    return font ? `${item.antipattern}:${context}:${font}` : null;
  }
  if (item.antipattern === 'design-system-color') {
    const parsed = parseDesignColor(value);
    if (parsed) return `${item.antipattern}:color:${colorKey(parsed)}`;
    const label = cssColorLabel(value).toLowerCase();
    return label ? `${item.antipattern}:color:${label}` : null;
  }
  if (item.antipattern === 'design-system-radius') {
    const px = resolveLengthPx(String(value || '').trim(), 16);
    if (px != null && Number.isFinite(px)) return `${item.antipattern}:radius:${Math.round(px * 100) / 100}`;
    const label = String(value || '').trim().toLowerCase();
    return label ? `${item.antipattern}:radius:${label}` : null;
  }
  if (item.antipattern === 'design-system-font-size') {
    const px = resolveLengthPx(String(value || '').trim(), 16);
    if (px != null && Number.isFinite(px)) return `${item.antipattern}:font-size:${Math.round(px * 100) / 100}`;
    const label = String(value || '').trim().toLowerCase();
    return label ? `${item.antipattern}:font-size:${label}` : null;
  }
  return null;
}

function mergeDesignSystemFindings(...groups) {
  const out = [];
  const seen = new Map();
  for (const group of groups) {
    for (const item of group || []) {
      const key = canonicalDesignFindingKey(item);
      if (key) {
        if (seen.has(key)) {
          const existing = out[seen.get(key)];
          if ((existing.line || 0) <= 0 && (item.line || 0) > 0) existing.line = item.line;
          continue;
        }
        seen.set(key, out.length);
      }
      out.push(item);
    }
  }
  return out;
}

function dedupeDesignFindings(findings) {
  const out = [];
  const seen = new Set();
  for (const item of findings) {
    const key = [
      item.antipattern,
      item.line || 0,
      normalizeFontName(item.ignoreValue || item.snippet || ''),
    ].join('\0');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}


export {
  parseFrontmatter,
  normalizeDesignSystem,
  loadDesignSystemForCwd,
  isAllowedFont,
  isAllowedColorRaw,
  isAllowedRadiusRaw,
  isAllowedFontSizeRaw,
  checkSourceDesignSystem,
  collectStaticDesignSystemFindings,
  mergeDesignSystemFindings,
  dedupeDesignFindings,
};
