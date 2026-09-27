import { BORDER_SAFE_TAGS } from '../shared/constants.mjs';
import { parseRgb } from '../shared/color.mjs';
import {
  checkBorders,
  isEmojiOnlyText,
  checkColors,
  HEADING_TAGS,
  checkIconTile,
  checkItalicSerif,
  checkHeroEyebrow,
} from './checks-pure.mjs';
import {
  readOwnBackgroundColor,
  resolveBackground,
  resolveGradientStops,
} from './checks-background.mjs';

// ─── Section 5: Element Adapters ────────────────────────────────────────────

// Browser adapters — call getComputedStyle/getBoundingClientRect on live DOM

function checkElementBordersDOM(el) {
  const tag = el.tagName.toLowerCase();
  if (BORDER_SAFE_TAGS.has(tag)) return [];
  const rect = el.getBoundingClientRect();
  if (rect.width < 20 || rect.height < 20) return [];
  const style = getComputedStyle(el);
  const sides = ['Top', 'Right', 'Bottom', 'Left'];
  const widths = {}, colors = {};
  for (const s of sides) {
    widths[s] = parseFloat(style[`border${s}Width`]) || 0;
    colors[s] = style[`border${s}Color`] || '';
  }
  return checkBorders(tag, widths, colors, parseFloat(style.borderRadius) || 0);
}

function checkElementColorsDOM(el) {
  const tag = el.tagName.toLowerCase();
  // No early SAFE_TAGS bail here — checkColors() does its own gating that
  // includes the styled-button exception for <a> / <button> with their own
  // opaque background. Bailing here would prevent that exception from firing.
  const rect = el.getBoundingClientRect();
  if (rect.width < 10 || rect.height < 10) return [];
  const style = getComputedStyle(el);
  const directText = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('');
  const hasDirectText = directText.trim().length > 0;
  const effectiveBg = resolveBackground(el);
  return checkColors({
    tag,
    textColor: parseRgb(style.color),
    bgColor: readOwnBackgroundColor(el, style),
    effectiveBg,
    effectiveBgStops: effectiveBg ? null : resolveGradientStops(el),
    fontSize: parseFloat(style.fontSize) || 16,
    fontWeight: parseInt(style.fontWeight, 10) || 400,
    hasDirectText,
    isEmojiOnly: isEmojiOnlyText(directText),
    bgClip: style.webkitBackgroundClip || style.backgroundClip || '',
    bgImage: style.backgroundImage || '',
    classList: el.getAttribute('class') || '',
  });
}

function checkElementIconTileDOM(el) {
  const tag = el.tagName.toLowerCase();
  if (!HEADING_TAGS.has(tag)) return [];
  const sibling = el.previousElementSibling;
  if (!sibling) return [];

  const sibRect = sibling.getBoundingClientRect();
  const headRect = el.getBoundingClientRect();
  const sibStyle = getComputedStyle(sibling);

  // The tile may either contain an <svg>/<i> icon child, OR the tile itself
  // may contain an emoji/symbol character directly as its only text content
  // (the "card-icon" pattern from many AI-generated demos).
  const iconChild = sibling.querySelector('svg, i[data-lucide], i[class*="fa-"], i[class*="icon"]');
  const iconRect = iconChild?.getBoundingClientRect();
  const sibDirectText = [...sibling.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('');
  const hasInlineEmojiIcon = sibling.children.length === 0 && isEmojiOnlyText(sibDirectText);

  return checkIconTile({
    headingTag: tag,
    headingText: el.textContent || '',
    headingTop: headRect.top,
    siblingTag: sibling.tagName.toLowerCase(),
    siblingWidth: sibRect.width,
    siblingHeight: sibRect.height,
    siblingBottom: sibRect.bottom,
    siblingBgColor: parseRgb(sibStyle.backgroundColor),
    siblingBgImage: sibStyle.backgroundImage || '',
    siblingBorderWidth: parseFloat(sibStyle.borderTopWidth) || 0,
    siblingBorderRadius: parseFloat(sibStyle.borderRadius) || 0,
    hasIconChild: !!iconChild || hasInlineEmojiIcon,
    iconChildWidth: iconRect?.width || 0,
  });
}

function checkElementItalicSerifDOM(el) {
  const tag = el.tagName.toLowerCase();
  if (tag !== 'h1' && tag !== 'h2') return [];
  const style = getComputedStyle(el);
  return checkItalicSerif({
    tag,
    fontStyle: style.fontStyle || '',
    fontFamily: style.fontFamily || '',
    fontSize: parseFloat(style.fontSize) || 0,
    headingText: el.textContent || '',
  });
}

function checkElementHeroEyebrowDOM(el) {
  const tag = el.tagName.toLowerCase();
  if (tag !== 'h1') return [];
  const sibling = el.previousElementSibling;
  if (!sibling) return [];
  const headStyle = getComputedStyle(el);
  const sibStyle = getComputedStyle(sibling);
  return checkHeroEyebrow({
    headingTag: tag,
    headingText: el.textContent || '',
    headingFontSize: parseFloat(headStyle.fontSize) || 0,
    siblingTag: sibling.tagName.toLowerCase(),
    siblingText: sibling.textContent || '',
    siblingTextTransform: sibStyle.textTransform || '',
    siblingFontSize: parseFloat(sibStyle.fontSize) || 0,
    siblingLetterSpacing: parseFloat(sibStyle.letterSpacing) || 0,
    siblingFontWeight: sibStyle.fontWeight || '',
    siblingColor: sibStyle.color || '',
  });
}

// Build a map of CSS custom properties declared on :root / :host / html.
// Used to resolve var(--X) refs that jsdom returns verbatim in
// getComputedStyle. Tailwind v4 routes every utility class through
// CSS vars (font-weight: var(--font-weight-bold), font-size:
// var(--text-xs), letter-spacing: var(--tracking-widest)), so without
// resolution every style-based check silently fails on Tailwind v4
// builds — the values come back as literal "var(--font-weight-bold)"
// strings and parseFloat returns NaN.

export {
  checkElementBordersDOM,
  checkElementColorsDOM,
  checkElementIconTileDOM,
  checkElementItalicSerifDOM,
  checkElementHeroEyebrowDOM,
};
