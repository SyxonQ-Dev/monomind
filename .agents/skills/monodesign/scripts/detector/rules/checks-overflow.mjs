import { resolveLengthPx } from './checks-quality.mjs';

// ─── Clipped overflow container ───────────────────────────────────────────────
// A clipping container (overflow hidden/clip, not a scroll region) wrapping an
// absolutely/fixed-positioned descendant clips popovers/menus that must escape.
function classSelector(el) {
  const cls = (el.getAttribute ? el.getAttribute('class') : el.className) || '';
  const tokens = String(cls).trim().split(/\s+/).filter(Boolean);
  const tag = el.tagName ? el.tagName.toLowerCase() : 'el';
  return tokens.length ? `${tag}.${tokens.join('.')}` : tag;
}

function positionedChildIsDecorative(child) {
  if (!child || typeof child.getAttribute !== 'function') return false;
  if (child.closest?.('[aria-hidden="true"]')) return true;
  const role = (child.getAttribute('role') || '').toLowerCase();
  if (role === 'none' || role === 'presentation') return true;
  const tag = child.tagName ? child.tagName.toLowerCase() : '';
  if (['img', 'svg', 'canvas', 'video'].includes(tag)) return true;
  const ident = `${child.getAttribute('class') || ''} ${child.getAttribute('id') || ''}`;
  if (
    /\b(art|bg|background|badge|blob|crop|decor|dot|glow|grain|image|mask|ornament|overlay|photo|scrim|shadow|shine|texture)\b/i.test(ident) &&
    !positionedChildHasSubstantiveContent(child)
  ) {
    return true;
  }
  return false;
}

const POSITIONED_CHILD_INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'input',
  'select',
  'summary',
  'textarea',
  '[tabindex]:not([tabindex="-1"])',
  '[role="button"]',
  '[role="dialog"]',
  '[role="link"]',
  '[role="listbox"]',
  '[role="menu"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="tooltip"]',
].join(',');

function positionedChildHasSubstantiveContent(child) {
  const text = (child.textContent || '').replace(/\s+/g, ' ').trim();
  if (text.length > 0) return true;
  if (typeof child.matches === 'function') {
    try {
      if (child.matches(POSITIONED_CHILD_INTERACTIVE_SELECTOR)) return true;
    } catch {}
  }
  if (typeof child.querySelector === 'function') {
    try {
      if (child.querySelector(POSITIONED_CHILD_INTERACTIVE_SELECTOR)) return true;
    } catch {}
  }
  return false;
}

function clippingContainerIsIntentionalViewport(el) {
  if (!el || typeof el.getAttribute !== 'function') return false;
  const roleDescription = (el.getAttribute('aria-roledescription') || '').toLowerCase();
  if (/\b(carousel|slider)\b/.test(roleDescription)) return true;
  const ident = `${el.getAttribute('class') || ''} ${el.getAttribute('id') || ''}`.toLowerCase();
  return /\b(carousel|comparison|compare|fisheye|marquee|preview|scroller|slider|slideshow|split|viewport)\b/.test(ident) ||
    /\b(demo-area|demo-stage|demo-viewport)\b/.test(ident);
}

function elementRect(el) {
  if (!el || typeof el.getBoundingClientRect !== 'function') return null;
  try {
    const rect = el.getBoundingClientRect();
    if (!rect) return null;
    const values = [rect.top, rect.right, rect.bottom, rect.left, rect.width, rect.height];
    if (!values.every(Number.isFinite)) return null;
    if (rect.width <= 0 && rect.height <= 0) return null;
    return rect;
  } catch {
    return null;
  }
}

