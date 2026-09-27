// Parse a DESIGN.md (Stitch-spec format) into a structured JSON model that
// the live-mode design-system panel can render. Deterministic, dependency-free.
//
// Two-layer: YAML frontmatter (machine-readable tokens) + markdown body
// (prose with six canonical H2 sections). When frontmatter is present, it's
// exposed on `model.frontmatter` alongside the prose-scraped sections;
// consumers can prefer frontmatter values and fall back to prose.

import { parseFrontmatter } from './design-parser-yaml.mjs';
import { splitSections } from './design-parser-sections.mjs';
import { extractOverview, extractColors } from './design-parser-colors.mjs';
import {
  extractTypography,
  extractElevation,
  extractComponents,
  extractDosDonts,
  assessCoverage,
} from './design-parser-extract.mjs';

export function parseDesignMd(md) {
  const { frontmatter, body } = parseFrontmatter(md);
  const { title, sections } = splitSections(body);
  return {
    schemaVersion: 2,
    title,
    frontmatter,
    overview: extractOverview(sections.Overview),
    colors: extractColors(sections.Colors),
    typography: extractTypography(sections.Typography),
    elevation: extractElevation(sections.Elevation),
    components: extractComponents(sections.Components),
    dosDonts: extractDosDonts(sections["Do's and Don'ts"]),
  };
}

export { assessCoverage };
