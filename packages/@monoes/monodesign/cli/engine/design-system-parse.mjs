// Design-system source parsing: DESIGN.md/sidecar path resolution,
// frontmatter/YAML parsing, color/font normalization, and building the
// normalized designSystem object. Split out of design-system.mjs (file-size
// sweep — pure move, no behaviour change).

import fs from 'node:fs';
import path from 'node:path';

import { GENERIC_FONTS } from './shared/constants.mjs';
import { parseAnyColor, resolveLengthPx } from './rules/checks.mjs';

const DESIGN_NAMES = ['DESIGN.md', 'Design.md', 'design.md'];
const FALLBACK_DIRS = ['.agents/context', 'docs'];
const COLOR_CHANNEL_TOLERANCE = 6;
const FONT_SIZE_LITERAL_RE = /^-?[\d.]+(?:px|rem)$/;

function firstExisting(dir, names) {
  for (const name of names) {
    const abs = path.join(dir, name);
    if (fs.existsSync(abs)) return abs;
  }
  return null;
}

function resolveDesignMdPath(cwd = process.cwd()) {
  const root = firstExisting(cwd, DESIGN_NAMES);
  if (root) return { path: root, contextDir: cwd };

  for (const rel of FALLBACK_DIRS) {
    const dir = path.resolve(cwd, rel);
    const found = firstExisting(dir, DESIGN_NAMES);
    if (found) return { path: found, contextDir: dir };
  }

  return null;
}

function resolveDesignSidecarPath(cwd = process.cwd(), contextDir = cwd) {
  const candidates = [
    path.join(cwd, '.monodesign', 'design.json'),
    path.join(cwd, 'DESIGN.json'),
    path.join(contextDir, 'DESIGN.json'),
  ];
  return candidates.find((candidate, index) =>
    candidates.indexOf(candidate) === index && fs.existsSync(candidate)
  ) || null;
}

function parseFrontmatter(md) {
  const lines = String(md || '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return null;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { end = i; break; }
  }
  if (end === -1) return null;
  try {
    return parseYamlSubset(lines.slice(1, end).join('\n'));
  } catch {
    return null;
  }
}

function parseYamlSubset(yaml) {
  const root = {};
  const stack = [{ indent: -1, obj: root }];

  for (const raw of String(yaml || '').split(/\r?\n/)) {
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    const indent = raw.match(/^\s*/)[0].length;
    const content = raw.slice(indent);
    const colonIdx = findTopLevelColon(content);
    if (colonIdx === -1) continue;

    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();

    const key = unquoteYamlKey(content.slice(0, colonIdx).trim());
    const rest = stripInlineYamlComment(content.slice(colonIdx + 1).trim());
    const parent = stack[stack.length - 1].obj;

    if (rest === '') {
      const obj = {};
      parent[key] = obj;
      stack.push({ indent, obj });
    } else {
      parent[key] = parseScalar(rest);
    }
  }

  return root;
}

function findTopLevelColon(s) {
  let inQuote = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuote) {
      if (ch === inQuote && s[i - 1] !== '\\') inQuote = null;
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === ':') {
      return i;
    }
  }
  return -1;
}

function unquoteYamlKey(key) {
  if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
    return key.slice(1, -1);
  }
  return key;
}

function stripInlineYamlComment(s) {
  let inQuote = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuote) {
      if (ch === inQuote && s[i - 1] !== '\\') inQuote = null;
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === '#' && i > 0 && /\s/.test(s[i - 1])) {
      return s.slice(0, i).trimEnd();
    }
  }
  return s;
}

function parseScalar(raw) {
  const s = raw.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  if (/^-?\d+$/.test(s)) return Number(s);
  if (/^-?\d*\.\d+$/.test(s)) return Number(s);
  return s;
}