function positionedStyleImpliesEscape(style) {
  const values = [
    style.top,
    style.right,
    style.bottom,
    style.left,
    style.inset,
    style.insetBlock,
    style.insetInline,
    style.insetBlockStart,
    style.insetBlockEnd,
    style.insetInlineStart,
    style.insetInlineEnd,
  ].filter(Boolean).map(value => String(value).trim().toLowerCase());
  for (const value of values) {
    if (/(^|[\s(])-+(?:\d|\.)/.test(value)) return true;
    if (/(^|[\s(])100(?:\.0+)?%/.test(value)) return true;
  }
  return false;
}

function positionedChildEscapesClip(el, child, clipX, clipY) {
  const parentRect = elementRect(el);
  const childRect = elementRect(child);
  if (!parentRect || !childRect) return null;
  const threshold = 2;
  return Boolean(
    (clipX && (childRect.left < parentRect.left - threshold || childRect.right > parentRect.right + threshold)) ||
    (clipY && (childRect.top < parentRect.top - threshold || childRect.bottom > parentRect.bottom + threshold))
  );
}

function checkClippedOverflow(el, style, getStyle) {
  const clips = (v) => v === 'hidden' || v === 'clip';
  const scrolls = (v) => v === 'auto' || v === 'scroll';
  const ox = style.overflowX || '', oy = style.overflowY || '', ov = style.overflow || '';
  const clipX = clips(ox) || clips(ov);
  const clipY = clips(oy) || clips(ov);
  const anyClip = clipX || clipY;
  const anyScroll = scrolls(ox) || scrolls(oy) || scrolls(ov);
  if (!anyClip || anyScroll) return [];
  if (clippingContainerIsIntentionalViewport(el)) return [];
  if (!el.querySelectorAll) return [];
  for (const child of el.querySelectorAll('*')) {
    const childStyle = getStyle(child);
    const pos = childStyle.position || '';
    if (pos === 'absolute' || pos === 'fixed') {
      if (positionedChildIsDecorative(child)) continue;
      const escapes = positionedChildEscapesClip(el, child, clipX, clipY);
      if (escapes === false) continue;
      if (escapes === null && !positionedStyleImpliesEscape(childStyle)) continue;
      return [{ id: 'clipped-overflow-container', snippet: `${classSelector(el)} clips a positioned child` }];
    }
  }
  return [];
}

function checkElementClippedOverflow(el, style, _tag, window) {
  return checkClippedOverflow(el, style, (n) => window.getComputedStyle(n));
}

function checkElementClippedOverflowDOM(el) {
  const style = getComputedStyle(el);
  return checkClippedOverflow(el, style, (n) => getComputedStyle(n));
}

// ─── Text overflow (browser-only: needs scrollWidth/clientWidth) ──────────────
const TEXT_OVERFLOW_SKIP_TAGS = new Set(['pre', 'code', 'textarea', 'svg', 'canvas', 'select', 'option', 'marquee']);

function metricLengthPx(value, fontSizePx = 16) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  return resolveLengthPx(value, fontSizePx);
}

function firstMetricLengthPx(fontSizePx, ...values) {
  for (const value of values) {
    const parsed = metricLengthPx(value, fontSizePx);
    if (parsed !== null) return parsed;
  }
  return null;
}

function expandBoxShorthand(parts) {
  if (parts.length === 1) return [parts[0], parts[0], parts[0], parts[0]];
  if (parts.length === 2) return [parts[0], parts[1], parts[0], parts[1]];
  if (parts.length === 3) return [parts[0], parts[1], parts[2], parts[1]];
  return [parts[0], parts[1], parts[2], parts[3]];
}

function clippedByInset(clipPath) {
  const match = String(clipPath || '').trim().toLowerCase().match(/^inset\s*\(([^)]*)\)$/);
  if (!match) return false;
  const beforeRound = match[1].split(/\s+round\s+/)[0].trim();
  if (!beforeRound) return false;
  const values = expandBoxShorthand(beforeRound.split(/\s+/).slice(0, 4));
  const percents = values.map(value => String(value).trim().match(/^(-?\d+(?:\.\d+)?)%$/));
  if (percents.some(match => !match)) return false;
  const [top, right, bottom, left] = percents.map(match => parseFloat(match[1]));
  return top + bottom >= 100 || left + right >= 100;
}

