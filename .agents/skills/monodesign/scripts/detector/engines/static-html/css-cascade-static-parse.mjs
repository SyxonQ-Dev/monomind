// Static-HTML CSS cascade engine: value/declaration parsing helpers. Split
// out of css-cascade.mjs (file-size sweep — pure move, no behaviour change).

import { parseAnyColor, resolveLengthPx, resolveVarRefs } from '../../rules/checks.mjs';
import { STATIC_INHERITED_PROPS, STATIC_DEFAULT_STYLE, STATIC_PROP_MAP, STATIC_NAMED_COLORS } from './css-cascade-static-data.mjs';

function splitCssList(value) {
  const parts = [];
  let depth = 0, quote = '', start = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (quote) {
      if (ch === quote && value[i - 1] !== '\\') quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    else if (ch === ',' && depth === 0) {
      parts.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }
  const tail = value.slice(start).trim();
  if (tail) parts.push(tail);
  return parts;
}

function splitCssTokens(value) {
  const tokens = [];
  let depth = 0, quote = '', current = '';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (quote) {
      current += ch;
      if (ch === quote && value[i - 1] !== '\\') quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
    if (ch === '(') { depth++; current += ch; continue; }
    if (ch === ')') { depth = Math.max(0, depth - 1); current += ch; continue; }
    if (/\s/.test(ch) && depth === 0) {
      if (current) { tokens.push(current); current = ''; }
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

function cssPropToCamel(prop) {
  if (!prop) return prop;
  const mapped = STATIC_PROP_MAP[prop];
  if (mapped) return mapped;
  return prop.replace(/-([a-z])/g, (_m, ch) => ch.toUpperCase());
}

function staticColorToCss(c) {
  if (!c) return '';
  if (c.a != null && c.a < 1) return `rgba(${c.r}, ${c.g}, ${c.b}, ${Number(c.a.toFixed(3))})`;
  return `rgb(${c.r}, ${c.g}, ${c.b})`;
}

function parseStaticColor(value) {
  const parsed = parseAnyColor(value);
  if (parsed) return parsed;
  const named = STATIC_NAMED_COLORS[String(value || '').trim().toLowerCase()];
  return named ? { ...named } : null;
}

function extractStaticColor(value) {
  if (!value) return '';
  const raw = String(value).trim();
  if (/^var\(/i.test(raw)) return raw;
  const colorLike = raw.match(/(?:rgba?\([^)]+\)|oklch\([^)]+\)|oklab\([^)]+\)|lch\([^)]+\)|lab\([^)]+\)|hsla?\([^)]+\)|hwb\([^)]+\)|#[0-9a-f]{3,8}\b|\b(?:black|white|gray|grey|silver|red|green|blue|transparent)\b)/i);
  if (!colorLike) return '';
  return colorLike[0];
}

