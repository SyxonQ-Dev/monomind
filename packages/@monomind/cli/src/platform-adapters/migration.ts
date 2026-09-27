/** Detection and safe cleanup rules for pre-adapter platform installations.
 *
 * File-size sweep: split into sibling modules — the surface inventory in
 * migration-inventory.ts, read-only detection in migration-detect.ts,
 * managed-block extraction/migration in migration-blocks.ts, and the
 * cursor/claude settings.json legacy-hook helpers in
 * migration-cursor-hook.ts. Re-exported here so every existing import path
 * (`./migration.js`) keeps working unchanged; `migrateLegacyArtifacts`, the
 * orchestrating entry point, stays in this file.
 */

import { existsSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  deCorruptAiderYaml,
  removeLegacyManagedBlocks,
  takeLegacyBlock,
  writeMigratedInstructions,
} from './migration-blocks.js';
import { isOwnedScript, removeLegacyCursorHook } from './migration-cursor-hook.js';
import { isMonomindOwned } from './migration-detect.js';
import type { LegacyMigrationResult } from './migration-inventory.js';
import { LEGACY_SURFACE_INVENTORY } from './migration-inventory.js';

export {
  deCorruptAiderYaml,
  removeLegacyManagedBlocks,
} from './migration-blocks.js';
export { findLegacySurfaces, isMonomindOwned } from './migration-detect.js';
export type { LegacyMigrationResult, LegacySurface } from './migration-inventory.js';
export { LEGACY_SURFACE_INVENTORY } from './migration-inventory.js';

export function migrateLegacyArtifacts(
  root: string,
  scope: 'project' | 'user',
  options: {
    dryRun?: boolean;
    removeLegacy?: boolean;
    /** Called before a verified legacy artifact is changed or removed. */
    beforeWrite?: (path: string) => void;
  } = {},
): LegacyMigrationResult {
  const changed: string[] = [];
  const skipped: string[] = [];
  const diagnostics: string[] = [];

  for (const surface of LEGACY_SURFACE_INVENTORY.filter((item) => item.scope === scope)) {
    const path = join(root, surface.path);
    if (!existsSync(path)) {
      skipped.push(surface.path);
      continue;
    }

    if (surface.id === 'shared-agent-skills' || surface.id === 'shared-gemini-skills') {
      // The current manifest has no consumer-reference record. Preserve the
      // shared root and every package until one exists instead of guessing
      // whether another adapter still owns it.
      skipped.push(surface.path);
      continue;
    }

    if (surface.ownership === 'monomind-file') {
      if (statSync(path).isDirectory()) {
        const manifest = join(path, 'plugin.json');
        if (!existsSync(manifest) || !isOwnedScript(manifest)) {
          skipped.push(surface.path);
          continue;
        }
        if (!options.dryRun) {
          options.beforeWrite?.(path);
          rmSync(path, { recursive: true, force: false });
        }
      } else {
        if (!isOwnedScript(path)) {
          skipped.push(surface.path);
          continue;
        }
        if (!options.dryRun) {
          options.beforeWrite?.(path);
          unlinkSync(path);
        }
      }
      changed.push(surface.path);
      continue;
    }

    const original = readFileSync(path, 'utf8');
    if (!isMonomindOwned(original)) {
      skipped.push(surface.path);
      continue;
    }

    if (surface.id === 'cursor-sessionstart' || surface.id === 'claude-global-sessionstart') {
      const cursor = removeLegacyCursorHook(original);
      if (cursor.diagnostic) diagnostics.push(cursor.diagnostic);
      if (!cursor.changed) {
        skipped.push(surface.path);
        continue;
      }
      if (!options.dryRun) {
        options.beforeWrite?.(path);
        writeFileSync(path, cursor.content, 'utf8');
      }
      changed.push(surface.path);
      continue;
    }

    if (surface.id === 'aider-corrupted-yaml') {
      const next = deCorruptAiderYaml(original);
      if (next === original) {
        skipped.push(surface.path);
        continue;
      }
      if (!options.dryRun) {
        options.beforeWrite?.(path);
        writeFileSync(path, next, 'utf8');
      }
      changed.push(surface.path);
      continue;
    }

    if (surface.action === 'migrate') {
      if (options.dryRun) {
        const extracted = takeLegacyBlock(original);
        if (!extracted) {
          skipped.push(surface.path);
          continue;
        }
        changed.push(surface.path);
        continue;
      }
      const migrated = writeMigratedInstructions(root, surface, original, options.beforeWrite);
      if (!migrated.changed) {
        skipped.push(surface.path);
        continue;
      }
      changed.push(...migrated.paths);
      continue;
    }

    const next = removeLegacyManagedBlocks(original);
    if (next === original) {
      skipped.push(surface.path);
      continue;
    }
    if (!options.dryRun) {
      options.beforeWrite?.(path);
      writeFileSync(path, next, 'utf8');
    }
    changed.push(surface.path);
  }

  return { changed, skipped, diagnostics };
}
