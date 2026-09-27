import { parseRgb } from '../shared/color.mjs';
import {
  checkBorders,
  isEmojiOnlyText,
  checkColors,
  HEADING_TAGS,
  checkIconTile,
  checkItalicSerif,
  checkHeroEyebrow,
  checkRepeatedSectionKickers,
  checkMotion,
  checkGlow,
} from './checks-pure.mjs';
import {
  readOwnBackgroundColor,
  resolveBackground,
  resolveGradientStops,
  resolveBorderRadiusPx,
} from './checks-background.mjs';
import { resolveVarRefs, parseColorResolved } from './checks-css-values.mjs';
import { collectRepeatedSectionKickerCandidates } from './checks-dom-effects.mjs';
import {
  resolveFontSizePx,
  resolveLengthPx,
  checkQuality,
} from './checks-quality.mjs';

function checkElementQualityDOM(el) {
  const tag = el.tagName.toLowerCase();
  const style = getComputedStyle(el);
  const hasDirectText = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim().length > 10);
  const textLen = el.textContent?.trim().length || 0;
  // Browser getComputedStyle resolves everything to px — direct parseFloat
  // works.
  const fontSize = parseFloat(style.fontSize) || 16;
  const lineHeightPx = resolveLengthPx(style.lineHeight, fontSize);
  const letterSpacingPx = resolveLengthPx(style.letterSpacing, fontSize);
  const rect = el.getBoundingClientRect();
  const lineMax = (typeof window !== 'undefined' && window.__MONODESIGN_CONFIG__?.lineLengthMax) || 80;
  const viewportWidth = (typeof window !== 'undefined' ? window.innerWidth : 0) || 0;
  return checkQuality({ el, tag, style, hasDirectText, textLen, fontSize, lineHeightPx, letterSpacingPx, rect, lineMax, viewportWidth, win: typeof window !== 'undefined' ? window : null });
}

// Pure page-level skipped-heading walk. Takes a Document so it works in both
// the browser and jsdom.
function checkPageQualityFromDoc(doc) {
  const findings = [];
  const headings = doc.querySelectorAll('h1, h2, h3, h4, h5, h6');
  let prevLevel = 0;
  let prevText = '';
  for (const h of headings) {
    const level = parseInt(h.tagName[1], 10);
    const text = (h.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60);
    if (prevLevel > 0 && level > prevLevel + 1) {
      findings.push({
        id: 'skipped-heading',
        snippet: `<h${prevLevel}> "${prevText}" followed by <h${level}> "${text}" (missing h${prevLevel + 1})`,
      });
    }
    prevLevel = level;
    prevText = text;
  }
  return findings;
}

// Browser adapter (returns the legacy { type, detail } shape used by the overlay loop)
function checkPageQualityDOM() {
  return checkPageQualityFromDoc(document).map(f => ({ type: f.id, detail: f.snippet }));
}

// Node adapters — take pre-extracted jsdom computed style

// jsdom doesn't lay out OR resolve em/rem/% to px — so we pre-resolve every
// CSS length the rule needs ourselves (walking the parent chain for
// font-size inheritance), and pass `rect: null` to skip the two rules that
// genuinely need element rects (line-length, cramped-padding).
function checkElementQuality(el, style, tag, window) {
  const hasDirectText = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim().length > 10);
  const textLen = el.textContent?.trim().length || 0;
  const fontSize = resolveFontSizePx(el, window);
  const lineHeightPx = resolveLengthPx(style.lineHeight, fontSize);
  const letterSpacingPx = resolveLengthPx(style.letterSpacing, fontSize);
  return checkQuality({ el, tag, style, hasDirectText, textLen, fontSize, lineHeightPx, letterSpacingPx, rect: null, win: window });
}

