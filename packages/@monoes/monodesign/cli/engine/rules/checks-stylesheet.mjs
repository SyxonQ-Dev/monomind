// ─── Section 7: Stylesheet-level accessibility rules ─────────────────────────
// These operate on raw CSS text (concatenated <style> blocks + linked sheets),
// not per-element computed style — because :hover / :focus-visible / @media
// conditions can't be read off a resting element. Shared by the regex, static
// and browser engines (each hands over its own CSS text).

// Split a selector list on top-level commas only — i.e. commas inside a
// functional pseudo-class's parens (`:is(a, button)`, `:where(a, b)`,
// `:not(a, b)`, `:has(x, y)`) don't split. A naive `str.split(',')` breaks
// `:is(a, button):focus { outline: none }` into `:is(a` and `button):focus`,
// which both selectorTargetsInteractive() and the dark/light selector maps
// below then treat as two unrelated (and malformed) selectors — producing
// false-positive missing-focus-visible findings and double-counted rules.
function splitTopLevelCommas(str) {
  const parts = [];
  let depth = 0, start = 0;
  for (let k = 0; k < str.length; k++) {
    const ch = str[k];
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === ',' && depth === 0) {
      parts.push(str.slice(start, k));
      start = k + 1;
    }
  }
  parts.push(str.slice(start));
  return parts;
}

