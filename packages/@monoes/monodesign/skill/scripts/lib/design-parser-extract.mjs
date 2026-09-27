// DESIGN.md "Typography", "Elevation", "Components", "Do's and Don'ts"
// section extraction, plus frontmatter/prose coverage scoring. Split out of
// design-parser.mjs (file-size sweep — pure move, no behaviour change).

import {
  collectParagraphs,
  collectBullets,
  stripBold,
  splitSubsections,
  extractNamedRules,
  normalizeApostrophes,
} from './design-parser-sections.mjs';

function extractTypography(section) {
  if (!section) return null;
  const text = section.lines.join('\n');

  const fonts = {};
  // Pattern A: **Display Font:** Family (with fallback)
  const fontLineRe = /\*\*([\w\s/]+?)Font:\*\*\s*([^\n(]+?)(?:\s*\(with\s+([^)]+)\))?\s*$/gm;
  let fm;
  while ((fm = fontLineRe.exec(text)) !== null) {
    const rawRole = fm[1].trim().toLowerCase().replace(/\s+/g, '-');
    const role = normalizeFontRole(rawRole) || 'display';
    fonts[role] = {
      family: fm[2].trim(),
      fallback: fm[3] ? fm[3].trim() : null,
    };
  }

  // Pattern B (Stitch): *   **Display & Headlines (Noto Serif):** description
  if (Object.keys(fonts).length === 0) {
    const stitchRe = /\*\*([\w\s&/]+?)\s*\(([^)]+)\):\*\*\s*(.+)/g;
    let sm;
    while ((sm = stitchRe.exec(text)) !== null) {
      const rawRole = sm[1]
        .trim()
        .toLowerCase()
        .replace(/\s*&\s*/g, '-')
        .replace(/\s+/g, '-');
      const role = normalizeFontRole(rawRole) || rawRole;
      fonts[role] = { family: sm[2].trim(), fallback: null, purpose: sm[3].trim() };
    }
  }

  // Character paragraph — either a **Character:** label, or fall back to the
  // first free paragraph under the section header (Stitch style).
  const characterMatch = text.match(/\*\*Character:\*\*\s*([^\n]+(?:\n[^\n]+)*?)(?=\n\n|\n###|\n##|$)/);
  let character = characterMatch ? characterMatch[1].replace(/\n/g, ' ').trim() : null;
  if (!character) {
    const paragraphs = collectParagraphs(section.lines).filter(
      (p) => !/^\*\*[\w\s/&]+Font/i.test(p) && !/^\*\*[\w\s/&]+\([^)]+\)/.test(p)
    );
    if (paragraphs.length) character = paragraphs[0];
  }

  // Hierarchy bullets under ### Hierarchy
  const subs = splitSubsections(section.lines);
  let hierarchy = [];
  const hierSub = subs.find((s) => s.name && /hierarch/i.test(s.name));
  if (hierSub) {
    const bullets = collectBullets(hierSub.lines);
    hierarchy = bullets.map(parseTypeBullet).filter(Boolean);
  }

  return {
    subtitle: section.subtitle,
    fonts,
    character,
    hierarchy,
    rules: extractNamedRules(section.lines),
  };
}

function normalizeFontRole(raw) {
  // Canonical roles the panel cares about: display, body, label, mono.
  // Stitch often writes compound roles like "display-&-headlines" or "ui-&-body"
  // — collapse them to the first canonical role present.
  const tokens = raw.split(/[-/&\s]+/).filter(Boolean);
  const priority = ['display', 'headline', 'body', 'ui', 'label', 'mono'];
  const canonical = { headline: 'display', ui: 'body' };
  for (const p of priority) {
    if (tokens.includes(p)) return canonical[p] || p;
  }
  return null;
}

function parseTypeBullet(bullet) {
  // - **Display** (family, weight 300, italic, clamp(...), line-height 1): purpose
  const m = bullet.match(/^\*\*(.+?)\*\*\s*\(([^)]+)\):\s*(.*)$/);
  if (!m) return null;
  const name = m[1].trim();
  const specs = m[2].split(',').map((s) => s.trim());
  return {
    name,
    specs,
    purpose: stripBold(m[3] || '').trim() || null,
  };
}

function extractElevation(section) {
  if (!section) return null;
  const subs = splitSubsections(section.lines);

  const description = collectParagraphs(subs[0].lines).join(' ') || null;

  const shadows = [];
  const seen = new Set();
  const dedupe = (entry) => {
    const key = `${entry.name || ''}::${entry.value}`;
    if (seen.has(key)) return;
    seen.add(key);
    shadows.push(entry);
  };

  for (const b of collectBullets(section.lines)) {
    const parsed = parseShadowBullet(b);
    if (parsed) dedupe(parsed);
  }

  // Fallback: extract shadows written inline in prose. Stitch style is
  //   "...use an extra-diffused shadow: `box-shadow: 0 12px 40px rgba(...)`."
  for (const p of collectParagraphs(section.lines)) {
    for (const inline of extractInlineShadows(p)) dedupe(inline);
  }
  for (const b of collectBullets(section.lines)) {
    for (const inline of extractInlineShadows(b)) dedupe(inline);
  }

  return {
    subtitle: section.subtitle,
    description,
    shadows,
    rules: extractNamedRules(section.lines),
  };
}

