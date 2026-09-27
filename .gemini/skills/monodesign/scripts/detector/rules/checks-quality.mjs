import { parseAnyColor } from './checks-css-values.mjs';

const QUALITY_TEXT_TAGS = new Set(['p', 'li', 'td', 'th', 'dd', 'blockquote', 'figcaption']);

// Resolve a CSS font-size value to pixels by walking up the parent chain.
// Browsers resolve em/rem/% to px in getComputedStyle, but jsdom returns the
// specified value verbatim — so for the Node path we walk parents ourselves.
function resolveFontSizePx(el, win) {
  const chain = []; // raw font-size strings, leaf → root
  let cur = el;
  while (cur && cur.nodeType === 1) {
    const fs = (win ? win.getComputedStyle(cur) : getComputedStyle(cur)).fontSize;
    chain.push(fs || '');
    cur = cur.parentElement;
  }
  // Walk root → leaf, resolving each value relative to its parent context.
  let px = 16; // root default
  for (let i = chain.length - 1; i >= 0; i--) {
    const v = chain[i];
    if (!v || v === 'inherit') continue;
    const num = parseFloat(v);
    if (Number.isNaN(num)) continue;
    if (v.endsWith('px')) px = num;
    else if (v.endsWith('rem')) px = num * 16;
    else if (v.endsWith('em')) px = num * px;
    else if (v.endsWith('%')) px = (num / 100) * px;
    else px = num; // unitless — already resolved
  }
  return px;
}

// Resolve a CSS length value (line-height, letter-spacing, etc.) given a
// known font-size context. Returns null for "normal" / unparseable values.
function resolveLengthPx(value, fontSizePx) {
  if (!value || value === 'normal' || value === 'auto' || value === 'inherit') return null;
  const num = parseFloat(value);
  if (Number.isNaN(num)) return null;
  if (value.endsWith('px')) return num;
  if (value.endsWith('rem')) return num * 16;
  if (value.endsWith('em')) return num * fontSizePx;
  if (value.endsWith('%')) return (num / 100) * fontSizePx;
  // Unitless line-height = multiplier, return px equivalent
  return num * fontSizePx;
}

function cssColorIsTransparent(value) {
  if (!value) return true;
  const str = String(value).trim().toLowerCase();
  if (!str || str === 'transparent' || str === 'rgba(0, 0, 0, 0)') return true;
  const parsed = parseAnyColor(str);
  if (parsed) return (parsed.a ?? 1) <= 0.05;
  return /^rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*0(?:\.0+)?\s*\)$/.test(str);
}

function colorsNearlyMatch(a, b) {
  const ca = parseAnyColor(a);
  const cb = parseAnyColor(b);
  if (!ca || !cb) return false;
  const alphaDelta = Math.abs((ca.a ?? 1) - (cb.a ?? 1));
  const channelDelta = Math.max(
    Math.abs(ca.r - cb.r),
    Math.abs(ca.g - cb.g),
    Math.abs(ca.b - cb.b),
  );
  return alphaDelta <= 0.03 && channelDelta <= 3;
}

function getComputedStyleFor(win, el) {
  if (win && typeof win.getComputedStyle === 'function') {
    try { return win.getComputedStyle(el); } catch {}
  }
  if (typeof getComputedStyle === 'function') {
    try { return getComputedStyle(el); } catch {}
  }
  return null;
}

function hasVisibleBackgroundBoundary(style, el, win) {
  const bg = style?.backgroundColor || '';
  if (cssColorIsTransparent(bg)) return false;

  let parent = el?.parentElement || null;
  while (parent) {
    const parentStyle = getComputedStyleFor(win, parent);
    const parentBg = parentStyle?.backgroundColor || '';
    if (!cssColorIsTransparent(parentBg)) {
      return !colorsNearlyMatch(bg, parentBg);
    }
    parent = parent.parentElement;
  }

  return true;
}

const TEXT_EDGE_TAGS = new Set(['A', 'BUTTON', 'CODE', 'DD', 'DT', 'FIGCAPTION', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'P', 'PRE', 'SPAN', 'TD', 'TH']);