function safeReadJson(filePath) {
  if (!filePath) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function normalizeFontName(value) {
  return String(value || '')
    .trim()
    .replace(/\s*!important\s*$/i, '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/\+/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function splitFontStack(stack) {
  return String(stack || '')
    .replace(/\s*!important\s*$/i, '')
    .split(',')
    .map(normalizeFontName)
    .filter(Boolean);
}

function primaryFont(stack) {
  if (!stack || /var\(/i.test(stack) || !isLiteralFontStack(stack)) return '';
  return splitFontStack(stack).find(font => !GENERIC_FONTS.has(font)) || '';
}

function isLiteralFontStack(stack) {
  const text = String(stack || '');
  return !/[$`{}]|\s\+\s|\|\|/.test(text);
}

function cssColorLabel(raw) {
  return String(raw || '').trim().replace(/\s+/g, ' ');
}

function colorKey(color) {
  if (!color) return '';
  return `${color.r},${color.g},${color.b}`;
}

function colorsClose(a, b) {
  if (!a || !b) return false;
  return Math.max(
    Math.abs(a.r - b.r),
    Math.abs(a.g - b.g),
    Math.abs(a.b - b.b),
  ) <= COLOR_CHANNEL_TOLERANCE;
}

function hslToRgb(H, S, L, alpha = 1) {
  const h = (((H % 360) + 360) % 360) / 360;
  const s = Math.max(0, Math.min(1, S));
  const l = Math.max(0, Math.min(1, L));
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return {
    r: Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    g: Math.round(hue2rgb(p, q, h) * 255),
    b: Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
    a: alpha,
  };
}

function parseDesignColor(value) {
  const text = String(value || '').trim();
  const parsed = parseAnyColor(text);
  if (parsed) return parsed;
  const hsl = text.match(/hsla?\(\s*([-\d.]+)(?:deg)?\s*,?\s*([\d.]+)%\s*,?\s*([\d.]+)%(?:\s*[,/]\s*([\d.]+))?\s*\)/i);
  if (hsl) {
    return hslToRgb(
      parseFloat(hsl[1]),
      parseFloat(hsl[2]) / 100,
      parseFloat(hsl[3]) / 100,
      hsl[4] !== undefined ? parseFloat(hsl[4]) : 1,
    );
  }
  return null;
}

function addDesignColor(out, value, label) {
  const parsed = parseDesignColor(value);
  if (!parsed) return;
  const key = colorKey(parsed);
  if (!out.allowedColorKeys.has(key)) {
    out.allowedColorKeys.set(key, { color: parsed, labels: [] });
  }
  out.allowedColorKeys.get(key).labels.push(label || cssColorLabel(value));
}

function addColorObject(out, colors, prefix = 'colors') {
  if (!colors || typeof colors !== 'object') return;
  for (const [name, value] of Object.entries(colors)) {
    if (typeof value === 'string') {
      addDesignColor(out, value, `${prefix}.${name}`);
    }
  }
}

function addSidecarColors(out, sidecar) {
  const colorMeta = sidecar?.extensions?.colorMeta;
  if (!colorMeta || typeof colorMeta !== 'object') return;

  for (const [name, meta] of Object.entries(colorMeta)) {
    if (!meta || typeof meta !== 'object') continue;
    if (typeof meta.canonical === 'string') addDesignColor(out, meta.canonical, `sidecar.${name}`);
    if (Array.isArray(meta.tonalRamp)) {
      for (const [index, value] of meta.tonalRamp.entries()) {
        if (typeof value === 'string') addDesignColor(out, value, `sidecar.${name}.tonalRamp[${index}]`);
      }
    }
  }
}

function addTypographyFonts(out, typography) {
  if (!typography || typeof typography !== 'object') return;
  for (const role of Object.values(typography)) {
    if (!role || typeof role !== 'object') continue;
    if (typeof role.fontFamily !== 'string') continue;
    for (const font of splitFontStack(role.fontFamily)) {
      if (!GENERIC_FONTS.has(font)) out.allowedFonts.add(font);
    }
  }
}

function addTypographySizes(out, typography) {
  if (!typography || typeof typography !== 'object') return;
  for (const role of Object.values(typography)) {
    if (!role || typeof role !== 'object') continue;
    const raw = String(role.fontSize ?? '').trim().toLowerCase();
    if (!FONT_SIZE_LITERAL_RE.test(raw)) continue;
    const px = resolveLengthPx(raw, 16);
    if (px == null || !Number.isFinite(px) || px <= 0) continue;
    out.allowedFontSizes.push({ value: raw, px });
  }
}

function addRoundedScale(out, rounded) {
  if (!rounded || typeof rounded !== 'object') return;
  for (const [rawName, value] of Object.entries(rounded)) {
    const name = unquoteYamlKey(rawName).toLowerCase();
    addRoundedToken(out, name, value);
  }
}

function addRoundedToken(out, name, value) {
  if (typeof value !== 'string' && typeof value !== 'number') return;
  const raw = String(value).trim();
  if (!raw || /var\(/i.test(raw) || raw.includes('%')) return;
  const px = resolveLengthPx(raw, 16);
  if (px == null || !Number.isFinite(px)) return;
  out.allowedRadii.push({ name, value: raw, px });
  if (/(^|\.)(full|pill|round|rounded-full)$/.test(name)) out.hasPillRadius = true;
}

function addSidecarRadii(out, sidecar) {
  const roundedMeta = sidecar?.extensions?.roundedMeta;
  if (!roundedMeta || typeof roundedMeta !== 'object') return;

  for (const [rawName, meta] of Object.entries(roundedMeta)) {
    const name = unquoteYamlKey(rawName).toLowerCase();
    if (typeof meta === 'string' || typeof meta === 'number') {
      addRoundedToken(out, `sidecar.${name}`, meta);
      continue;
    }
    if (!meta || typeof meta !== 'object') continue;
    for (const key of ['canonical', 'value']) {
      if (typeof meta[key] === 'string' || typeof meta[key] === 'number') {
        addRoundedToken(out, `sidecar.${name}.${key}`, meta[key]);
      }
    }
    for (const key of ['values', 'aliases']) {
      if (!Array.isArray(meta[key])) continue;
      for (const [index, value] of meta[key].entries()) {
        addRoundedToken(out, `sidecar.${name}.${key}[${index}]`, value);
      }
    }
    if (/^(full|pill|round|rounded-full)$/.test(name) || /^(full|pill|round)$/i.test(String(meta.role || ''))) {
      out.hasPillRadius = true;
    }
  }
}

function normalizeDesignSystem(input = {}) {
  const frontmatter = input.frontmatter || {};
  const sidecar = input.sidecar || null;
  const out = {
    present: true,
    sourcePath: input.sourcePath || null,
    sidecarPath: input.sidecarPath || null,
    mdNewerThanJson: input.mdNewerThanJson === true,
    allowedFonts: new Set(),
    allowedColorKeys: new Map(),
    allowedRadii: [],
    allowedFontSizes: [],
    hasPillRadius: false,
  };

  addTypographyFonts(out, frontmatter.typography);
  addTypographySizes(out, frontmatter.typography);
  addColorObject(out, frontmatter.colors);
  addSidecarColors(out, sidecar);
  addRoundedScale(out, frontmatter.rounded);
  addSidecarRadii(out, sidecar);

  out.hasFonts = out.allowedFonts.size > 0;
  out.hasColors = out.allowedColorKeys.size > 0;
  out.hasRadii = out.allowedRadii.length > 0;
  out.hasFontSizes = out.allowedFontSizes.length > 0;
  return out;
}

function loadDesignSystemForCwd(cwd = process.cwd()) {
  const md = resolveDesignMdPath(cwd);
  if (!md) return null;

  let frontmatter = null;
  let mdStat = null;
  try {
    mdStat = fs.statSync(md.path);
    frontmatter = parseFrontmatter(fs.readFileSync(md.path, 'utf-8'));
  } catch {
    return null;
  }
  if (!frontmatter || typeof frontmatter !== 'object') return null;

  const sidecarPath = resolveDesignSidecarPath(cwd, md.contextDir);
  const sidecar = safeReadJson(sidecarPath);
  let sidecarStat = null;
  try {
    if (sidecarPath) sidecarStat = fs.statSync(sidecarPath);
  } catch {
    sidecarStat = null;
  }

  return normalizeDesignSystem({
    frontmatter,
    sidecar,
    sourcePath: md.path,
    sidecarPath,
    mdNewerThanJson: !!(mdStat && sidecarStat && mdStat.mtimeMs > sidecarStat.mtimeMs + 1000),
  });
}


export {
  FONT_SIZE_LITERAL_RE,
  firstExisting,
  resolveDesignMdPath,
  resolveDesignSidecarPath,
  parseFrontmatter,
  parseYamlSubset,
  findTopLevelColon,
  unquoteYamlKey,
  stripInlineYamlComment,
  parseScalar,
  safeReadJson,
  normalizeFontName,
  splitFontStack,
  primaryFont,
  isLiteralFontStack,
  cssColorLabel,
  colorKey,
  colorsClose,
  hslToRgb,
  parseDesignColor,
  addDesignColor,
  addColorObject,
  addSidecarColors,
  addTypographyFonts,
  addTypographySizes,
  addRoundedScale,
  addRoundedToken,
  addSidecarRadii,
  normalizeDesignSystem,
  loadDesignSystemForCwd,
};
