/** Read-only detection of legacy pre-adapter platform install surfaces.
 * File-size sweep: split out of migration.ts.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readInitManifest } from '../init/init-manifest.js';
import { LEGACY_SURFACE_INVENTORY } from './migration-inventory.js';

/**
 * A pre-adapter block is *unnamed*: `monomind:start` with nothing after it on
 * the line. Current adapters always write a named marker
 * (`monomind:start instructions:claude`), so matching a bare `monomind:start`
 * prefix would report every freshly installed artifact as legacy (#277) and
 * invite migration to rewrite a current block into a corrupt one.
 */
const BARE_MARKER =
  /^[\t ]*(?:(?:#|\/\/)[^\S\r\n]*|<!--[^\S\r\n]*)?monomind:start[^\S\r\n]*(?:-->)?[^\S\r\n]*(?:\r?\n|$)/im;

export function isMonomindOwned(content: string): boolean {
  return BARE_MARKER.test(content) || /monomind-activate/i.test(content);
}

/**
 * The shared skill roots are also the *current* portable skill location for
 * most adapters, so their existence is not evidence of a legacy install. Only
 * a mastermind skill package written before adapters owned it is: one neither
 * recorded in the init manifest (current installs, GH #344) nor wrapped in a
 * named `skills:` marker (installs between the two).
 */
function hasLegacySkillPackage(root: string, base: string, rel: string): boolean {
  const recorded = readInitManifest(base)?.files ?? {};
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return false;
  }
  return entries.some((entry) => {
    const skill = join(root, entry, 'SKILL.md');
    if (!existsSync(skill)) return false;
    try {
      const content = readFileSync(skill, 'utf8');
      return (
        /^name:\s*mastermind/m.test(content) &&
        !/monomind:start\s+skills:/.test(content) &&
        recorded[`${rel}/${entry}/SKILL.md`] === undefined
      );
    } catch {
      return false;
    }
  });
}

const SHARED_SKILL_ROOTS = new Set(['shared-agent-skills', 'shared-gemini-skills']);

export function findLegacySurfaces(root: string, scope: 'project' | 'user'): string[] {
  return LEGACY_SURFACE_INVENTORY.filter((surface) => surface.scope === scope)
    .filter((surface) => {
      const path = join(root, surface.path);
      if (!existsSync(path)) return false;
      if (SHARED_SKILL_ROOTS.has(surface.id))
        return hasLegacySkillPackage(path, root, surface.path);
      if (surface.ownership === 'monomind-file') return true;
      try {
        return isMonomindOwned(readFileSync(path, 'utf8'));
      } catch {
        return false;
      }
    })
    .map((surface) => surface.id);
}