function clippedByRect(clip) {
  const match = String(clip || '').trim().toLowerCase().match(/^rect\s*\(([^)]*)\)$/);
  if (!match) return false;
  const values = match[1].split(/[,\s]+/).map(value => value.trim()).filter(Boolean);
  if (values.length !== 4) return false;
  const [top, right, bottom, left] = values.map(value => metricLengthPx(value, 16));
  if ([top, right, bottom, left].some(value => value === null)) return false;
  return bottom <= top || right <= left;
}

function isScreenReaderOnlyTextStyle(style, metrics = {}) {
  if (!style) return false;
  const overflowValues = [style.overflow, style.overflowX, style.overflowY]
    .map(value => String(value || '').toLowerCase());
  const clipsOverflow = overflowValues.some(value => value === 'hidden' || value === 'clip');

  const fontSize = metricLengthPx(style.fontSize, 16) || 16;
  const width = firstMetricLengthPx(fontSize, metrics.width, metrics.clientWidth, style.width, style.inlineSize);
  const height = firstMetricLengthPx(fontSize, metrics.height, metrics.clientHeight, style.height, style.blockSize);
  const isTiny = width !== null && height !== null && width <= 2 && height <= 2;
  const isAbsolutelyHidden = String(style.position || '').toLowerCase() === 'absolute' && isTiny && clipsOverflow;

  const clipPath = String(style.clipPath || style.webkitClipPath || '').trim();
  const clip = String(style.clip || '').trim();
  return isAbsolutelyHidden || clippedByInset(clipPath) || clippedByRect(clip);
}

function isRenderedForBrowserRule(el) {
  for (let cur = el; cur && cur.nodeType === 1; cur = cur.parentElement) {
    if (cur.getAttribute?.('aria-hidden') === 'true') return false;
    const style = getComputedStyle(cur);
    const visibility = String(style.visibility || '').toLowerCase();
    if (style.display === 'none' || visibility === 'hidden' || visibility === 'collapse') return false;
    if ((parseFloat(style.opacity) || 0) <= 0.01) return false;
    if (String(style.contentVisibility || '').toLowerCase() === 'hidden') return false;
  }
  return true;
}

function checkElementTextOverflowDOM(el) {
  const tag = el.tagName.toLowerCase();
  if (TEXT_OVERFLOW_SKIP_TAGS.has(tag)) return [];
  if (!isRenderedForBrowserRule(el)) return [];
  // Only the element that actually owns overflowing text — not its ancestors,
  // which inherit a wider scrollWidth from the spilling descendant.
  const hasDirectText = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim().length > 0);
  if (!hasDirectText) return [];
  const style = getComputedStyle(el);
  const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
  if (isScreenReaderOnlyTextStyle(style, {
    width: rect?.width,
    height: rect?.height,
    clientWidth: el.clientWidth,
    clientHeight: el.clientHeight,
  })) return [];
  const isScrollRegion = (s) => /(auto|scroll)/.test(s.overflowX || '') || /(auto|scroll)/.test(s.overflow || '');
  if (isScrollRegion(style)) return [];
  // A scrollable ancestor means this overflow is intentional and scrollable.
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (isScrollRegion(getComputedStyle(p))) return [];
  }
  const delta = el.scrollWidth - el.clientWidth;
  if (el.clientWidth > 0 && delta >= 16) {
    return [{ id: 'text-overflow', snippet: `${classSelector(el)} overflows its box by ${Math.round(delta)}px` }];
  }
  return [];
}

export {
  checkClippedOverflow,
  checkElementClippedOverflow,
  checkElementClippedOverflowDOM,
  isScreenReaderOnlyTextStyle,
  checkElementTextOverflowDOM,
};
