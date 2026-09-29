/**
 * Every skill the guidance catalog recommends must be one `monomind init`
 * actually ships. The catalog used to name skills (memory-vector-search,
 * github-code-review, ...) that never existed, so guidance_capabilities and
 * guidance_recommend sent users to skills they could not load.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { allShippedSkills } from '../../src/init/asset-maps.js';
import { CAPABILITY_CATALOG } from '../../src/mcp-tools/guidance-catalog.js';

const here = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = join(here, '../../.claude/skills');

describe('guidance catalog skills', () => {
  const shipped = allShippedSkills(SKILLS_DIR);

  it('names only skills that init ships', () => {
    const phantom: string[] = [];
    for (const [area, cap] of Object.entries(CAPABILITY_CATALOG)) {
      for (const skill of cap.skills) {
        if (!shipped.has(skill) || !existsSync(join(SKILLS_DIR, skill, 'SKILL.md'))) {
          phantom.push(`${area}: ${skill}`);
        }
      }
    }
    expect(phantom).toEqual([]);
  });
});
