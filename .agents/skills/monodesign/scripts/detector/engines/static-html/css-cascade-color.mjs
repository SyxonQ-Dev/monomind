// jsdom CSS-variable border override map + @layer unwrapping. Split out of
// css-cascade.mjs (file-size sweep — pure move, no behaviour change).

// ---------------------------------------------------------------------------
// jsdom CSS-variable border override map
// ---------------------------------------------------------------------------
//
// jsdom's CSSOM silently drops any border shorthand that contains a var()
// reference — the computed style for the element then shows empty width,
// empty style, and a default black color. That's enough to hide the most
// common real-world side-tab pattern in AI-generated pages:
//
//   :root { --brand: #87a8ff; }
//   .card { border-left: 5px solid var(--brand); border-radius: 4px; }
//
// Real browsers (and therefore the browser detector path) resolve var()
// natively, so this only affects the Node jsdom path.
//
// This pre-pass walks the stylesheets, finds any rule whose per-side or
// all-sides border property contains var(), resolves the var() against
// :root-level custom properties (read from the documentElement's computed
// style, which jsdom DOES handle correctly), and attaches the resolved
// width+color to every element that matches the rule's selector. The
// Node-side `checkElementBorders` adapter consumes that map as a fallback
// whenever jsdom's computed style came back empty.
//
// Limitations (intentional, to keep the pass simple):
//   * Only :root-level custom properties are resolved. Scoped overrides on
//     descendants are not tracked — uncommon in practice and would require
//     a per-element cascade walk.
//   * @media / @supports wrapped rules are ignored (jsdom often mishandles
//     these anyway).
//   * The fallback only fills sides that jsdom left empty, so any rule
//     whose border parses normally still wins via the computed style.

const BORDER_SHORTHAND_RE = /^(\d+(?:\.\d+)?)px\s+(solid|dashed|dotted|double|groove|ridge|inset|outset)\s+(.+)$/i;

// isNeutralColor only understands rgba()/oklch()/lch()/lab()/hsl()/hwb().
// CSS variables typically hold hex or named colors, so normalize those to
// rgb() before handing the value off to the shared check. Anything we don't
// recognise is passed through unchanged — isNeutralColor then treats it as
// non-neutral, which is the safer default (matches the oklch-era bugfix).
const NAMED_COLORS = {
  white: [255, 255, 255], black: [0, 0, 0], gray: [128, 128, 128],
  grey: [128, 128, 128], silver: [192, 192, 192], red: [255, 0, 0],
  green: [0, 128, 0], blue: [0, 0, 255], yellow: [255, 255, 0],
};

function normalizeColorForCheck(value) {
  if (!value) return value;
  const v = value.trim();
  const hex6 = v.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (hex6) {
    const [r, g, b] = [parseInt(hex6[1], 16), parseInt(hex6[2], 16), parseInt(hex6[3], 16)];
    return `rgb(${r}, ${g}, ${b})`;
  }
  const hex3 = v.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i);
  if (hex3) {
    const [r, g, b] = [
      parseInt(hex3[1] + hex3[1], 16),
      parseInt(hex3[2] + hex3[2], 16),
      parseInt(hex3[3] + hex3[3], 16),
    ];
    return `rgb(${r}, ${g}, ${b})`;
  }
  const named = NAMED_COLORS[v.toLowerCase()];
  if (named) return `rgb(${named[0]}, ${named[1]}, ${named[2]})`;
  return v;
}

