import { uniqueStrings } from './hook-lib-config.mjs';

export function normalizeIgnoreValue(value) {
  return String(value || '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/\+/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

export function normalizeIgnoreRule(rule) {
  return String(rule || '').trim().toLowerCase();
}

function colorIgnoreKey(value) {
  const color = parseIgnoreColor(value);
  if (!color) return '';
  return `${color.r},${color.g},${color.b},${Math.round(color.a * 255)}`;
}

function parseIgnoreColor(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return null;

  const hex = text.match(/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
  if (hex) return parseHexIgnoreColor(hex[1]);

  const rgb = text.match(/^rgba?\((.*)\)$/i);
  if (rgb) {
    const parts = splitColorArgs(rgb[1]);
    if (parts.length < 3 || parts.length > 4) return null;
    const r = parseRgbChannel(parts[0]);
    const g = parseRgbChannel(parts[1]);
    const b = parseRgbChannel(parts[2]);
    const a = parts[3] === undefined ? 1 : parseAlphaChannel(parts[3]);
    if ([r, g, b, a].some((v) => v === null)) return null;
    return { r, g, b, a };
  }

  const hsl = text.match(/^hsla?\((.*)\)$/i);
  if (hsl) {
    const parts = splitColorArgs(hsl[1]);
    if (parts.length < 3 || parts.length > 4) return null;
    const h = parseHueChannel(parts[0]);
    const s = parsePercentChannel(parts[1]);
    const l = parsePercentChannel(parts[2]);
    const a = parts[3] === undefined ? 1 : parseAlphaChannel(parts[3]);
    if ([h, s, l, a].some((v) => v === null)) return null;
    return hslToRgb(h, s, l, a);
  }

  return null;
}

function parseHexIgnoreColor(hex) {
  if (hex.length === 3 || hex.length === 4) {
    const r = parseInt(hex[0] + hex[0], 16);
    const g = parseInt(hex[1] + hex[1], 16);
    const b = parseInt(hex[2] + hex[2], 16);
    const a = hex.length === 4 ? parseInt(hex[3] + hex[3], 16) / 255 : 1;
    return { r, g, b, a };
  }
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
  return { r, g, b, a };
}

function splitColorArgs(body) {
  const text = String(body || '').trim();
  if (!text) return [];
  if (text.includes(',')) {
    const parts = text.split(',').map((part) => part.trim()).filter(Boolean);
    const last = parts[parts.length - 1];
    if (last?.includes('/')) {
      const split = last.split('/').map((part) => part.trim()).filter(Boolean);
      return [...parts.slice(0, -1), ...split];
    }
    return parts;
  }
  return text.replace(/\s*\/\s*/g, ' / ').split(/\s+/).filter((part) => part && part !== '/');
}

function parseRgbChannel(raw) {
  const text = String(raw || '').trim();
  const match = text.match(/^(-?\d*\.?\d+)(%)?$/);
  if (!match) return null;
  const value = Number.parseFloat(match[1]);
  if (!Number.isFinite(value)) return null;
  const scaled = match[2] ? value * 2.55 : value;
  if (scaled < 0 || scaled > 255) return null;
  return Math.round(scaled);
}

function parseAlphaChannel(raw) {
  const text = String(raw || '').trim();
  const match = text.match(/^(-?\d*\.?\d+)(%)?$/);
  if (!match) return null;
  const value = Number.parseFloat(match[1]);
  if (!Number.isFinite(value)) return null;
  const alpha = match[2] ? value / 100 : value;
  return alpha >= 0 && alpha <= 1 ? alpha : null;
}

function parseHueChannel(raw) {
  const text = String(raw || '').trim();
  const match = text.match(/^(-?\d*\.?\d+)(deg|rad|turn|grad)?$/);
  if (!match) return null;
  const value = Number.parseFloat(match[1]);
  if (!Number.isFinite(value)) return null;
  const unit = match[2] || 'deg';
  if (unit === 'turn') return value * 360;
  if (unit === 'rad') return value * (180 / Math.PI);
  if (unit === 'grad') return value * 0.9;
  return value;
}

function parsePercentChannel(raw) {
  const text = String(raw || '').trim();
  const match = text.match(/^(-?\d*\.?\d+)%$/);
  if (!match) return null;
  const value = Number.parseFloat(match[1]);
  if (!Number.isFinite(value)) return null;
  return value >= 0 && value <= 100 ? value / 100 : null;
}

function hslToRgb(hue, saturation, lightness, alpha) {
  const h = (((hue % 360) + 360) % 360) / 360;
  if (saturation === 0) {
    const gray = clampByte(Math.round(lightness * 255));
    return { r: gray, g: gray, b: gray, a: alpha };
  }
  const q = lightness < 0.5
    ? lightness * (1 + saturation)
    : lightness + saturation - lightness * saturation;
  const p = 2 * lightness - q;
  const toRgb = (t) => {
    let channel = t;
    if (channel < 0) channel += 1;
    if (channel > 1) channel -= 1;
    if (channel < 1 / 6) return p + (q - p) * 6 * channel;
    if (channel < 1 / 2) return q;
    if (channel < 2 / 3) return p + (q - p) * (2 / 3 - channel) * 6;
    return p;
  };
  return {
    r: clampByte(Math.round(toRgb(h + 1 / 3) * 255)),
    g: clampByte(Math.round(toRgb(h) * 255)),
    b: clampByte(Math.round(toRgb(h - 1 / 3) * 255)),
    a: alpha,
  };
}

function clampByte(value) {
  return Math.min(255, Math.max(0, value));
}

export function ignoreValueMatches(rule, entryValue, findingValue) {
  if (entryValue === findingValue) return true;
  if (rule !== 'design-system-color') return false;
  const entryColor = colorIgnoreKey(entryValue);
  return Boolean(entryColor && entryColor === colorIgnoreKey(findingValue));
}

export function normalizeIgnoreValueEntries(entries) {
  if (!Array.isArray(entries)) return [];
  const out = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const rule = normalizeIgnoreRule(entry.rule);
    const value = normalizeIgnoreValue(entry.value);
    if (!rule || !value) continue;
    const normalized = { rule, value };
    const files = uniqueStrings([
      ...(typeof entry.file === 'string' && entry.file.trim() ? [entry.file.trim()] : []),
      ...(Array.isArray(entry.files) ? entry.files.filter(v => typeof v === 'string' && v.trim()).map(v => v.trim()) : []),
    ]);
    if (files.length > 0) normalized.files = files;
    if (typeof entry.reason === 'string' && entry.reason.trim()) {
      normalized.reason = entry.reason.trim();
    }
    if (typeof entry.createdAt === 'string' && entry.createdAt.trim()) {
      normalized.createdAt = entry.createdAt.trim();
    }
    out.push(normalized);
  }
  return out;
}

export function mergeIgnoreValues(existing, incoming) {
  const map = new Map();
  for (const entry of normalizeIgnoreValueEntries(existing)) {
    map.set(`${entry.rule}\0${entry.value}\0${ignoreValueFilesKey(entry.files)}`, entry);
  }
  for (const entry of normalizeIgnoreValueEntries(incoming)) {
    map.set(`${entry.rule}\0${entry.value}\0${ignoreValueFilesKey(entry.files)}`, entry);
  }
  return Array.from(map.values());
}

function ignoreValueFilesKey(files) {
  return Array.isArray(files) && files.length > 0 ? files.join('\x1f') : '';
}