function extractInlineShadows(text) {
  // Find `box-shadow: ...` anywhere in prose and capture the value. Work on the
  // raw string so it handles both backtick-fenced and unfenced variants.
  const out = [];
  const re = /box-shadow\s*:\s*([^`;\n]+)/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const value = m[1].replace(/[`.)]+$/, '').trim();
    if (!value) continue;
    // Name heuristic: the noun immediately before the shadow phrase.
    // e.g. "an extra-diffused shadow: ..." -> "extra-diffused shadow"
    const before = text.slice(0, m.index);
    const nameMatch = before.match(/\b([A-Za-z][A-Za-z\- ]{2,40})\s+shadow\b[^A-Za-z0-9]*$/i);
    let name = null;
    if (nameMatch) {
      const stripped = nameMatch[1]
        .replace(/^(?:use|using|apply|applying|is|are|looks? like)\s+/i, '')
        .replace(/^(?:a|an|the)\s+/i, '')
        .trim();
      if (stripped) {
        name =
          `${stripped.charAt(0).toUpperCase() + stripped.slice(1)} shadow`;
      }
    }
    out.push({
      name,
      value,
      purpose: null,
    });
  }
  return out;
}

function parseShadowBullet(bullet) {
  // - **Name** (`box-shadow: value`): purpose
  // - **Name** (`value`): purpose
  // Only accept if the paren content looks like a shadow value (contains px,
  // rem, rgba, or box-shadow). This filters out `**Rule Name:**` bullets.
  const m = bullet.match(/^\*\*(.+?)\*\*\s*\(`?([^`]+?)`?\):\s*(.*)$/);
  if (!m) return null;
  const rawValue = m[2].replace(/^box-shadow:\s*/i, '').trim();
  const looksLikeShadow =
    /box-shadow|rgba?\(|\bpx\b|\brem\b|^-?\d+\s/i.test(rawValue) &&
    /\d/.test(rawValue);
  if (!looksLikeShadow) return null;
  const name = stripBold(m[1]).trim();
  return {
    name,
    value: rawValue,
    purpose: stripBold(m[3] || '').trim() || null,
  };
}

function extractComponents(section) {
  if (!section) return null;
  const subs = splitSubsections(section.lines);
  const components = [];

  for (const sub of subs.slice(1)) {
    if (!sub.name) continue;

    const bullets = collectBullets(sub.lines);
    const paragraphs = collectParagraphs(sub.lines);

    const variants = [];
    const properties = {};

    for (const b of bullets) {
      // - **Key:** value
      const m = b.match(/^\*\*(.+?):?\*\*:?\s*(.+)$/);
      if (m) {
        const key = stripBold(m[1]).trim();
        const value = stripBold(m[2]).trim();
        // Heuristic: "Primary", "Secondary", "Hover", "Focus" etc are variants;
        // "Shape", "Background", "Padding" are properties.
        if (/^(primary|secondary|tertiary|ghost|hover|focus|active|disabled|default|error|selected|unselected|state)$/i.test(key.split(/[\s/]/)[0])) {
          variants.push({ name: key, description: value });
        } else {
          properties[key.toLowerCase()] = value;
        }
      }
    }

    components.push({
      name: sub.name,
      description: paragraphs.join(' ') || null,
      properties,
      variants,
    });
  }

  return {
    subtitle: section.subtitle,
    components,
  };
}

function extractDosDonts(section) {
  if (!section) return null;
  const subs = splitSubsections(section.lines);
  const dos = [];
  const donts = [];

  for (const sub of subs.slice(1)) {
    if (!sub.name) continue;
    const subName = normalizeApostrophes(sub.name);
    const bullets = collectBullets(sub.lines).map((b) => stripBold(b).trim());
    if (/^do'?t?:?$/i.test(subName) || /^do:?$/i.test(subName)) {
      dos.push(...bullets);
    } else if (/^don'?t:?$/i.test(subName)) {
      donts.push(...bullets);
    }
  }

  // Classify by bullet prefix as a backup (catches loose bullets outside H3 wrappers)
  for (const b of collectBullets(section.lines)) {
    const stripped = normalizeApostrophes(stripBold(b).trim());
    if (/^don'?t\b/i.test(stripped)) {
      if (!donts.some((d) => normalizeApostrophes(d) === stripped)) donts.push(stripped);
    } else if (/^do\b/i.test(stripped)) {
      if (!dos.some((d) => normalizeApostrophes(d) === stripped)) dos.push(stripped);
    }
  }

  return { dos, donts };
}

// ---------- Coverage assessment ----------

function assessCoverage(model) {
  const report = {};

  report.overview = model.overview
    ? {
        northStar: Boolean(model.overview.creativeNorthStar),
        philosophy: model.overview.philosophy.length > 0,
        keyCharacteristics: model.overview.keyCharacteristics.length,
      }
    : 'missing';

  report.colors = model.colors
    ? {
        groups: model.colors.groups.length,
        totalColors: model.colors.groups.reduce((n, g) => n + g.colors.length, 0),
        rules: model.colors.rules.length,
      }
    : 'missing';

  report.typography = model.typography
    ? {
        fonts: Object.keys(model.typography.fonts).length,
        hierarchyEntries: model.typography.hierarchy.length,
        character: Boolean(model.typography.character),
        rules: model.typography.rules.length,
      }
    : 'missing';

  report.elevation = model.elevation
    ? {
        shadows: model.elevation.shadows.length,
        rules: model.elevation.rules.length,
        description: Boolean(model.elevation.description),
      }
    : 'missing';

  report.components = model.components
    ? {
        count: model.components.components.length,
        variantTotal: model.components.components.reduce((n, c) => n + c.variants.length, 0),
      }
    : 'missing';

  report.dosDonts = model.dosDonts
    ? {
        dos: model.dosDonts.dos.length,
        donts: model.dosDonts.donts.length,
      }
    : 'missing';

  return report;
}

// ---------- Main ----------


export {
  extractTypography,
  normalizeFontRole,
  parseTypeBullet,
  extractElevation,
  extractInlineShadows,
  parseShadowBullet,
  extractComponents,
  extractDosDonts,
  assessCoverage,
};