function hasMeaningfulDirectText(node) {
  if (!node?.childNodes) return false;
  for (const child of node.childNodes) {
    if (child.nodeType === 3 && child.textContent.trim().length > 4) return true;
  }
  return false;
}

function textDescendantsFlushSides(el, rect) {
  const flush = { top: false, right: false, bottom: false, left: false };
  if (!rect || !el?.querySelectorAll) return flush;
  const TEXT_EDGE_THRESHOLD = 4;
  const candidates = el.querySelectorAll('a, button, code, dd, dt, figcaption, h1, h2, h3, h4, h5, h6, li, p, pre, span, td, th');
  for (const node of candidates) {
    if (!TEXT_EDGE_TAGS.has(node.tagName) || !hasMeaningfulDirectText(node)) continue;
    let nodeRect = null;
    try { nodeRect = node.getBoundingClientRect(); } catch {}
    if (!nodeRect || nodeRect.width <= 0 || nodeRect.height <= 0) continue;
    if (nodeRect.bottom < rect.top || nodeRect.top > rect.bottom || nodeRect.right < rect.left || nodeRect.left > rect.right) continue;
    if (nodeRect.top - rect.top <= TEXT_EDGE_THRESHOLD) flush.top = true;
    if (rect.right - nodeRect.right <= TEXT_EDGE_THRESHOLD) flush.right = true;
    if (rect.bottom - nodeRect.bottom <= TEXT_EDGE_THRESHOLD) flush.bottom = true;
    if (nodeRect.left - rect.left <= TEXT_EDGE_THRESHOLD) flush.left = true;
  }
  return flush;
}

