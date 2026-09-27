// DESIGN.md body splitting: canonical H2 sections, subsections, paragraphs
// and bullets. Split out of design-parser.mjs (file-size sweep — pure move,
// no behaviour change).

import { CANONICAL_SECTIONS } from './design-parser-yaml.mjs';

const HEX_RE = /#[0-9a-fA-F]{3,8}\b/g;
const OKLCH_RE = /oklch\([^)]+\)/gi;

// ---------- Section splitting ----------

function splitSections(md) {
  const lines = md.split(/\r?\n/);
  let title = null;
  const sections = {};
  let current = null;

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (!title && line.startsWith('# ') && !line.startsWith('## ')) {
      title = line.replace(/^#\s+/, '').trim();
      continue;
    }

    const h2 = line.match(/^##\s+(?:\d+\.\s*)?([^:\n]+?)(?::\s*(.+))?$/);
    if (h2) {
      const rawName = normalizeApostrophes(h2[1].trim());
      const subtitle = h2[2] ? h2[2].trim() : null;
      const canonical = matchCanonicalSection(rawName);
      if (canonical) {
        current = { name: canonical, subtitle, lines: [] };
        sections[canonical] = current;
        continue;
      }
      // non-canonical H2 — ignore but stop feeding into current
      current = null;
      continue;
    }

    if (current) current.lines.push(raw);
  }

  return { title, sections };
}

function normalizeApostrophes(s) {
  return s.replace(/[\u2018\u2019]/g, "'");
}

function matchCanonicalSection(name) {
  const normalized = normalizeApostrophes(name).toLowerCase();
  // Exact match first
  for (const c of CANONICAL_SECTIONS) {
    if (normalizeApostrophes(c).toLowerCase() === normalized) return c;
  }
  // Keyword-contained match: "Overview & Creative North Star" -> "Overview",
  // "Elevation & Depth" -> "Elevation", etc.
  for (const c of CANONICAL_SECTIONS) {
    const key = normalizeApostrophes(c).toLowerCase();
    const pattern = new RegExp(`\\b${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    if (pattern.test(normalized)) return c;
  }
  return null;
}

// ---------- Subsection splitting (inside a canonical section) ----------

function splitSubsections(lines) {
  const subs = [];
  let current = { name: null, lines: [] };
  subs.push(current);

  for (const raw of lines) {
    const h3 = raw.match(/^###\s+(.+?)\s*$/);
    if (h3) {
      current = { name: h3[1].trim(), lines: [] };
      subs.push(current);
      continue;
    }
    current.lines.push(raw);
  }

  return subs;
}

// ---------- Generic helpers ----------

function collectParagraphs(lines) {
  const paragraphs = [];
  let buf = [];
  const flush = () => {
    if (buf.length) {
      paragraphs.push(buf.join(' ').trim());
      buf = [];
    }
  };
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (trimmed === '') { flush(); continue; }
    // Horizontal rules (---, ***) and headings/bullets end a paragraph.
    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed)) { flush(); continue; }
    if (raw.startsWith('#') || raw.match(/^[-*]\s/)) { flush(); continue; }
    buf.push(trimmed);
  }
  flush();
  return paragraphs.filter(Boolean);
}

function collectBullets(lines) {
  const bullets = [];
  let current = null;
  for (const raw of lines) {
    const m = raw.match(/^\s*[-*]\s+(.+)$/);
    if (m) {
      if (current) bullets.push(current);
      current = m[1];
      continue;
    }
    // continuation of a bullet (indented line)
    if (current && raw.match(/^\s{2,}\S/)) {
      current += ` ${raw.trim()}`;
      continue;
    }
    // blank line ends a bullet
    if (raw.trim() === '' && current) {
      bullets.push(current);
      current = null;
    }
  }
  if (current) bullets.push(current);
  return bullets;
}

function stripBold(s) {
  return s.replace(/\*\*(.+?)\*\*/g, '$1');
}

function extractNamedRules(lines) {
  const rules = [];
  const seen = new Set();

  // Style A (Monodesign): "**The X Rule.** body body body" — can span lines.
  const joined = lines.join('\n');
  const inlineStart = /\*\*(The [^*]+?Rule)\.\*\*/g;
  const inlineMatches = [];
  let m;
  while ((m = inlineStart.exec(joined)) !== null) {
    inlineMatches.push({ name: m[1], start: m.index, end: inlineStart.lastIndex });
  }
  for (let i = 0; i < inlineMatches.length; i++) {
    const mm = inlineMatches[i];
    const bodyEnd = i + 1 < inlineMatches.length ? inlineMatches[i + 1].start : joined.length;
    const body = joined
      .slice(mm.end, bodyEnd)
      .replace(/\n##[^\n]*$/s, '')
      .replace(/\n###[^\n]*$/s, '')
      .trim();
    const name = stripBold(mm.name).trim();
    seen.add(name.toLowerCase());
    rules.push({ name, body: stripBold(body) });
  }

  // Style B (Stitch): `### The "X" Rule` or `### The X Fallback`, body is the
  // bullets/paragraphs until the next heading. Accept Rule / Fallback / Principle.
  for (let i = 0; i < lines.length; i++) {
    const h3 = lines[i].match(/^###\s+(.+?)\s*$/);
    if (!h3) continue;
    const headerName = stripBold(h3[1]).replace(/["“”]/g, '').trim();
    if (!/^The\b.*\b(Rule|Fallback|Principle)\b/i.test(headerName)) continue;
    if (seen.has(headerName.toLowerCase())) continue;

    const bodyLines = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (/^##\s|^###\s/.test(lines[j])) break;
      bodyLines.push(lines[j]);
    }
    const body = stripBold(bodyLines.join('\n').replace(/\n+/g, ' ')).trim();
    if (body) {
      seen.add(headerName.toLowerCase());
      rules.push({ name: headerName, body });
    }
  }

  // Style C (Stitch bullet form): "*   **The Layering Principle:** body"
  // Colon/period lives inside the bold, so match "**...**" then inspect.
  for (const b of collectBullets(lines)) {
    const mm = b.match(/^\*\*([^*]+?)\*\*\s*(.+)$/);
    if (!mm) continue;
    const nameRaw = mm[1].replace(/[.:]\s*$/, '').replace(/["“”]/g, '').trim();
    if (!/^The\b.+\b(Rule|Fallback|Principle)$/i.test(nameRaw)) continue;
    if (seen.has(nameRaw.toLowerCase())) continue;
    seen.add(nameRaw.toLowerCase());
    rules.push({ name: nameRaw, body: stripBold(mm[2]).trim() });
  }

  return rules;
}

// ---------- Per-section extractors ----------


export {
  HEX_RE,
  OKLCH_RE,
  splitSections,
  normalizeApostrophes,
  matchCanonicalSection,
  splitSubsections,
  collectParagraphs,
  collectBullets,
  stripBold,
  extractNamedRules,
};