function checkElementBorders(tag, style, overrides, resolvedRadius) {
  const sides = ['Top', 'Right', 'Bottom', 'Left'];
  const widths = {}, colors = {};
  for (const s of sides) {
    widths[s] = parseFloat(style[`border${s}Width`]) || 0;
    colors[s] = style[`border${s}Color`] || '';
    // jsdom silently drops any border shorthand containing var(), leaving
    // both width and color empty on the computed style. When the detectHtml
    // pre-pass pulled a resolved value off the rule, use it to fill in the
    // missing side so the side-tab check can run. Real browsers resolve
    // var() natively, so this fallback is a no-op in the browser path.
    if (widths[s] === 0 && overrides && overrides[s]) {
      widths[s] = overrides[s].width;
      colors[s] = overrides[s].color;
    } else if (colors[s]?.startsWith('var(') && overrides?.[s]) {
      // Longhand case: jsdom kept the width but left the color as the
      // literal `var(...)` string. Substitute the resolved color.
      colors[s] = overrides[s].color;
    }
  }
  // resolvedRadius lets the caller pre-resolve the radius via
  // resolveBorderRadiusPx so the value survives jsdom 29.1.0's broken
  // shorthand serialization. Falls back to the computed value for tests
  // and browser callers that don't pre-resolve.
  const radius = resolvedRadius != null
    ? resolvedRadius
    : (parseFloat(style.borderRadius) || 0);
  return checkBorders(tag, widths, colors, radius);
}

function checkElementColors(el, style, tag, window, customPropMap, hasAnchorInheritRule) {
  const directText = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('');
  const hasDirectText = directText.trim().length > 0;

  const effectiveBg = resolveBackground(el, window, customPropMap);
  // jsdom returns literal "var(--X)" / "oklch(...)" for color, so plain
  // parseRgb misses Tailwind-tokenized text colors. Resolve through the
  // customPropMap first; fall back to parseRgb for vanilla rgb() pages.
  let textColor = customPropMap ? parseColorResolved(style.color, customPropMap) : null;
  if (!textColor) textColor = parseRgb(style.color);

  // Anchor-inherit FP workaround: jsdom's UA stylesheet has `:link { color:
  // blue }` at high specificity. The page's `a { color: inherit }` rule
  // (Tailwind v4 preflight) loses to jsdom even though it WINS in real
  // browsers (Chrome's UA wraps :link in :where() — zero specificity).
  // When the page declares the inherit rule AND we see jsdom's default
  // link blue on an anchor, walk to the nearest non-anchor ancestor and
  // use its color instead.
  if (
    hasAnchorInheritRule &&
    textColor &&
    textColor.r === 0 && textColor.g === 0 && textColor.b === 238 &&
    (tag === 'a' || el.closest?.('a'))
  ) {
    let cur = el.parentElement;
    while (cur && cur.tagName !== 'HTML') {
      if (cur.tagName !== 'A') {
        const ps = window.getComputedStyle(cur);
        const inh = (customPropMap ? parseColorResolved(ps.color, customPropMap) : null) || parseRgb(ps.color);
        if (inh && !(inh.r === 0 && inh.g === 0 && inh.b === 238)) {
          textColor = inh;
          break;
        }
      }
      cur = cur.parentElement;
    }
  }

  return checkColors({
    tag,
    textColor,
    bgColor: readOwnBackgroundColor(el, style),
    effectiveBg,
    effectiveBgStops: effectiveBg ? null : resolveGradientStops(el, window),
    fontSize: parseFloat(style.fontSize) || 16,
    fontWeight: parseInt(style.fontWeight, 10) || 400,
    hasDirectText,
    isEmojiOnly: isEmojiOnlyText(directText),
    bgClip: style.webkitBackgroundClip || style.backgroundClip || '',
    bgImage: style.backgroundImage || '',
    classList: el.getAttribute?.('class') || el.className || '',
  });
}

