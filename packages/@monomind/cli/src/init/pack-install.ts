/**
 * Add and remove opt-in packs in an initialised project (GH #411), and tell
 * which ones it has. `monomind packs add|remove|list` and `init upgrade
 * --add-missing` use these.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PlatformId } from '../platform-adapters/types.js';
import { copyAgents, copyCommands, copySkills } from './copy-assets.js';
import { finalizeGuard } from './file-guard.js';
import { listFilesRecursive } from './fs-helpers.js';
import { readInitManifest, recordGenerated, recordPacks } from './init-manifest.js';
import { type AssetPack, OPTIONAL_PACKS, PACK_NAMES, topLevel } from './packs.js';
import { buildProjectIndexes } from './project-indexes.js';
import {
  DEFAULT_INIT_OPTIONS,
  detectPlatform,
  type InitOptions,
  type InitResult,
} from './types.js';

const SKILL_ROOTS = [
  path.join('.claude', 'skills'),
  path.join('.gemini', 'skills'),
  path.join('.agents', 'skills'),
];

/** Every path (relative to `targetDir`) a pack's entries live at. */
function packPaths(pack: AssetPack): string[] {
  return [
    ...pack.skills.flatMap((s) => SKILL_ROOTS.map((root) => path.join(root, s))),
    ...pack.commands.map((c) => path.join('.claude', 'commands', c)),
    ...pack.agents.map((a) => path.join('.claude', 'agents', a)),
  ];
}

/**
 * The opt-in packs `targetDir` has: the manifest's record, or — for a project
 * initialised before packs existed, which got everything — every pack with
 * at least one entry on disk.
 */
export function installedPacks(targetDir: string): string[] {
  const recorded = readInitManifest(targetDir)?.packs;
  if (recorded) return recorded.filter((n) => PACK_NAMES.includes(n));
  return OPTIONAL_PACKS.filter((p) =>
    packPaths(p).some((rel) => fs.existsSync(path.join(targetDir, rel))),
  ).map((p) => p.name);
}

function freshResult(): InitResult {
  return {
    success: true,
    platform: detectPlatform(),
    created: { directories: [], files: [] },
    updated: [],
    skipped: [],
    removed: [],
    errors: [],
    summary: { skillsCount: 0, commandsCount: 0, agentsCount: 0, hooksEnabled: 0 },
  };
}

/** Platforms whose skill mirrors the project already has, so a pack's skills
 *  go where init put the core ones. */
function platformsOnDisk(targetDir: string): PlatformId[] {
  const platforms: PlatformId[] = ['claude'];
  if (fs.existsSync(path.join(targetDir, '.gemini', 'skills'))) platforms.push('antigravity');
  if (fs.existsSync(path.join(targetDir, '.agents', 'skills'))) platforms.push('codex');
  return platforms;
}

/** Install `packs` into an initialised project; edited files are kept (the
 *  new version goes beside them as `.monomind-new`), like `init`. */
export async function addPacks(
  targetDir: string,
  packs: readonly string[],
  sourceBaseDir?: string,
): Promise<InitResult> {
  const result = freshResult();
  const off = { core: false, all: false };
  const options: InitOptions = {
    ...structuredClone(DEFAULT_INIT_OPTIONS),
    targetDir,
    sourceBaseDir,
    force: false,
    packs: [...packs],
    skills: off,
    commands: off,
    agents: off,
    selectedPlatforms: platformsOnDisk(targetDir),
  };
  await copySkills(targetDir, options, result);
  await copyCommands(targetDir, options, result);
  await copyAgents(targetDir, options, result);
  finalizeGuard(result);
  recordPacks(targetDir, [...installedPacks(targetDir), ...packs]);
  result.indexes = buildProjectIndexes(targetDir);
  result.success = result.errors.length === 0;
  return result;
}

const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

/** Remove `dir` and its parents up to (not including) `stop` while empty. */
function pruneEmpty(dir: string, stop: string): void {
  let current = dir;
  while (current.startsWith(stop) && current !== stop && fs.existsSync(current)) {
    if (fs.readdirSync(current).length > 0) return;
    fs.rmdirSync(current);
    current = path.dirname(current);
  }
}

/**
 * Remove `packs` from a project. Only files init installed and nobody has
 * changed since (their content still matches the hash init recorded) are
 * deleted; anything else — an edited file, a file of the user's own inside a
 * pack directory, a file with no recorded hash — is kept and listed in
 * `result.kept`.
 */
export function removePacks(targetDir: string, packs: readonly string[]): InitResult {
  const result = freshResult();
  result.kept = [];
  const hashes = readInitManifest(targetDir)?.files ?? {};
  for (const pack of OPTIONAL_PACKS.filter((p) => packs.includes(p.name))) {
    for (const rel of packPaths(pack)) {
      const abs = path.join(targetDir, rel);
      if (!fs.existsSync(abs)) continue;
      const files = fs.statSync(abs).isDirectory()
        ? [...listFilesRecursive(abs)].map((f) => path.join(rel, f))
        : [rel];
      for (const file of files) {
        const key = file.split(path.sep).join('/');
        const full = path.join(targetDir, file);
        if (hashes[key] && hashes[key] === sha256(fs.readFileSync(full))) {
          fs.rmSync(full);
          result.removed.push(key);
          const root = rel.split(path.sep).slice(0, 2).join(path.sep);
          pruneEmpty(path.dirname(full), path.join(targetDir, root));
        } else {
          result.kept.push(key);
        }
      }
    }
  }
  // Entries whose top-level directory or file is gone leave the manifest.
  const manifest = readInitManifest(targetDir);
  for (const section of ['skills', 'commands', 'agents'] as const) {
    const dir = path.join(targetDir, '.claude', section);
    const left = (manifest?.[section] ?? []).filter((n) =>
      fs.existsSync(path.join(dir, topLevel(n))),
    );
    if (manifest && left.length !== manifest[section].length) {
      recordGenerated(targetDir, section, left);
    }
  }
  recordPacks(
    targetDir,
    installedPacks(targetDir).filter((n) => !packs.includes(n)),
  );
  result.indexes = buildProjectIndexes(targetDir);
  return result;
}
