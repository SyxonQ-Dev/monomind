import path from 'node:path';
import { normalizeIgnoreValue, normalizeIgnoreRule, ignoreValueMatches, normalizeIgnoreValueEntries } from './hook-lib-ignore.mjs';
import { ensureSession, ensureFile } from './hook-lib-cache.mjs';

// Glob → RegExp. Supports `**`, `*`, `?`, and `{a,b}` alternation.
function globToRegex(glob) {
  let re = '^';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i += 2;
        if (glob[i] === '/') i += 1;
      } else {
        re += '[^/]*';
        i += 1;
      }
    } else if (c === '?') {
      re += '[^/]';
      i += 1;
    } else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end === -1) { re += '\\{'; i += 1; continue; }
      const parts = glob.slice(i + 1, end).split(',').map((p) => p.replace(/[.+^$()|[\]\\]/g, '\\$&'));
      re += `(?:${parts.join('|')})`;
      i = end + 1;
    } else if (/[.+^$()|[\]\\]/.test(c)) {
      re += `\\${c}`;
      i += 1;
    } else {
      re += c;
      i += 1;
    }
  }
  re += '$';
  return new RegExp(re);
}

export function matchesAnyGlob(filePath, globs) {
  if (!Array.isArray(globs) || globs.length === 0) return false;
  const normalized = filePath.split(path.sep).join('/');
  for (const glob of globs) {
    try {
      const re = globToRegex(String(glob));
      if (re.test(normalized)) return true;
      // Match against basename too for convenience: `*.generated.tsx` should
      // catch `src/foo.generated.tsx` without requiring `**/`.
      const base = normalized.split('/').pop();
      if (re.test(base)) return true;
    } catch {
      /* malformed glob, skip */
    }
  }
  return false;
}

export function filterFindings(findings, _content, _ext, config) {
  if (!Array.isArray(findings) || findings.length === 0) return [];
  const ignoreRules = new Set((config.ignoreRules || []).map((rule) => normalizeIgnoreRule(rule)));
  const ignoreValues = normalizeIgnoreValueEntries(config.ignoreValues || []);
  return findings.filter((f) => {
    if (!f || typeof f !== 'object') return false;
    if (ignoreRules.has(normalizeIgnoreRule(f.antipattern))) return false;
    if (isIgnoredFindingValue(f, ignoreValues)) return false;
    return true;
  });
}

function isIgnoredFindingValue(finding, ignoreValues) {
  if (!Array.isArray(ignoreValues) || ignoreValues.length === 0) return false;
  const rule = normalizeIgnoreRule(finding.antipattern);
  if (!rule) return false;
  // File-scoped wildcards suppress rules with no extractable value, such as side-tab.
  const value = extractFindingIgnoreValue(finding);
  return ignoreValues.some((entry) => {
    if (entry.rule !== rule) return false;
    const wildcardValue = entry.value === '*';
    if (!wildcardValue && (!value || !ignoreValueMatches(rule, entry.value, value))) return false;
    if (!Array.isArray(entry.files) || entry.files.length === 0) return !wildcardValue;
    return findingMatchesScopedIgnoreFile(finding, entry.files);
  });
}

function findingMatchesScopedIgnoreFile(finding, globs) {
  const filePath = String(finding?.file || '').trim();
  if (!filePath) return false;
  if (matchesAnyGlob(filePath, globs)) return true;

  const normalized = filePath.split(path.sep).join('/');
  const parts = normalized.split('/').filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const suffix = parts.slice(i).join('/');
    if (matchesAnyGlob(suffix, globs)) return true;
  }
  return false;
}

export function extractFindingIgnoreValue(finding) {
  if (!finding || typeof finding !== 'object') return '';
  const rule = normalizeIgnoreRule(finding.antipattern);
  const directValueRules = new Set([
    'overused-font',
    'bounce-easing',
    'design-system-font',
    'design-system-color',
    'design-system-radius',
  ]);
  if (!directValueRules.has(rule)) return '';
  return normalizeIgnoreValue(extractFindingIgnoreValueRaw(finding, rule));
}

export function extractFindingIgnoreValueRaw(finding, rule = normalizeIgnoreRule(finding?.antipattern)) {
  const direct = cleanIgnoreValueDisplay(finding.ignoreValue || finding.value || '');
  if (direct) return direct;

  const candidates = [finding.detail, finding.snippet].filter((v) => typeof v === 'string' && v);
  for (const text of candidates) {
    if (rule === 'bounce-easing') {
      const motion = extractMotionIgnoreValue(text);
      if (motion) return motion;
      continue;
    }

    const primary = text.match(/Primary font:\s*([^()\n;]+)/i);
    if (primary) return cleanIgnoreValueDisplay(primary[1]);

    const family = text.match(/font-family\s*:\s*["']?([^'",;\n]+)/i);
    if (family) return cleanIgnoreValueDisplay(family[1]);

    const google = text.match(/[?&]family=([^&:;\n]+)/i);
    if (google) {
      try {
        return cleanIgnoreValueDisplay(decodeURIComponent(google[1]));
      } catch {
        return cleanIgnoreValueDisplay(google[1]);
      }
    }
  }

  return '';
}

function extractMotionIgnoreValue(text) {
  const tailwind = text.match(/\banimate-bounce\b/i);
  if (tailwind) return cleanIgnoreValueDisplay(tailwind[0]);

  const bezier = text.match(/cubic-bezier\([^)]+\)/i);
  if (bezier) return cleanIgnoreValueDisplay(bezier[0]);

  const animation = text.match(/animation(?:-name)?\s*:\s*([^;\n]+)/i);
  if (animation) {
    const token = animation[1]
      .split(/[,\s]+/)
      .find((part) => /bounce|elastic|wobble|jiggle|spring/i.test(part));
    if (token) return cleanIgnoreValueDisplay(token);
  }

  return '';
}

function cleanIgnoreValueDisplay(value) {
  return String(value || '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/\+/g, ' ')
    .replace(/\s+/g, ' ');
}

export function dedupeAgainstCache(findings, cache, sessionId, filePath) {
  if (!Array.isArray(findings) || findings.length === 0) return [];
  const fileEntry = ensureFile(cache, sessionId, filePath);
  const known = new Set(fileEntry.findings || []);
  const fresh = [];
  for (const f of findings) {
    const key = findingCacheKey(f);
    if (known.has(key)) continue;
    known.add(key);
    fresh.push(f);
  }
  return fresh;
}

export function rememberFindings(cache, sessionId, filePath, findings) {
  const fileEntry = ensureFile(cache, sessionId, filePath);
  const known = new Set(fileEntry.findings || []);
  for (const f of findings) known.add(findingCacheKey(f));
  fileEntry.findings = Array.from(known);
  ensureSession(cache, sessionId).updatedAt = Date.now();
}

function findingCacheKey(finding) {
  const line = finding?.line || 0;
  const value = extractFindingIgnoreValue(finding);
  if (line > 0 && value) return `${finding.antipattern}:${line}:${value}`;
  if (line > 0) return `${finding.antipattern}:${line}`;
  if (value) return `${finding.antipattern}:0:${value}`;
  const snippet = String(finding?.snippet || '').trim().slice(0, 80);
  return snippet ? `${finding.antipattern}:0:${snippet}` : `${finding.antipattern}:0`;
}
