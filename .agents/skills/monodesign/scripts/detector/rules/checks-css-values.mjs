function buildCustomPropMap(document) {
  const map = new Map();
  let sheets;
  try { sheets = Array.from(document.styleSheets || []); }
  catch { return map; }
  for (const sheet of sheets) {
    let rules;
    try { rules = Array.from(sheet.cssRules || []); }
    catch { continue; }
    for (const rule of rules) {
      // Style rules only (type 1). Walk @media / @supports if present.
      if (rule.type === 4 /* MEDIA_RULE */ || rule.type === 12 /* SUPPORTS_RULE */) {
        try { rules.push(...Array.from(rule.cssRules || [])); } catch { /* ignore */ }
        continue;
      }
      if (rule.type !== 1 /* STYLE_RULE */) continue;
      const sel = rule.selectorText || '';
      if (!/(^|,\s*)(:root|html|:host)\b/i.test(sel)) continue;
      const style = rule.style;
      if (!style) continue;
      for (let i = 0; i < style.length; i++) {
        const prop = style[i];
        if (!prop?.startsWith('--')) continue;
        const val = style.getPropertyValue(prop).trim();
        if (val) map.set(prop, val);
      }
    }
  }
  return map;
}

// Resolve var(--X[, fallback]) refs in a computed-style value string.
// Recurses up to 8 levels for chained refs (--a: var(--b)). Returns
// the original string when no refs are present or the chain doesn't
// resolve. Safe to call on already-resolved values.
function resolveVarRefs(raw, customPropMap, depth = 0) {
  if (typeof raw !== 'string' || !raw.includes('var(')) return raw;
  if (depth > 8) return raw;
  return raw.replace(/var\(\s*(--[a-zA-Z0-9_-]+)\s*(?:,\s*([^)]+))?\)/g, (_m, name, fallback) => {
    const v = customPropMap.get(name);
    if (v != null) return resolveVarRefs(v, customPropMap, depth + 1);
    return fallback ? resolveVarRefs(fallback.trim(), customPropMap, depth + 1) : _m;
  });
}

// OKLCH → sRGB conversion (Björn Ottosson's matrices). L in 0..1 (or %),
// C in 0..~0.4 typical, H in degrees. Returns clamped {r,g,b,a:1} in 0..255.
// Needed because jsdom doesn't compute oklch() values — getComputedStyle
// returns the literal "oklch(...)" string. Without this, the entire
// Tailwind v4 color palette (which is OKLCH-based) is invisible to the
// detector's contrast / color checks.
function oklchToRgb(L, C, H) {
  const hRad = (H * Math.PI) / 180;
  const a = C * Math.cos(hRad);
  const b = C * Math.sin(hRad);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const lc = l_ * l_ * l_, mc = m_ * m_ * m_, sc = s_ * s_ * s_;
  const rLin =  4.0767416621 * lc - 3.3077115913 * mc + 0.2309699292 * sc;
  const gLin = -1.2684380046 * lc + 2.6097574011 * mc - 0.3413193965 * sc;
  const bLin = -0.0041960863 * lc - 0.7034186147 * mc + 1.7076147010 * sc;
  const enc = (x) => {
    const c = Math.max(0, Math.min(1, x));
    return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
  };
  return {
    r: Math.round(enc(rLin) * 255),
    g: Math.round(enc(gLin) * 255),
    b: Math.round(enc(bLin) * 255),
    a: 1,
  };
}

// Extended color parser: rgb/rgba/hex/oklch. Returns null on no match.
// Use this when the input might be any CSS color form; use plain parseRgb
// when you only expect computed rgb() values from real browsers.
function parseAnyColor(s) {
  if (!s || typeof s !== 'string') return null;
  const str = s.trim();
  if (str === 'transparent' || str === 'currentcolor' || str === 'inherit') return null;
  let m;
  m = str.match(/rgba?\(\s*(\d+(?:\.\d+)?)\s*,?\s*(\d+(?:\.\d+)?)\s*,?\s*(\d+(?:\.\d+)?)(?:\s*[,/]\s*([\d.]+))?\s*\)/);
  if (m) return { r: Math.round(+m[1]), g: Math.round(+m[2]), b: Math.round(+m[3]), a: m[4] !== undefined ? +m[4] : 1 };
  m = str.match(/^#([0-9a-f]{3,8})$/i);
  if (m) {
    const h = m[1];
    if (h.length === 3 || h.length === 4) {
      return {
        r: parseInt(h[0] + h[0], 16),
        g: parseInt(h[1] + h[1], 16),
        b: parseInt(h[2] + h[2], 16),
        a: h.length === 4 ? parseInt(h[3] + h[3], 16) / 255 : 1,
      };
    }
    if (h.length === 6 || h.length === 8) {
      return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16),
        a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
      };
    }
  }
  // OKLCH parser. Tailwind v4's CSS minifier squishes the space after
  // `%` ("21.5%.02 50"), so the separator between L and C may be absent.
  // Match L (with optional %), then C and H separated permissively.
  m = str.match(/oklch\(\s*([\d.]+)(%?)\s*[\s,]*\s*([\d.]+)\s*[\s,]+\s*([-\d.]+)(?:deg)?(?:\s*\/\s*([\d.]+)(%)?)?\s*\)/i);
  if (m) {
    const Lnum = parseFloat(m[1]);
    const L = m[2] === '%' ? Lnum / 100 : Lnum;
    const rgb = oklchToRgb(L, parseFloat(m[3]), parseFloat(m[4]));
    if (m[5] !== undefined) {
      const alpha = parseFloat(m[5]);
      rgb.a = m[6] === '%' ? alpha / 100 : alpha;
    }
    return rgb;
  }
  return null;
}

// Resolve var() refs in a color string (via customPropMap), then parse.
// Returns null on any failure. Used in jsdom-mode paths where
// getComputedStyle returns literal "var(--X)" or "oklch(...)" strings.
function parseColorResolved(str, customPropMap) {
  if (!str) return null;
  const resolved = customPropMap ? resolveVarRefs(str, customPropMap) : str;
  return parseAnyColor(resolved);
}

export {
  buildCustomPropMap,
  resolveVarRefs,
  oklchToRgb,
  parseAnyColor,
  parseColorResolved,
};