// Parse flat CSS into { selector, body, dark } tuples, tracking one level of
// dark-scheme context (a `@media (prefers-color-scheme: dark)` ancestor).
// @supports / @layer / @container / @scope are transparently descended.
// @font-face / @keyframes and other at-rules are skipped.
function collectCssRules(css, dark = false, depth = 0) {
  const out = [];
  if (!css || depth > 6) return out;
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  let i = 0;
  while (i < src.length) {
    const braceStart = src.indexOf('{', i);
    if (braceStart === -1) break;
    const prelude = src.slice(i, braceStart).trim();
    let d = 1, j = braceStart + 1;
    for (; j < src.length; j++) {
      if (src[j] === '{') d++;
      else if (src[j] === '}') { d--; if (d === 0) break; }
    }
    const body = src.slice(braceStart + 1, j);
    i = j + 1;
    if (!prelude) continue;
    if (prelude.startsWith('@')) {
      const atName = prelude.slice(1).split(/[\s(]/)[0].toLowerCase();
      if (['media', 'supports', 'layer', 'container', 'scope'].includes(atName)) {
        const isDarkMedia = atName === 'media' && /prefers-color-scheme\s*:\s*dark/i.test(prelude);
        out.push(...collectCssRules(body, dark || isDarkMedia, depth + 1));
      }
      continue;
    }
    for (const sel of splitTopLevelCommas(prelude).map(s => s.trim()).filter(Boolean)) {
      out.push({ selector: sel, body, dark });
    }
  }
  return out;
}

// --- missing-focus-visible ---
function selectorTargetsInteractive(sel) {
  return /(^|[\s>+~(,])(a|button|input|select|textarea|summary)(\b|[.:#[])/i.test(sel)
    || /:focus\b/i.test(sel)
    || /\[role\s*=\s*["']?button["']?\]/i.test(sel);
}

function checkFocusVisible(cssText) {
  if (!cssText) return [];
  const rules = collectCssRules(cssText);
  let suppressor = null;
  let hasFocusVisible = false;
  let hasFocusReplacement = false;
  for (const r of rules) {
    const sel = r.selector.toLowerCase();
    const body = r.body.toLowerCase();
    if (/:focus-visible/.test(sel)) {
      // Any :focus-visible styling counts as deliberate focus handling.
      hasFocusVisible = true;
    }
    const suppresses = /outline\s*:\s*(none|0(?:px)?)\b/.test(body)
      || /outline-style\s*:\s*none/.test(body)
      || /outline-width\s*:\s*0(?:px)?\b/.test(body);
    if (suppresses && selectorTargetsInteractive(sel) && !/:focus-visible/.test(sel)) {
      suppressor = suppressor || r;
    }
    // A plain :focus rule that draws a visible affordance is a valid fallback.
    if (/:focus\b/.test(sel) && !/:focus-visible/.test(sel)) {
      const olVal = /outline\s*:\s*([^;}]+)/.exec(body);
      const outlineReplaces = olVal && !/^\s*(none|0(?:px)?|inherit|initial|unset)\s*$/.test(olVal[1]);
      if (/box-shadow\s*:/.test(body)
        || outlineReplaces
        || /outline-(?:color|width|style)\s*:\s*(?!none|0(?:px)?\b)/.test(body)
        || /border(?:-\w+)?(?:-color)?\s*:/.test(body)) {
        hasFocusReplacement = true;
      }
    }
  }
  if (suppressor && !hasFocusVisible && !hasFocusReplacement) {
    return [{ id: 'missing-focus-visible', snippet: `"${suppressor.selector}" removes outline with no :focus-visible replacement` }];
  }
  return [];
}

// --- hover-only-affordance ---
function lastCompound(sel) {
  const parts = sel.split(/\s*[>+~]\s*|\s+/).filter(Boolean);
  const last = parts[parts.length - 1] || sel;
  return last.replace(/:{1,2}[a-z-]+(\([^)]*\))?/gi, '').trim().toLowerCase();
}
function bodyRevealsVisible(body) {
  const b = body.toLowerCase();
  if (/display\s*:\s*(block|flex|grid|inline(?:-\w+)?|table|list-item)/.test(b)) return true;
  if (/visibility\s*:\s*visible/.test(b)) return true;
  if (/opacity\s*:\s*(?:1(?:\.0+)?|0?\.[1-9]\d*|\.\d*[1-9])\b/.test(b)) return true;
  return false;
}
function bodyHidesByDefault(body) {
  const b = body.toLowerCase();
  return /display\s*:\s*none/.test(b)
    || /visibility\s*:\s*hidden/.test(b)
    || /opacity\s*:\s*0(?:\.0+)?\b/.test(b);
}
function checkHoverOnlyAffordance(cssText) {
  if (!cssText) return [];
  const rules = collectCssRules(cssText);
  const focusTargets = new Set();
  const hiddenTargets = new Set();
  for (const r of rules) {
    const sel = r.selector;
    if (/:(focus|focus-within|focus-visible|active)\b/i.test(sel) && bodyRevealsVisible(r.body)) {
      focusTargets.add(lastCompound(sel));
    }
    if (!/:hover\b/i.test(sel) && bodyHidesByDefault(r.body)) {
      hiddenTargets.add(lastCompound(sel));
    }
  }
  const findings = [];
  const seen = new Set();
  for (const r of rules) {
    const sel = r.selector;
    if (!/:hover\b/i.test(sel)) continue;
    if (!bodyRevealsVisible(r.body)) continue;
    const parts = sel.split(/\s*[>+~]\s*|\s+/).filter(Boolean);
    if (parts.length < 2) continue; // hover on the subject itself — can't hide+reveal
    if (/:hover\b/i.test(parts[parts.length - 1])) continue; // :hover is on the revealed subject
    const target = lastCompound(sel);
    if (!target || !hiddenTargets.has(target)) continue;
    if (focusTargets.has(target)) continue;
    if (seen.has(target)) continue;
    seen.add(target);
    findings.push({ id: 'hover-only-affordance', snippet: `"${target}" is revealed on :hover with no focus/active equivalent` });
  }
  return findings;
}

// --- dark-scheme-contrast-blindspot ---
const DARK_SCOPE_RE = /(?:^|[\s>+~(,])(?:html|:root|body)?(?:\.dark|\.theme-dark|\.dark-mode)\b|\[data-theme\s*[~|]?=\s*["']?dark["']?\]|\[data-mode\s*=\s*["']?dark["']?\]|\[data-color-scheme\s*=\s*["']?dark["']?\]/i;
function stripDarkScope(sel) {
  return sel
    .replace(/(?:html|:root|body)?(?:\.dark|\.theme-dark|\.dark-mode)\b/gi, '')
    .replace(/\[data-(?:theme|mode|color-scheme)\s*[~|]?=\s*["']?dark["']?\]/gi, '')
    .replace(/\s*[>+~]\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function normalizeSelKey(sel) {
  return sel.replace(/\s*[>+~]\s*/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}
function declHasColor(body) { return /(?:^|[;{\s])color\s*:/i.test(body); }
function declHasBg(body) { return /(?:^|[;{\s])background(?:-color)?\s*:/i.test(body); }
function checkDarkSchemeContrast(cssText) {
  if (!cssText) return [];
  const rules = collectCssRules(cssText);
  const hasDarkMedia = /@media[^{]*prefers-color-scheme\s*:\s*dark/i.test(cssText);
  const hasDarkSelectors = rules.some(r => DARK_SCOPE_RE.test(r.selector));
  if (!hasDarkMedia && !hasDarkSelectors) return [];

  const light = new Map(); // base selector → { color, bg }
  const darkAgg = new Map();
  for (const r of rules) {
    const scopedDark = DARK_SCOPE_RE.test(r.selector);
    const isDark = r.dark || scopedDark;
    if (isDark) {
      const base = normalizeSelKey(scopedDark ? stripDarkScope(r.selector) : r.selector);
      if (!base) continue;
      const e = darkAgg.get(base) || { color: false, bg: false };
      if (declHasColor(r.body)) e.color = true;
      if (declHasBg(r.body)) e.bg = true;
      darkAgg.set(base, e);
    } else {
      const base = normalizeSelKey(r.selector);
      if (!base) continue;
      const e = light.get(base) || { color: false, bg: false };
      if (declHasColor(r.body)) e.color = true;
      if (declHasBg(r.body)) e.bg = true;
      light.set(base, e);
    }
  }

  const findings = [];
  for (const [base, d] of darkAgg) {
    if (d.color === d.bg) continue; // sets both or neither — not a split pair
    const lp = light.get(base);
    if (!lp || !(lp.color && lp.bg)) continue; // light scheme must pair both
    const changed = d.bg ? 'background' : 'text color';
    const missing = d.bg ? 'text color' : 'background';
    findings.push({ id: 'dark-scheme-contrast-blindspot', snippet: `"${base}" overrides ${changed} in dark scheme but not ${missing}` });
  }
  return findings;
}

// --- image-missing-dimensions ---
function checkImageDimensions({ hasWidthAttr, hasHeightAttr, style }) {
  const s = String(style || '').toLowerCase();
  if (hasWidthAttr && hasHeightAttr) return [];
  if (/aspect-?ratio\s*:/.test(s)) return [];
  const heightM = /(?:^|[;{\s])height\s*:\s*([^;]+)/.exec(s);
  if (heightM && !/^\s*(auto|inherit|initial|unset|0(?:px)?)\s*$/.test(heightM[1])) return [];
  return [{ id: 'image-missing-dimensions', snippet: '<img> without width/height attributes or CSS aspect-ratio (layout shift risk)' }];
}

function checkElementImageDimensions(el, style) {
  const hasWidthAttr = (el.getAttribute?.('width') ?? el.attribs?.width) != null;
  const hasHeightAttr = (el.getAttribute?.('height') ?? el.attribs?.height) != null;
  const parts = [el.getAttribute?.('style') || el.attribs?.style || ''];
  const ar = style && (style.aspectRatio || style['aspect-ratio']);
  if (ar && ar !== 'auto') parts.push(`aspect-ratio:${ar}`);
  const h = style?.height;
  if (h && h !== 'auto' && h !== '') parts.push(`height:${h}`);
  return checkImageDimensions({ hasWidthAttr, hasHeightAttr, style: parts.join(';') });
}

function checkElementImageDimensionsDOM(el) {
  // Only <img> can have this problem. The static engine gets this for free —
  // it registers the rule with `selector: 'img'` (engines/static-html/
  // detect-html.mjs) — but the DOM walker calls every check against every
  // element, so the tag filter has to live here. Without it this rule fired on
  // <head>, <meta>, <title> and <style>: a clean 84-line fixture reported 43
  // findings, all of them "an <img> ships without width and height".
  if (el.tagName !== 'IMG') return [];
  const hasWidthAttr = el.getAttribute('width') != null;
  const hasHeightAttr = el.getAttribute('height') != null;
  // Browser computed `height` always resolves to a used px value after layout,
  // so it can't tell a reserved height from a rendered one — only use inline
  // style + the computed aspect-ratio (which stays 'auto' unless authored).
  const parts = [el.getAttribute('style') || ''];
  const style = getComputedStyle(el);
  const ar = style.aspectRatio || '';
  if (ar && ar !== 'auto') parts.push(`aspect-ratio:${ar}`);
  return checkImageDimensions({ hasWidthAttr, hasHeightAttr, style: parts.join(';') });
}

// --- small-touch-target ---
const CLICKABLE_INPUT_TYPES = new Set(['button', 'submit', 'reset', 'checkbox', 'radio', 'image']);
const CLICKABLE_ROLES = new Set(['button', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'switch', 'checkbox', 'radio', 'option']);
function isClickableControl(tag, role, href, inputType) {
  if (tag === 'button' || tag === 'select' || tag === 'summary') return true;
  if (tag === 'a') return href != null && href !== '';
  if (tag === 'input') return CLICKABLE_INPUT_TYPES.has(String(inputType || '').toLowerCase());
  if (role && CLICKABLE_ROLES.has(role)) return true;
  return false;
}
function checkSmallTouchTarget({ tag, role, href, inputType, widthPx, heightPx, isInlineLinkInProse }) {
  if (!isClickableControl(tag, role, href, inputType)) return [];
  if (isInlineLinkInProse) return [];
  if (!(widthPx > 0) || !(heightPx > 0)) return [];
  if (widthPx >= 44 && heightPx >= 44) return [];
  const roleLabel = role && !['button', 'a', 'input', 'select'].includes(tag) ? `[role=${role}]` : '';
  return [{ id: 'small-touch-target', snippet: `<${tag}>${roleLabel} renders ${Math.round(widthPx)}x${Math.round(heightPx)}px (min 44x44)` }];
}

const PROSE_ANCESTOR_SELECTOR = 'p,li,blockquote,figcaption,dd,dt';
function checkElementSmallTouchTarget(el, style, tag) {
  // Static path: only provable when width AND height are explicit px lengths
  // (jsdom performs no layout; rem/%/auto can't be resolved to a real box).
  const wRaw = style.width || '';
  const hRaw = style.height || '';
  if (!/px\s*$/.test(wRaw) || !/px\s*$/.test(hRaw)) return [];
  const widthPx = parseFloat(wRaw);
  const heightPx = parseFloat(hRaw);
  const href = el.getAttribute?.('href');
  const role = (el.getAttribute?.('role') || '').toLowerCase();
  const inputType = el.getAttribute?.('type') || '';
  // An <a> is a prose text link unless it is explicitly laid out as a block
  // (button-like). jsdom returns '' for the default inline display, so key
  // off "not blockish" rather than "== inline".
  const isBlockish = /^(block|flex|grid|inline-block|inline-flex|table)/.test(style.display || '');
  const inProse = !!el.closest?.(PROSE_ANCESTOR_SELECTOR);
  const isInlineLinkInProse = tag === 'a' && !isBlockish && inProse;
  return checkSmallTouchTarget({ tag, role, href, inputType, widthPx, heightPx, isInlineLinkInProse });
}

function checkElementSmallTouchTargetDOM(el) {
  const tag = el.tagName.toLowerCase();
  const rect = el.getBoundingClientRect();
  if (!(rect.width > 0) || !(rect.height > 0)) return [];
  const href = el.getAttribute('href');
  const role = (el.getAttribute('role') || '').toLowerCase();
  const inputType = el.getAttribute('type') || '';
  const style = getComputedStyle(el);
  const isBlockish = /^(block|flex|grid|inline-block|inline-flex|table)/.test(style.display || '');
  const inProse = !!el.closest?.(PROSE_ANCESTOR_SELECTOR);
  const isInlineLinkInProse = tag === 'a' && !isBlockish && inProse;
  return checkSmallTouchTarget({ tag, role, href, inputType, widthPx: rect.width, heightPx: rect.height, isInlineLinkInProse });
}

export {
  collectCssRules,
  checkFocusVisible,
  checkHoverOnlyAffordance,
  checkDarkSchemeContrast,
  checkImageDimensions,
  checkElementImageDimensions,
  checkElementImageDimensionsDOM,
  checkSmallTouchTarget,
  checkElementSmallTouchTarget,
  checkElementSmallTouchTargetDOM,
};
