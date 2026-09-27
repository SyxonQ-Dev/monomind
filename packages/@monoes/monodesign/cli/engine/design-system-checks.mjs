// Design-system enforcement: is-this-value-allowed checks, regex source
// scanning, and static-DOM (computed style) findings collection. Split out
// of design-system.mjs (file-size sweep — pure move, no behaviour change).

import { finding } from './findings.mjs';
import { GENERIC_FONTS } from './shared/constants.mjs';
import { resolveLengthPx } from './rules/checks.mjs';
import {
  primaryFont,
  colorsClose,
  parseDesignColor,
  cssColorLabel,
  normalizeFontName,
  FONT_SIZE_LITERAL_RE,
} from './design-system-parse.mjs';
import { dedupeDesignFindings } from './design-system.mjs';

const RADIUS_TOLERANCE_PX = 0.5;
const FONT_SIZE_TOLERANCE_PX = 0.5;

const CSS_COLOR_RE = /#[0-9a-f]{3,8}\b|rgba?\([^)]+\)|oklch\([^)]+\)|hsla?\([^)]+\)/gi;
const FONT_DECL_RE = /font-family\s*:\s*([^;}\n]+)/gi;
const FONT_JS_RE = /fontFamily\s*[:=]\s*["'`]([^"'`]+)["'`]/g;
const GOOGLE_FONT_RE = /fonts\.googleapis\.com\/css2?\?[^"'\s)<>]*/gi;
const BORDER_RADIUS_RE = /border-radius\s*:\s*([^;}\n]+)/gi;
const BORDER_RADIUS_JS_RE = /borderRadius\s*[:=]\s*["'`]([^"'`]+)["'`]/g;
const FONT_SIZE_DECL_RE = /font-size\s*:\s*([^;}\n]+)/gi;
const FONT_SIZE_JS_RE = /fontSize\s*[:=]\s*["'`]([^"'`]+)["'`]/g;
const TAILWIND_FONT_SIZE_RE = /\btext-\[(-?[\d.]+(?:px|rem))\]/g;
const STATIC_DESIGN_SKIP_TAGS = new Set(['head', 'title', 'meta', 'link', 'style', 'script', 'noscript', 'template', 'source']);

function isAllowedFont(font, designSystem) {
  if (!font || GENERIC_FONTS.has(font)) return true;
  if (!designSystem?.hasFonts) return true;
  return designSystem.allowedFonts.has(font);
}

function isAllowedColorRaw(raw, designSystem) {
  if (!designSystem?.hasColors) return true;
  const text = String(raw || '').trim().toLowerCase();
  if (!text || text === 'transparent' || text === 'currentcolor' || text === 'inherit' || text === 'initial') return true;
  if (text.includes('var(')) return true;
  const parsed = parseDesignColor(text);
  if (!parsed) return true;
  if ((parsed.a ?? 1) <= 0.05) return true;
  for (const entry of designSystem.allowedColorKeys.values()) {
    if (colorsClose(parsed, entry.color)) return true;
  }
  return false;
}

function isAllowedRadiusRaw(raw, designSystem) {
  if (!designSystem?.hasRadii) return true;
  const text = String(raw || '').trim().toLowerCase();
  if (!text || text === '0' || text === 'none' || text === 'initial' || text === 'inherit') return true;
  if (text.includes('var(') || text.includes('%')) return true;
  const px = resolveLengthPx(text, 16);
  if (px == null || !Number.isFinite(px) || px <= RADIUS_TOLERANCE_PX) return true;
  if (designSystem.hasPillRadius && px >= 99) return true;
  return designSystem.allowedRadii.some(entry => Math.abs(entry.px - px) <= RADIUS_TOLERANCE_PX);
}

function isAllowedFontSizeRaw(raw, designSystem) {
  if (!designSystem?.hasFontSizes) return true;
  const text = String(raw || '').trim().toLowerCase().replace(/\s*!important\s*$/, '');
  if (!FONT_SIZE_LITERAL_RE.test(text)) return true;
  const px = resolveLengthPx(text, 16);
  if (px == null || !Number.isFinite(px) || px <= 0) return true;
  return designSystem.allowedFontSizes.some(
    entry => Math.abs(entry.px - px) <= FONT_SIZE_TOLERANCE_PX,
  );
}

function lineLooksCommented(line) {
  const trimmed = String(line || '').trim();
  return trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed.startsWith('<!--');
}

function isProbablyColorLiteral(line, match) {
  const raw = match?.[0] || '';
  const index = match.index ?? -1;
  if (index < 0) return false;
  if (isInsideCssAttributeSelector(line, index)) return false;

  const before = line.slice(0, index);
  const after = line.slice(index + raw.length);

  if (raw.startsWith('#')) {
    if (before.endsWith('&')) return false; // HTML numeric entity, e.g. &#8596;

    const prevNonSpace = before.match(/\S(?=\s*$)/)?.[0] || '';
    const nextNonSpace = after.match(/^\s*(\S)/)?.[1] || '';
    if (prevNonSpace === '>' && nextNonSpace === '<') return false; // plain text, e.g. PR #155
  }

  const styleContext = /(?:^|[{\s;"'`(,])(?:color|background(?:-color|-image)?|border(?:-(?:top|right|bottom|left))?(?:-color)?|outline(?:-color)?|box-shadow|text-shadow|fill|stroke)\s*:\s*[^;{}"'`]*/i.test(before);
  const cssFunctionContext = /(?:linear-gradient|radial-gradient|conic-gradient|color-mix)\([^)]*$/i.test(before);
  const jsColorKeyContext = /(?:^|[,{]\s*)(?:color|background|backgroundColor|borderColor|outlineColor|fill|stroke|boxShadow|textShadow)\s*[:=]\s*["'`]?[^"'`,}]*/i.test(before);

  return styleContext || cssFunctionContext || jsColorKeyContext;
}

function isInsideCssAttributeSelector(line, index) {
  if (index < 0) return false;
  const before = line.slice(0, index);
  const lastOpen = before.lastIndexOf('[');
  if (lastOpen === -1) return false;
  const lastClose = before.lastIndexOf(']');
  if (lastClose > lastOpen) return false;
  const after = line.slice(index);
  const close = after.indexOf(']');
  const block = after.indexOf('{');
  return close !== -1 && (block === -1 || close < block);
}

function makeDesignFinding(id, filePath, snippet, line = 0, extras = {}) {
  return { ...finding(id, filePath, snippet, line), ...extras };
}

function decodeGoogleFamily(value) {
  const family = String(value || '').split(':')[0].replace(/\+/g, ' ');
  try {
    return decodeURIComponent(family);
  } catch {
    return family;
  }
}

function checkFontStack(stack, filePath, line, designSystem, context) {
  const primary = primaryFont(stack);
  if (!primary || isAllowedFont(primary, designSystem)) return [];
  const display = primary.replace(/\b\w/g, ch => ch.toUpperCase());
  return [makeDesignFinding(
    'design-system-font',
    filePath,
    `${context}: ${display} is not declared in DESIGN.md typography`,
    line,
    { ignoreValue: display },
  )];
}

function extractRadiusTokens(value) {
  return String(value || '')
    .replace(/\s*\/\s*/g, ' ')
    .split(/\s+/)
    .map(token => token.trim())
    .filter(Boolean);
}

function checkRadiusValue(value, filePath, line, designSystem, context) {
  const findings = [];
  for (const token of extractRadiusTokens(value)) {
    if (isAllowedRadiusRaw(token, designSystem)) continue;
    findings.push(makeDesignFinding(
      'design-system-radius',
      filePath,
      `${context}: ${token} is outside the DESIGN.md rounded scale`,
      line,
      { ignoreValue: token },
    ));
  }
  return findings;
}

function checkFontSizeValue(value, filePath, line, designSystem, context) {
  const token = String(value || '').trim();
  if (isAllowedFontSizeRaw(token, designSystem)) return [];
  return [makeDesignFinding(
    'design-system-font-size',
    filePath,
    `${context}: ${token} is off the DESIGN.md type ramp`,
    line,
    { ignoreValue: token },
  )];
}

function checkSourceDesignSystem(content, filePath, options = {}) {
  const designSystem = options.designSystem;
  if (!designSystem?.present) return [];

  const findings = [];
  const lines = String(content || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    if (lineLooksCommented(line)) continue;

    if (designSystem.hasFonts) {
      for (const match of line.matchAll(FONT_DECL_RE)) {
        findings.push(...checkFontStack(match[1], filePath, lineNum, designSystem, 'font-family'));
      }
      for (const match of line.matchAll(FONT_JS_RE)) {
        findings.push(...checkFontStack(match[1], filePath, lineNum, designSystem, 'fontFamily'));
      }
      for (const match of line.matchAll(GOOGLE_FONT_RE)) {
        const url = match[0];
        for (const familyMatch of url.matchAll(/[?&]family=([^&]+)/g)) {
          const font = normalizeFontName(decodeGoogleFamily(familyMatch[1]));
          if (!font || isAllowedFont(font, designSystem)) continue;
          const display = decodeGoogleFamily(familyMatch[1]);
          findings.push(makeDesignFinding(
            'design-system-font',
            filePath,
            `Google Fonts: ${display} is not declared in DESIGN.md typography`,
            lineNum,
            { ignoreValue: display },
          ));
        }
      }
    }

    if (designSystem.hasColors) {
      for (const match of line.matchAll(CSS_COLOR_RE)) {
        if (!isProbablyColorLiteral(line, match)) continue;
        const raw = cssColorLabel(match[0]);
        if (isAllowedColorRaw(raw, designSystem)) continue;
        findings.push(makeDesignFinding(
          'design-system-color',
          filePath,
          `Undocumented color ${raw} is outside DESIGN.md colors`,
          lineNum,
          { ignoreValue: raw },
        ));
      }
    }

    if (designSystem.hasRadii) {
      for (const match of line.matchAll(BORDER_RADIUS_RE)) {
        findings.push(...checkRadiusValue(match[1], filePath, lineNum, designSystem, 'border-radius'));
      }
      for (const match of line.matchAll(BORDER_RADIUS_JS_RE)) {
        findings.push(...checkRadiusValue(match[1], filePath, lineNum, designSystem, 'borderRadius'));
      }
    }

    if (designSystem.hasFontSizes) {
      for (const match of line.matchAll(FONT_SIZE_DECL_RE)) {
        findings.push(...checkFontSizeValue(match[1], filePath, lineNum, designSystem, 'font-size'));
      }
      for (const match of line.matchAll(FONT_SIZE_JS_RE)) {
        findings.push(...checkFontSizeValue(match[1], filePath, lineNum, designSystem, 'fontSize'));
      }
      for (const match of line.matchAll(TAILWIND_FONT_SIZE_RE)) {
        findings.push(...checkFontSizeValue(match[1], filePath, lineNum, designSystem, 'text-[…] class'));
      }
    }
  }

  return dedupeDesignFindings(findings);
}

function hasDirectText(el) {
  return Array.from(el.childNodes || []).some(node => node.nodeType === 3 && node.textContent.trim().length > 0);
}

function sampleText(el) {
  const text = String(el.textContent || '').replace(/\s+/g, ' ').trim();
  return text ? ` "${text.slice(0, 40)}"` : '';
}

// Font-size design-system checks are source-scan-only (see checkSourceDesignSystem).
// Computed font-size cascades and clamp() ramps resolve to off-ramp px in the browser.
function collectStaticDesignSystemFindings(document, window, filePath, designSystem) {
  if (!designSystem?.present) return [];
  const findings = [];
  const seenFonts = new Set();
  const seenColors = new Set();
  const seenRadii = new Set();

  for (const el of document.querySelectorAll('*')) {
    if (shouldSkipStaticDesignElement(el, window)) continue;
    const tag = el.tagName?.toLowerCase?.() || 'unknown';
    const style = window.getComputedStyle(el);

    if (designSystem.hasFonts && hasDirectText(el)) {
      const font = primaryFont(style.fontFamily || '');
      if (font && !seenFonts.has(font) && !isAllowedFont(font, designSystem)) {
        seenFonts.add(font);
        findings.push(makeDesignFinding(
          'design-system-font',
          filePath,
          `${tag}${sampleText(el)} uses ${font}; not declared in DESIGN.md typography`,
          0,
          { ignoreValue: font },
        ));
      }
    }

    if (designSystem.hasColors) {
      const colorChecks = [];
      if (hasDirectText(el)) colorChecks.push(['text color', style.color]);
      if (!isTransparentCss(style.backgroundColor)) colorChecks.push(['background', style.backgroundColor]);
      for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
        if ((parseFloat(style[`border${side}Width`]) || 0) > 0) {
          colorChecks.push([`border-${side.toLowerCase()}`, style[`border${side}Color`]]);
        }
      }
      if ((parseFloat(style.outlineWidth) || 0) > 0) colorChecks.push(['outline', style.outlineColor]);

      for (const [kind, raw] of colorChecks) {
        const label = cssColorLabel(raw);
        if (isAllowedColorRaw(label, designSystem)) continue;
        const key = `${kind}:${label}`;
        if (seenColors.has(key)) continue;
        seenColors.add(key);
        findings.push(makeDesignFinding(
          'design-system-color',
          filePath,
          `${kind} ${label} on ${tag}${sampleText(el)} is outside DESIGN.md colors`,
          0,
          { ignoreValue: label },
        ));
      }
    }

    if (designSystem.hasRadii) {
      const rawRadius = String(style.borderRadius || '').trim();
      if (!rawRadius) continue;
      for (const token of extractRadiusTokens(rawRadius)) {
        if (isAllowedRadiusRaw(token, designSystem)) continue;
        if (seenRadii.has(token)) continue;
        seenRadii.add(token);
        findings.push(makeDesignFinding(
          'design-system-radius',
          filePath,
          `border-radius ${token} on ${tag}${sampleText(el)} is outside the DESIGN.md rounded scale`,
          0,
          { ignoreValue: token },
        ));
      }
    }
  }

  return findings;
}

function shouldSkipStaticDesignElement(el, window) {
  const tag = el.tagName?.toLowerCase?.() || '';
  if (STATIC_DESIGN_SKIP_TAGS.has(tag)) return true;

  let current = el;
  while (current) {
    if (current.getAttribute?.('hidden') !== null || current.getAttribute?.('aria-hidden') === 'true') return true;
    const style = window.getComputedStyle(current);
    const display = String(style.display || '').toLowerCase();
    const visibility = String(style.visibility || '').toLowerCase();
    if (display === 'none' || visibility === 'hidden' || visibility === 'collapse') return true;
    current = current.parentElement;
  }
  return false;
}

function isTransparentCss(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text || text === 'transparent') return true;
  const parsed = parseDesignColor(text);
  return parsed ? (parsed.a ?? 1) <= 0.05 : false;
}


export {
  isAllowedFont,
  isAllowedColorRaw,
  isAllowedRadiusRaw,
  isAllowedFontSizeRaw,
  lineLooksCommented,
  isProbablyColorLiteral,
  isInsideCssAttributeSelector,
  makeDesignFinding,
  decodeGoogleFamily,
  checkFontStack,
  extractRadiusTokens,
  checkRadiusValue,
  checkFontSizeValue,
  checkSourceDesignSystem,
  hasDirectText,
  sampleText,
  collectStaticDesignSystemFindings,
  shouldSkipStaticDesignElement,
  isTransparentCss,
};