function buildBorderOverrideMap(document, window) {
  const map = new Map();
  const rootStyle = window.getComputedStyle(document.documentElement);

  function resolveVar(value, depth = 0) {
    if (!value || depth > 10 || !value.includes('var(')) return value;
    return value.replace(
      /var\(\s*(--[\w-]+)\s*(?:,\s*([^)]+))?\s*\)/g,
      (_, name, fallback) => {
        const v = rootStyle.getPropertyValue(name).trim();
        if (v) return resolveVar(v, depth + 1);
        if (fallback) return resolveVar(fallback.trim(), depth + 1);
        return '';
      }
    );
  }

  function parseShorthand(text) {
    const m = text.trim().match(BORDER_SHORTHAND_RE);
    if (!m) return null;
    return { width: parseFloat(m[1]), color: normalizeColorForCheck(m[3]) };
  }

  // Read from the per-property accessors on rule.style. jsdom preserves
  // each border-* shorthand it parsed, even when the overall cssText has
  // been truncated (e.g. a `border: 1px solid var(...)` followed by a
  // `border-left: ...` loses the first declaration but keeps the second).
  const SIDE_PROPS = [
    ['borderLeft', 'Left'],
    ['borderRight', 'Right'],
    ['borderTop', 'Top'],
    ['borderBottom', 'Bottom'],
    ['borderInlineStart', 'Left'],
    ['borderInlineEnd', 'Right'],
  ];

  for (const sheet of document.styleSheets) {
    let rules;
    try { rules = sheet.cssRules || []; } catch { continue; }
    for (const rule of rules) {
      // CSSStyleRule only; skip @media / @keyframes / @supports wrappers.
      if (rule.type !== 1 || !rule.style || !rule.selectorText) continue;

      const perSide = {};

      for (const [prop, side] of SIDE_PROPS) {
        const val = rule.style[prop];
        if (!val?.includes('var(')) continue;
        const parsed = parseShorthand(resolveVar(val));
        if (parsed?.color) perSide[side] = parsed;
      }

      // Uniform `border: <w> <style> var(...)` applies to every side the
      // per-side map didn't already claim.
      const borderAll = rule.style.border;
      if (borderAll?.includes('var(')) {
        const parsed = parseShorthand(resolveVar(borderAll));
        if (parsed?.color) {
          for (const s of ['Top', 'Right', 'Bottom', 'Left']) {
            if (!perSide[s]) perSide[s] = parsed;
          }
        }
      }

      // Longhand `border-*-color: var(...)` with width/style in separate
      // declarations. Rare in AI-generated pages, but cheap to cover.
      for (const [prop, side] of [
        ['borderLeftColor', 'Left'],
        ['borderRightColor', 'Right'],
        ['borderTopColor', 'Top'],
        ['borderBottomColor', 'Bottom'],
      ]) {
        const val = rule.style[prop];
        if (!val?.includes('var(')) continue;
        const resolved = resolveVar(val).trim();
        if (!resolved) continue;
        // Width may or may not come from this rule — that's fine; the
        // adapter only substitutes the color when jsdom left it as a
        // literal var() string.
        if (!perSide[side]) perSide[side] = { width: 0, color: normalizeColorForCheck(resolved) };
      }

      if (Object.keys(perSide).length === 0) continue;

      let matched;
      try { matched = document.querySelectorAll(rule.selectorText); }
      catch { continue; }

      for (const el of matched) {
        const existing = map.get(el);
        if (existing) {
          // Later rules overwrite earlier ones — approximates source-order
          // cascade for equal-specificity rules and is good enough for the
          // uncontested var()-dropped sides we're trying to recover.
          Object.assign(existing, perSide);
        } else {
          map.set(el, { ...perSide });
        }
      }
    }
  }

  return map;
}

// Strip `@layer NAME { … }` wrappers from a CSS / HTML source, leaving
// the inner rules as flat CSS. jsdom doesn't implement CSS @layer, so
// any rule inside a layer block becomes invisible to getComputedStyle.
// Tailwind v4 makes this ubiquitous: every utility class lives in
// `@layer utilities`, and Preflight lives in `@layer base`. Without
// unwrapping, every Tailwind-styled element returns empty computed
// styles. We walk the source character-by-character, balancing braces
// so we correctly handle nested style rules inside the layer block.
function unwrapCssAtLayer(source) {
  // biome-ignore lint/complexity/useOptionalChain: exported helper with no typed callers; `source?.includes` would throw for a falsy non-string (0/false) that this guard currently returns unchanged
  if (!source || !source.includes('@layer')) return source;
  // Find `@layer <name>? {` openers. The match starts at the @, and
  // we then balance braces from the opening { onward.
  const re = /@layer\b[^{;]*\{/g;
  let out = '';
  let lastIdx = 0;
  let m;
  while ((m = re.exec(source)) !== null) {
    const openStart = m.index;
    const openEnd = m.index + m[0].length; // position right after `{`
    let depth = 1;
    let i = openEnd;
    while (i < source.length && depth > 0) {
      const c = source.charCodeAt(i);
      if (c === 0x7b /* { */) depth++;
      else if (c === 0x7d /* } */) depth--;
      i++;
    }
    if (depth !== 0) {
      // Unbalanced — bail and return source unchanged.
      return source;
    }
    // Emit everything before the @layer, then the inner contents
    // (between the opening { and the matched closing }), then advance.
    out += source.slice(lastIdx, openStart);
    out += source.slice(openEnd, i - 1); // i-1 = position of the closing }
    lastIdx = i;
    re.lastIndex = i;
  }
  out += source.slice(lastIdx);
  return out;
}

export { BORDER_SHORTHAND_RE, NAMED_COLORS, normalizeColorForCheck, buildBorderOverrideMap, unwrapCssAtLayer };