function normalizeStaticCssValue(prop, value, customProps, parentStyle, currentStyle = null) {
  let resolved = resolveVarRefs(String(value || '').trim(), customProps);
  if (resolved === 'inherit') return parentStyle?.[prop] || STATIC_DEFAULT_STYLE[prop] || '';
  const isModernBorderColor = /^border[A-Z][a-z]+Color$/.test(prop) && /^(?:oklch|oklab|lch|lab|hsl|hwb)\(/i.test(resolved);
  if (!isModernBorderColor && (/color$/i.test(prop) || prop === 'color' || prop === 'backgroundColor')) {
    const parsed = parseStaticColor(resolved);
    if (parsed) resolved = staticColorToCss(parsed);
  }
  if (prop === 'fontSize') {
    const base = parseFloat(parentStyle?.fontSize) || 16;
    const px = resolveLengthPx(resolved, base);
    if (px != null) resolved = `${px}px`;
  }
  if (prop === 'letterSpacing') {
    const base = parseFloat(currentStyle?.fontSize || parentStyle?.fontSize) || 16;
    const px = resolveLengthPx(resolved, base);
    if (px != null) resolved = `${px}px`;
  }
  if (prop === 'lineHeight' && resolved !== 'normal') {
    const base = parseFloat(currentStyle?.fontSize || parentStyle?.fontSize) || 16;
    const px = resolveLengthPx(resolved, base);
    if (px != null) resolved = `${px}px`;
  }
  return resolved;
}

function expandStaticBoxValues(tokens) {
  if (tokens.length === 0) return ['0px', '0px', '0px', '0px'];
  if (tokens.length === 1) return [tokens[0], tokens[0], tokens[0], tokens[0]];
  if (tokens.length === 2) return [tokens[0], tokens[1], tokens[0], tokens[1]];
  if (tokens.length === 3) return [tokens[0], tokens[1], tokens[2], tokens[1]];
  return [tokens[0], tokens[1], tokens[2], tokens[3]];
}

function parseStaticBorder(value) {
  const tokens = splitCssTokens(value);
  let width = '', color = '';
  for (const token of tokens) {
    if (!width && /^-?[\d.]+(?:px|rem|em|%)$/.test(token)) width = token;
    if (!color) color = extractStaticColor(token);
  }
  return { width, color };
}

function parseStaticFont(value) {
  const out = [];
  const slashParts = value.match(/(?:^|\s)([\d.]+(?:px|rem|em|%))(?:\/([^\s]+))?/);
  if (/\bitalic\b/i.test(value)) out.push(['fontStyle', 'italic']);
  const weight = value.match(/\b([1-9]00|bold|normal|lighter|bolder)\b/i);
  if (weight) out.push(['fontWeight', weight[1]]);
  if (slashParts) {
    out.push(['fontSize', slashParts[1]]);
    if (slashParts[2]) out.push(['lineHeight', slashParts[2]]);
    const familyStart = value.indexOf(slashParts[0]) + slashParts[0].length;
    const family = value.slice(familyStart).trim();
    if (family) out.push(['fontFamily', family]);
  }
  return out;
}

function parseStaticTransition(value) {
  const props = [];
  const timings = [];
  for (const item of splitCssList(value)) {
    const tokens = splitCssTokens(item);
    const timing = tokens.find(token => /^(?:ease|linear|step-|cubic-bezier\()/i.test(token));
    if (timing) timings.push(timing);
    const prop = tokens.find(token => /^[a-z-]+$/i.test(token) && !/^(?:ease|linear|infinite|alternate|forwards|backwards|both|normal|none)$/.test(token) && !/s$/.test(token));
    if (prop) props.push(prop);
  }
  return {
    property: props.join(', '),
    timing: timings.join(', '),
  };
}

function parseStaticAnimation(value) {
  const names = [];
  const timings = [];
  for (const item of splitCssList(value)) {
    const tokens = splitCssTokens(item);
    const timing = tokens.find(token => /^(?:ease|linear|step-|cubic-bezier\()/i.test(token));
    if (timing) timings.push(timing);
    const name = tokens.find(token =>
      /^[a-z_-][\w-]*$/i.test(token) &&
      !/^(?:ease|linear|infinite|alternate|forwards|backwards|both|normal|none|running|paused)$/.test(token)
    );
    if (name) names.push(name);
  }
  return {
    name: names.join(', '),
    timing: timings.join(', '),
  };
}

function expandStaticDeclaration(prop, value) {
  const p = prop.toLowerCase();
  const v = String(value || '').trim();
  if (!v) return [];
  if (p.startsWith('--')) return [[p, v]];
  if (p === 'background') {
    const out = [];
    const hasImage = /gradient|url\(/i.test(v);
    if (hasImage) out.push(['backgroundImage', v]);
    const beforeImage = hasImage ? v.split(/(?:repeating-)?(?:linear|radial|conic)-gradient\(|url\(/i)[0] : v;
    const color = extractStaticColor(hasImage ? beforeImage : v);
    if (color) out.push(['backgroundColor', color]);
    return out;
  }
  if (p === 'border') {
    const parsed = parseStaticBorder(v);
    const out = [];
    for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
      if (parsed.width) out.push([`border${side}Width`, parsed.width]);
      if (parsed.color) out.push([`border${side}Color`, parsed.color]);
    }
    return out;
  }
  if (p === 'outline') {
    // `outline` shorthand: width | style | color, in any order. Reuse the
    // border parser for width + color, then sniff a style keyword from the
    // tokens (solid|dashed|...). `outline: 0` (single-token zero) zeros
    // the width and effectively hides the outline.
    const tokens = splitCssTokens(v);
    const parsed = parseStaticBorder(v);
    const styleToken = tokens.find(t =>
      /^(none|hidden|solid|dashed|dotted|double|groove|ridge|inset|outset)$/i.test(t)
    );
    const out = [];
    if (parsed.width) out.push(['outlineWidth', parsed.width]);
    if (parsed.color) out.push(['outlineColor', parsed.color]);
    if (styleToken) out.push(['outlineStyle', styleToken.toLowerCase()]);
    // `outline: 0` with no other tokens: explicit zero width.
    if (!parsed.width && /^0(?:px|rem|em|%)?$/.test(v.trim())) {
      out.push(['outlineWidth', '0px']);
    }
    return out;
  }
  const sideMatch = p.match(/^border-(top|right|bottom|left)$/);
  if (sideMatch) {
    const parsed = parseStaticBorder(v);
    const side = sideMatch[1][0].toUpperCase() + sideMatch[1].slice(1);
    return [
      ...(parsed.width ? [[`border${side}Width`, parsed.width]] : []),
      ...(parsed.color ? [[`border${side}Color`, parsed.color]] : []),
    ];
  }
  if (p === 'border-width') {
    const vals = expandStaticBoxValues(splitCssTokens(v));
    return [
      ['borderTopWidth', vals[0]],
      ['borderRightWidth', vals[1]],
      ['borderBottomWidth', vals[2]],
      ['borderLeftWidth', vals[3]],
    ];
  }
  if (p === 'border-color') {
    const vals = expandStaticBoxValues(splitCssTokens(v));
    return [
      ['borderTopColor', vals[0]],
      ['borderRightColor', vals[1]],
      ['borderBottomColor', vals[2]],
      ['borderLeftColor', vals[3]],
    ];
  }
  if (p === 'padding') {
    const vals = expandStaticBoxValues(splitCssTokens(v));
    return [
      ['paddingTop', vals[0]],
      ['paddingRight', vals[1]],
      ['paddingBottom', vals[2]],
      ['paddingLeft', vals[3]],
    ];
  }
  if (p === 'margin') {
    const vals = expandStaticBoxValues(splitCssTokens(v));
    return [
      ['marginTop', vals[0]],
      ['marginRight', vals[1]],
      ['marginBottom', vals[2]],
      ['marginLeft', vals[3]],
    ];
  }
  if (p === 'font') return parseStaticFont(v);
  if (p === 'transition') {
    const parsed = parseStaticTransition(v);
    return [
      ...(parsed.property ? [['transitionProperty', parsed.property]] : []),
      ...(parsed.timing ? [['transitionTimingFunction', parsed.timing]] : []),
    ];
  }
  if (p === 'animation') {
    const parsed = parseStaticAnimation(v);
    return [
      ...(parsed.name ? [['animationName', parsed.name]] : []),
      ...(parsed.timing ? [['animationTimingFunction', parsed.timing]] : []),
    ];
  }
  const mapped = cssPropToCamel(p);
  if (STATIC_DEFAULT_STYLE[mapped] != null || STATIC_INHERITED_PROPS.has(mapped)) {
    return [[mapped, v]];
  }
  return [];
}

function compareStaticPriority(a, b) {
  if (!a) return true;
  if (!!b.important !== !!a.important) return !!b.important;
  if (!!b.inline !== !!a.inline) return !!b.inline;
  for (let i = 0; i < 3; i++) {
    if ((b.specificity[i] || 0) !== (a.specificity[i] || 0)) {
      return (b.specificity[i] || 0) > (a.specificity[i] || 0);
    }
  }
  return b.order >= a.order;
}

function staticSpecificity(selector) {
  const noWhere = selector.replace(/:where\([^)]*\)/g, '');
  const ids = (noWhere.match(/#[\w-]+/g) || []).length;
  const classes = (noWhere.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+(?:\([^)]*\))?/g) || []).length;
  const stripped = noWhere
    .replace(/#[\w-]+/g, ' ')
    .replace(/\.[\w-]+|\[[^\]]+\]|:{1,2}[\w-]+(?:\([^)]*\))?/g, ' ')
    .replace(/[*>+~(),]/g, ' ');
  const types = (stripped.match(/\b[a-zA-Z][\w-]*\b/g) || []).length;
  return [ids, classes, types];
}

function applyStaticDeclaration(specified, node, prop, value, meta) {
  let map = specified.get(node);
  if (!map) { map = new Map(); specified.set(node, map); }
  for (const [expandedProp, expandedValue] of expandStaticDeclaration(prop, value)) {
    const existing = map.get(expandedProp);
    const next = { ...meta, prop: expandedProp, value: expandedValue };
    if (compareStaticPriority(existing, next)) map.set(expandedProp, next);
  }
}

function parseStaticStyleAttribute(styleText, orderBase = 0) {
  const decls = [];
  for (const part of String(styleText || '').split(';')) {
    const idx = part.indexOf(':');
    if (idx <= 0) continue;
    const prop = part.slice(0, idx).trim();
    let value = part.slice(idx + 1).trim();
    const important = /!important\s*$/i.test(value);
    value = value.replace(/\s*!important\s*$/i, '').trim();
    decls.push({ prop, value, important, order: orderBase + decls.length });
  }
  return decls;
}

function collectStaticCssRules(cssText, csstree) {
  const rules = [];
  let ast;
  try {
    ast = csstree.parse(cssText, { positions: false, parseValue: true, parseCustomProperty: false });
  } catch {
    return rules;
  }
  let order = 0;
  const walkList = (list, atRuleStack = []) => {
    list?.forEach?.(node => {
      if (node.type === 'Rule' && node.block) {
        if (atRuleStack.some(name => /keyframes$/i.test(name))) return;
        const selectorText = csstree.generate(node.prelude).trim();
        const declarations = [];
        node.block.children?.forEach?.(child => {
          if (child.type !== 'Declaration') return;
          declarations.push({
            prop: child.property,
            value: csstree.generate(child.value).trim(),
            important: !!child.important,
          });
        });
        for (const selector of splitCssList(selectorText)) {
          if (selector) rules.push({ selector, declarations, specificity: staticSpecificity(selector), order: order++ });
        }
        return;
      }
      if (node.type === 'Atrule' && node.block) {
        const name = String(node.name || '').toLowerCase();
        if (name === 'media' || name === 'supports' || name === 'layer') {
          walkList(node.block.children, [...atRuleStack, name]);
        }
      }
    });
  };
  walkList(ast.children);
  return rules;
}

export {
  splitCssList,
  splitCssTokens,
  cssPropToCamel,
  staticColorToCss,
  parseStaticColor,
  extractStaticColor,
  normalizeStaticCssValue,
  expandStaticBoxValues,
  parseStaticBorder,
  parseStaticFont,
  parseStaticTransition,
  parseStaticAnimation,
  expandStaticDeclaration,
  compareStaticPriority,
  staticSpecificity,
  applyStaticDeclaration,
  parseStaticStyleAttribute,
  collectStaticCssRules,
};