function checkElementIconTile(el, tag, window) {
  if (!HEADING_TAGS.has(tag)) return [];
  const sibling = el.previousElementSibling;
  if (!sibling) return [];

  const sibStyle = window.getComputedStyle(sibling);
  // jsdom doesn't lay out — read explicit pixel dimensions from CSS instead.
  const sibWidth = parseFloat(sibStyle.width) || 0;
  const sibHeight = parseFloat(sibStyle.height) || 0;

  const iconChild = sibling.querySelector('svg, i[data-lucide], i[class*="fa-"], i[class*="icon"]');
  let iconWidth = 0;
  if (iconChild) {
    const iconStyle = window.getComputedStyle(iconChild);
    iconWidth = parseFloat(iconStyle.width) || parseFloat(iconChild.getAttribute('width')) || 0;
  }
  // Or: tile contains an emoji/symbol character directly as its only content
  const sibDirectText = [...sibling.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('');
  const hasInlineEmojiIcon = sibling.children.length === 0 && isEmojiOnlyText(sibDirectText);

  return checkIconTile({
    headingTag: tag,
    headingText: el.textContent || '',
    headingTop: 0, // jsdom: no layout, skip vertical-stacking gate
    siblingTag: sibling.tagName.toLowerCase(),
    siblingWidth: sibWidth,
    siblingHeight: sibHeight,
    siblingBottom: 0,
    siblingBgColor: parseRgb(sibStyle.backgroundColor),
    siblingBgImage: sibStyle.backgroundImage || '',
    siblingBorderWidth: parseFloat(sibStyle.borderTopWidth) || 0,
    siblingBorderRadius: resolveBorderRadiusPx(sibling, sibStyle, sibWidth, window),
    hasIconChild: !!iconChild || hasInlineEmojiIcon,
    iconChildWidth: iconWidth,
  });
}

function checkElementItalicSerif(el, style, tag) {
  if (tag !== 'h1' && tag !== 'h2') return [];
  return checkItalicSerif({
    tag,
    fontStyle: style.fontStyle || '',
    fontFamily: style.fontFamily || '',
    fontSize: parseFloat(style.fontSize) || 0,
    headingText: el.textContent || '',
  });
}

function checkElementHeroEyebrow(el, style, tag, window, customPropMap) {
  if (tag !== 'h1') return [];
  const sibling = el.previousElementSibling;
  if (!sibling) return [];
  const sibStyle = window.getComputedStyle(sibling);
  // Resolve Tailwind v4 CSS-variable wrappers (font-weight:var(--font-weight-bold)
  // etc.) before parsing. jsdom returns these verbatim from getComputedStyle;
  // without resolution every style-based gate fails silently on Tailwind v4 builds.
  const fontSizeRaw = customPropMap ? resolveVarRefs(sibStyle.fontSize, customPropMap) : sibStyle.fontSize;
  const fontWeightRaw = customPropMap ? resolveVarRefs(sibStyle.fontWeight, customPropMap) : sibStyle.fontWeight;
  const letterSpacingRaw = customPropMap ? resolveVarRefs(sibStyle.letterSpacing, customPropMap) : sibStyle.letterSpacing;
  const colorRaw = customPropMap ? resolveVarRefs(sibStyle.color, customPropMap) : sibStyle.color;
  const headingFontSizeRaw = customPropMap ? resolveVarRefs(style.fontSize, customPropMap) : style.fontSize;
  const siblingFontSize = parseFloat(fontSizeRaw) || 0;
  // resolveLengthPx returns null for 'normal' / 'auto'; coerce to 0 so the
  // gate falls through cleanly. jsdom returns letter-spacing verbatim
  // (e.g. '0.15em'), unlike real browsers, so this conversion is required.
  return checkHeroEyebrow({
    headingTag: tag,
    headingText: el.textContent || '',
    headingFontSize: parseFloat(headingFontSizeRaw) || 0,
    siblingTag: sibling.tagName.toLowerCase(),
    siblingText: sibling.textContent || '',
    siblingTextTransform: sibStyle.textTransform || '',
    siblingFontSize,
    siblingLetterSpacing: resolveLengthPx(letterSpacingRaw, siblingFontSize) || 0,
    siblingFontWeight: fontWeightRaw || '',
    siblingColor: colorRaw || '',
  });
}

function checkRepeatedSectionKickersFromDoc(doc, win) {
  const candidates = collectRepeatedSectionKickerCandidates(
    doc,
    (el) => win.getComputedStyle(el),
    (value, fontSize) => resolveLengthPx(value, fontSize) || 0,
  );
  return checkRepeatedSectionKickers({ candidates });
}

function checkElementMotion(tag, style) {
  return checkMotion({
    tag,
    transitionProperty: style.transitionProperty || '',
    animationName: style.animationName || '',
    timingFunctions: [style.animationTimingFunction, style.transitionTimingFunction].filter(Boolean).join(' '),
    classList: '',
  });
}

function checkElementGlow(tag, style, effectiveBg) {
  if (!style.boxShadow || style.boxShadow === 'none') return [];
  return checkGlow({ tag, boxShadow: style.boxShadow, effectiveBg });
}

export {
  checkElementQualityDOM,
  checkPageQualityFromDoc,
  checkPageQualityDOM,
  checkElementQuality,
  checkElementBorders,
  checkElementColors,
  checkElementIconTile,
  checkElementItalicSerif,
  checkElementHeroEyebrow,
  checkRepeatedSectionKickersFromDoc,
  checkElementMotion,
  checkElementGlow,
};