// Pure quality checks. Most run on computed CSS and DOM-only inputs (work in
// jsdom and the browser). Two checks (line-length, cramped-padding) gate on
// element rect dimensions, which jsdom can't compute — pass `rect: null` from
// the Node adapter to skip those.
//
// Both adapters resolve font-size, line-height and letter-spacing to pixels
// before calling this so the pure function only deals with numbers.
function checkQuality(opts) {
  const { el, tag, style, hasDirectText, textLen, fontSize, lineHeightPx, letterSpacingPx, rect, lineMax = 80, viewportWidth = 0, win = null } = opts;
  const findings = [];
  // Skip browser extension injected elements
  const elId = el.id || '';
  if (elId.startsWith('claude-') || elId.startsWith('cic-')) return findings;

  // --- Line length too long --- (browser-only: needs rect.width)
  if (rect && hasDirectText && QUALITY_TEXT_TAGS.has(tag) && rect.width > 0 && textLen > lineMax) {
    const charsPerLine = rect.width / (fontSize * 0.5);
    if (charsPerLine > lineMax + 5) {
      findings.push({ id: 'line-length', snippet: `~${Math.round(charsPerLine)} chars/line (aim for <${lineMax})` });
    }
  }

  // --- Cramped padding --- (browser-only: needs rect to skip small badges/labels)
  // Vertical and horizontal thresholds are independent because line-height
  // already provides built-in vertical breathing room (the line box is taller
  // than the cap height), but horizontal has no equivalent. Both scale with
  // font-size — bigger text demands proportionally more padding.
  //   vertical:   max(4px, fontSize × 0.3)
  //   horizontal: max(8px, fontSize × 0.5)
  const isInlineCode = tag === 'code' && !el.closest?.('pre');
  if (!isInlineCode && rect && hasDirectText && textLen > 20 && rect.width > 100 && rect.height > 30) {
    const borders = {
      top: parseFloat(style.borderTopWidth) || 0,
      right: parseFloat(style.borderRightWidth) || 0,
      bottom: parseFloat(style.borderBottomWidth) || 0,
      left: parseFloat(style.borderLeftWidth) || 0,
    };
    const borderCount = Object.values(borders).filter(w => w > 0).length;
    const hasBg = hasVisibleBackgroundBoundary(style, el, win);
    if (borderCount >= 2 || hasBg) {
      const vPads = [], hPads = [];
      if (hasBg || borders.top > 0) vPads.push(parseFloat(style.paddingTop) || 0);
      if (hasBg || borders.bottom > 0) vPads.push(parseFloat(style.paddingBottom) || 0);
      if (hasBg || borders.left > 0) hPads.push(parseFloat(style.paddingLeft) || 0);
      if (hasBg || borders.right > 0) hPads.push(parseFloat(style.paddingRight) || 0);

      const vMin = vPads.length ? Math.min(...vPads) : Infinity;
      const hMin = hPads.length ? Math.min(...hPads) : Infinity;
      const vThresh = Math.max(4, fontSize * 0.3);
      const hThresh = Math.max(8, fontSize * 0.5);

      // Emit at most one finding per element — pick whichever axis is worse.
      if (vMin < vThresh) {
        findings.push({ id: 'cramped-padding', snippet: `${vMin}px vertical padding (need ≥${vThresh.toFixed(1)}px for ${fontSize}px text)` });
      } else if (hMin < hThresh) {
        findings.push({ id: 'cramped-padding', snippet: `${hMin}px horizontal padding (need ≥${hThresh.toFixed(1)}px for ${fontSize}px text)` });
      }
    }
  }

  // --- Flush against a visible boundary ---
  // Fires when a container has a visible boundary (border, outline, OR a
  // non-transparent background) AND near-zero padding on the bounded
  // side(s) AND text-bearing children land flush against the boundary.
  //
  // Distinct from cramped-padding: that rule needs the element itself to
  // have direct text (hasDirectText). This rule targets the OPPOSITE
  // shape — a container with NO direct text, only children — which is
  // exactly what cramped-padding misses (a section wrapping a label +
  // list lands a free pass).
  //
  // The classic shape: agent writes `padding: 28px 0 0` shorthand on a
  // section that also has a border, zeroing horizontal padding so the
  // text-bearing children touch the side borders. Background and
  // outline count too: a colored card with zero padding has the same
  // visual failure mode.
  {
    const FLUSH_SKIP_TAGS = new Set(['HTML', 'BODY', 'MAIN', 'HEADER', 'FOOTER', 'NAV', 'ARTICLE', 'ASIDE', 'BUTTON', 'A', 'LABEL', 'SUMMARY', 'CODE', 'PRE', 'INPUT', 'TEXTAREA', 'SELECT', 'FORM', 'FIGURE', 'TABLE', 'TBODY', 'THEAD', 'TR', 'TD', 'TH']);
    const upperTag = tag ? tag.toUpperCase() : '';
    const elPosition = style.position || '';
    if (
      !FLUSH_SKIP_TAGS.has(upperTag) &&
      !hasDirectText &&
      !['fixed', 'absolute'].includes(elPosition) &&
      el.children && el.children.length > 0
    ) {
      const borderW = {
        top:    parseFloat(style.borderTopWidth)    || 0,
        right:  parseFloat(style.borderRightWidth)  || 0,
        bottom: parseFloat(style.borderBottomWidth) || 0,
        left:   parseFloat(style.borderLeftWidth)   || 0,
      };
      const borderVisible = {
        top:    borderW.top    > 0 && !cssColorIsTransparent(style.borderTopColor),
        right:  borderW.right  > 0 && !cssColorIsTransparent(style.borderRightColor),
        bottom: borderW.bottom > 0 && !cssColorIsTransparent(style.borderBottomColor),
        left:   borderW.left   > 0 && !cssColorIsTransparent(style.borderLeftColor),
      };
      // Outline detection. jsdom decomposes `border` shorthand into
      // border{Top,…}Width/Color but does NOT decompose `outline` —
      // the longhands come back empty when the value was set via the
      // shorthand. Fall back to parsing `style.outline` ourselves.
      let outlineW = parseFloat(style.outlineWidth) || 0;
      let outlineStyleVal = style.outlineStyle || '';
      let outlineColorVal = style.outlineColor || '';
      if (!outlineW && style.outline) {
        const wMatch = style.outline.match(/(\d+(?:\.\d+)?)\s*px/);
        if (wMatch) outlineW = parseFloat(wMatch[1]) || 0;
        if (!outlineStyleVal) {
          outlineStyleVal = /\b(solid|dashed|dotted|double|groove|ridge|inset|outset)\b/.test(style.outline) ? 'solid' : '';
        }
        if (!outlineColorVal) {
          const cMatch = style.outline.match(/(rgba?\([^)]+\)|#[0-9a-fA-F]{3,8}|[a-zA-Z]+)\s*$/);
          if (cMatch) outlineColorVal = cMatch[1];
        }
      }
      const outlineVisible = outlineW > 0 && !cssColorIsTransparent(outlineColorVal) && outlineStyleVal && outlineStyleVal !== 'none';
      const bgVisible = hasVisibleBackgroundBoundary(style, el, win);

      const anyVisible = borderVisible.top || borderVisible.right || borderVisible.bottom || borderVisible.left || outlineVisible || bgVisible;
      if (anyVisible) {
        // Resolve padding to px (jsdom returns raw "1.5rem" etc., not the
        // computed px value; parseFloat would strip the unit and treat
        // 1.5rem as 1.5px, false-flagging legitimate insets).
        const pad = {
          top:    resolveLengthPx(style.paddingTop,    fontSize) ?? 0,
          right:  resolveLengthPx(style.paddingRight,  fontSize) ?? 0,
          bottom: resolveLengthPx(style.paddingBottom, fontSize) ?? 0,
          left:   resolveLengthPx(style.paddingLeft,   fontSize) ?? 0,
        };
        const PAD_THRESHOLD = 2;
        // Children-insulate-this-side: a side is insulated if ANY direct
        // child has its own padding ≥ 4px on that side. Rationale: in
        // typical flow, only the first/last (or leftmost/rightmost)
        // children actually sit at the parent's edges. If even one of
        // them has its own padding, the visual flush is broken on that
        // side. Classic example: a column-flow card frame where the
        // top child (header) has padding-top:12 and the bottom child
        // (footer) has padding-bottom:8 — the parent's padding:0 doesn't
        // matter; nothing is actually flush. The `any-child-insulates`
        // heuristic accepts some false negatives (a card with one heavily
        // padded middle child won't flag) for far fewer false positives.
        const CHILD_INSULATE_THRESHOLD = 4;
        const childrenInsulate = { top: false, right: false, bottom: false, left: false };
        for (const child of el.children) {
          const childStyle = getComputedStyleFor(win, child);
          if (!childStyle) continue;
          const childPad = {
            top:    resolveLengthPx(childStyle.paddingTop,    fontSize) ?? 0,
            right:  resolveLengthPx(childStyle.paddingRight,  fontSize) ?? 0,
            bottom: resolveLengthPx(childStyle.paddingBottom, fontSize) ?? 0,
            left:   resolveLengthPx(childStyle.paddingLeft,   fontSize) ?? 0,
          };
          const childMargin = {
            top:    resolveLengthPx(childStyle.marginTop,    fontSize) ?? 0,
            right:  resolveLengthPx(childStyle.marginRight,  fontSize) ?? 0,
            bottom: resolveLengthPx(childStyle.marginBottom, fontSize) ?? 0,
            left:   resolveLengthPx(childStyle.marginLeft,   fontSize) ?? 0,
          };
          if (rect && typeof child.getBoundingClientRect === 'function') {
            try {
              const childRect = child.getBoundingClientRect();
              if (childRect && childRect.width > 0 && childRect.height > 0) {
                if (childRect.top - rect.top >= CHILD_INSULATE_THRESHOLD) childrenInsulate.top = true;
                if (rect.right - childRect.right >= CHILD_INSULATE_THRESHOLD) childrenInsulate.right = true;
                if (rect.bottom - childRect.bottom >= CHILD_INSULATE_THRESHOLD) childrenInsulate.bottom = true;
                if (childRect.left - rect.left >= CHILD_INSULATE_THRESHOLD) childrenInsulate.left = true;
              }
            } catch {}
          }
          for (const s of ['top', 'right', 'bottom', 'left']) {
            if (childPad[s] >= CHILD_INSULATE_THRESHOLD || childMargin[s] >= CHILD_INSULATE_THRESHOLD) {
              childrenInsulate[s] = true;
            }
          }
        }

        const textFlush = rect ? textDescendantsFlushSides(el, rect) : null;
        const fullBleedBgBand = rect && viewportWidth > 0 && rect.width >= viewportWidth * 0.94 && bgVisible && !outlineVisible;
        const flushSides = [];
        for (const side of ['top', 'right', 'bottom', 'left']) {
          const bgBoundsSide = bgVisible && !(fullBleedBgBand && (side === 'left' || side === 'right'));
          const sideBounded = borderVisible[side] || outlineVisible || bgBoundsSide;
          if (sideBounded && pad[side] <= PAD_THRESHOLD && !childrenInsulate[side] && (!textFlush || textFlush[side])) {
            flushSides.push(side);
          }
        }

        if (flushSides.length > 0) {
          // Confirm at least one direct child has substantial text content
          // (> 4 chars). Without this, the flush is harmless: e.g. an
          // image-only card.
          let hasTextChild = false;
          for (const child of el.children) {
            const childText = (child.textContent || '').trim();
            if (childText.length > 4) { hasTextChild = true; break; }
          }
          if (hasTextChild) {
            const cls = (typeof el.className === 'string' && el.className.trim())
              ? el.className.trim().split(/\s+/)[0]
              : '';
            const boundaryParts = [];
            const borderSidesVisible = ['top', 'right', 'bottom', 'left'].filter(s => borderVisible[s]);
            if (borderSidesVisible.length === 4) boundaryParts.push('border');
            else if (borderSidesVisible.length > 0) boundaryParts.push(`border-${borderSidesVisible.join('/')}`);
            if (outlineVisible) boundaryParts.push('outline');
            if (bgVisible) boundaryParts.push('bg');
            const sidesLabel = flushSides.length === 4 ? 'all sides' : flushSides.join('/');
            const ident = cls
              ? `<${tag.toLowerCase()}> "${cls}"`
              : `<${tag.toLowerCase()}>`;
            findings.push({
              id: 'cramped-padding',
              snippet: `${ident}: children flush against ${boundaryParts.join('+')} on ${sidesLabel} (no inset)`,
            });
          }
        }
      }
    }
  }

  // --- Body text touching viewport edge --- (browser-only: needs rect)
  // Catches the failure mode where the agent ships body paragraphs
  // with NO container providing horizontal padding — text bleeds
  // directly to the viewport edge. Different from cramped-padding,
  // which requires a colored/bordered container. Here the failure
  // is the absence of the container entirely.
  //
  // Gate aggressively to avoid false positives:
  //   - <p> or <li> only (body content; not headings, not nav, not
  //     wrappers)
  //   - text > 40 chars (paragraph-like, not a label)
  //   - rect.width > 50% of viewport (real body, not a pull-quote)
  //   - rect.left < 16 OR rect.right > viewport - 16 (actually
  //     touching the edge)
  //   - not inside <nav> or <header> (those legitimately bleed)
  //   - element itself has no background-color (intentional full-bleed
  //     sections set a bg-color and provide their own internal padding)
  if (rect && hasDirectText && textLen > 40 && ['P', 'LI'].includes(tag.toUpperCase()) && viewportWidth > 0) {
    const inNavHeader = el.closest && (el.closest('nav') || el.closest('header'));
    const hasOwnBg = style.backgroundColor && style.backgroundColor !== 'rgba(0, 0, 0, 0)' && style.backgroundColor !== 'transparent';
    const isPositioned = ['fixed', 'absolute'].includes(style.position || '');
    const widthRatio = rect.width / viewportWidth;
    const leftClose = rect.left < 16;
    const rightClose = rect.right > viewportWidth - 16;
    if (!inNavHeader && !hasOwnBg && !isPositioned && widthRatio > 0.5 && (leftClose || rightClose)) {
      const which = leftClose && rightClose
        ? `left ${Math.round(rect.left)}px / right ${Math.round(viewportWidth - rect.right)}px`
        : leftClose
          ? `left ${Math.round(rect.left)}px`
          : `right ${Math.round(viewportWidth - rect.right)}px`;
      findings.push({ id: 'body-text-viewport-edge', snippet: `<${tag.toLowerCase()}> with ${textLen}-char body bleeds to viewport edge (${which})` });
    }
  }

  // --- Tight line height ---
  if (hasDirectText && textLen > 50 && !['h1','h2','h3','h4','h5','h6'].includes(tag)) {
    if (lineHeightPx != null && fontSize > 0) {
      const ratio = lineHeightPx / fontSize;
      if (ratio > 0 && ratio < 1.3) {
        findings.push({ id: 'tight-leading', snippet: `line-height ${ratio.toFixed(2)}x (need >=1.3)` });
      }
    }
  }

  // --- Justified text (without hyphens) ---
  if (hasDirectText && style.textAlign === 'justify') {
    const hyphens = style.hyphens || style.webkitHyphens || '';
    if (hyphens !== 'auto') {
      findings.push({ id: 'justified-text', snippet: 'text-align: justify without hyphens: auto' });
    }
  }

  // --- Tiny body text ---
  // Only flag actual body content, not UI labels (buttons, tabs, badges, captions, footer text, etc.)
  if (hasDirectText && textLen > 20 && fontSize < 12) {
    const skipTags = ['sub', 'sup', 'code', 'kbd', 'samp', 'var', 'caption', 'figcaption'];
    const inUIContext = el.closest?.('button, a, label, summary, pre, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], nav, footer, [aria-hidden="true"], [class*="badge" i], [class*="caption" i], [class*="chip" i], [class*="code" i], [class*="console" i], [class*="diff" i], [class*="label" i], [class*="meta" i], [class*="mock" i], [class*="pill" i], [class*="preview" i], [class*="tag" i], [class*="terminal" i], [class*="writes" i]');
    const isUppercase = style.textTransform === 'uppercase';
    if (!skipTags.includes(tag) && !inUIContext && !isUppercase) {
      findings.push({ id: 'tiny-text', snippet: `${fontSize}px body text` });
    }
  }

  // --- All-caps body text ---
  if (hasDirectText && textLen > 30 && style.textTransform === 'uppercase') {
    if (!['h1','h2','h3','h4','h5','h6'].includes(tag)) {
      findings.push({ id: 'all-caps-body', snippet: `text-transform: uppercase on ${textLen} chars of body text` });
    }
  }

  // --- Wide letter spacing on body text ---
  if (hasDirectText && textLen > 20 && style.textTransform !== 'uppercase') {
    if (letterSpacingPx != null && letterSpacingPx > 0 && fontSize > 0) {
      const trackingEm = letterSpacingPx / fontSize;
      if (trackingEm > 0.05) {
        findings.push({ id: 'wide-tracking', snippet: `letter-spacing: ${trackingEm.toFixed(2)}em on body text` });
      }
    }
  }

  // --- Crushed letter spacing (mirror of wide-tracking) ---
  // Tracking pulled tighter than ~-0.05em crushes characters into each other.
  // Optical tightening that display type legitimately wants (around -0.02em)
  // stays well above this floor.
  if (hasDirectText && textLen > 20 && fontSize > 0) {
    if (letterSpacingPx != null && letterSpacingPx < 0) {
      const trackingEm = letterSpacingPx / fontSize;
      if (trackingEm <= -0.05) {
        const excerpt = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40);
        findings.push({ id: 'extreme-negative-tracking', snippet: `letter-spacing: ${trackingEm.toFixed(2)}em — "${excerpt}"` });
      }
    }
  }

  return findings;
}

export {
  resolveFontSizePx,
  resolveLengthPx,
  cssColorIsTransparent,
  checkQuality,
};
