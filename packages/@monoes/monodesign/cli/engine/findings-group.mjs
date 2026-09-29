// Collapse repeated findings into one entry per (rule, snippet). A single
// dark-theme token can fail contrast on hundreds of elements; reporting each
// occurrence floods agents and humans with the same line (#424).

import path from 'node:path';

const SEVERITY_RANK = { error: 3, warning: 2, advisory: 1, info: 0 };

function severityRank(severity) {
  return SEVERITY_RANK[severity] ?? SEVERITY_RANK.warning;
}

function normalizeSnippet(snippet) {
  return String(snippet ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Group findings by (antipattern, normalized snippet).
 * Returns groups sorted by severity, then occurrence count (both descending),
 * each carrying the first `maxLocations` locations as examples.
 */
function groupFindings(findings, { maxLocations = 3 } = {}) {
  const groups = new Map();
  for (const f of findings) {
    const snippet = normalizeSnippet(f.snippet);
    const key = `${f.antipattern}\u0000${snippet}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        antipattern: f.antipattern,
        name: f.name,
        severity: f.severity,
        description: f.description,
        snippet,
        count: 0,
        files: new Set(),
        seen: new Set(),
        locations: [],
      };
      groups.set(key, g);
    }
    g.count += 1;
    g.files.add(f.file);
    // Static-HTML findings carry no line, so dedupe locations: one entry per
    // distinct file:line rather than the same file repeated.
    const loc = f.line ? { file: f.file, line: f.line } : { file: f.file };
    if (f.importedBy?.length) loc.importedBy = f.importedBy;
    const locKey = `${loc.file}:${loc.line ?? ''}`;
    if (!g.seen.has(locKey) && g.locations.length < maxLocations) {
      g.seen.add(locKey);
      g.locations.push(loc);
    }
  }
  // Keep a rule's groups together: order rules by severity then total
  // occurrences, and groups within a rule by their own count.
  const ruleTotals = new Map();
  for (const g of groups.values()) ruleTotals.set(g.antipattern, (ruleTotals.get(g.antipattern) ?? 0) + g.count);
  return [...groups.values()]
    .map(({ files, seen, ...g }) => ({ ...g, fileCount: files.size }))
    .sort((a, b) =>
      severityRank(b.severity) - severityRank(a.severity)
      || ruleTotals.get(b.antipattern) - ruleTotals.get(a.antipattern)
      || a.antipattern.localeCompare(b.antipattern)
      || b.count - a.count);
}

function formatLocation(loc, cwd) {
  const rel = cwd && path.isAbsolute(loc.file) ? path.relative(cwd, loc.file) || loc.file : loc.file;
  const where = loc.line ? `${rel}:${loc.line}` : rel;
  return loc.importedBy?.length ? `${where} (imported by ${loc.importedBy.join(', ')})` : where;
}

/** Human-readable grouped report: one line per unique finding. */
function formatGroupedFindings(findings, cwd = process.cwd()) {
  const groups = groupFindings(findings);
  const out = [];
  let lastRule = null;
  for (const g of groups) {
    if (g.antipattern !== lastRule) {
      out.push(`\n[${g.antipattern}] ${g.name} (${g.severity})`);
      out.push(`  → ${g.description}`);
      lastRule = g.antipattern;
    }
    const where = g.locations.map(loc => formatLocation(loc, cwd)).join(', ');
    const more = g.fileCount > g.locations.length ? `, +${g.fileCount - g.locations.length} more file(s)` : '';
    out.push(`  ×${g.count}  ${g.snippet}`);
    out.push(`       at ${where}${more}`);
  }
  const unique = groups.length;
  out.push(`\n${findings.length} anti-pattern${findings.length === 1 ? '' : 's'} found (${unique} unique). Use --no-group to list every occurrence.`);
  return out.join('\n');
}

export { groupFindings, formatGroupedFindings, severityRank };
