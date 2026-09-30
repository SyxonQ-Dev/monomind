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
import { findSourceDir } from './shared.js';
import {
  DEFAULT_INIT_OPTIONS,
  detectPlatform,
  type InitOptions,
  type InitResult,
} from './types.js';
import { convertClaudeTreeToKimi, writeKimiTree } from './write-kimicode.js';
import { convertClaudeTreeToOpencode, writeOpencodeTree } from './write-opencode.js';

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

const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

/** Files (relative to `targetDir`) under a pack path, or the path itself. */
function filesAt(targetDir: string, rel: string): string[] {
  const abs = path.join(targetDir, rel);
  const st = fs.lstatSync(abs, { throwIfNoEntry: false });
  if (!st) return [];
  if (!st.isDirectory()) return [rel];
  return [...listFilesRecursive(abs)].map((f) => path.join(rel, f));
}

/**
 * The opt-in packs `targetDir` has: the manifest's record, or — for a project
 * initialised before packs existed, which got everything — every pack with a
 * `.claude` file that init put there: one whose content matches the hash init
 * recorded or the file this version ships.
 */
export function installedPacks(targetDir: string): string[] {
  const manifest = readInitManifest(targetDir);
  if (manifest?.packs) return manifest.packs.filter((n) => PACK_NAMES.includes(n));
  const hashes = manifest?.files ?? {};
  const sourceSkills = findSourceDir('skills');
  const sourceClaude = sourceSkills ? path.dirname(sourceSkills) : undefined;
  const initPut = (rel: string): boolean => {
    const disk = fs.readFileSync(path.join(targetDir, rel));
    const key = rel.split(path.sep).join('/');
    if (hashes[key] === sha256(disk)) return true;
    if (!sourceClaude) return false;
    const shipped = path.join(sourceClaude, path.relative('.claude', rel));
    return fs.existsSync(shipped) && fs.readFileSync(shipped).equals(disk);
  };
  return OPTIONAL_PACKS.filter((p) =>
    packPaths(p)
      .filter((rel) => rel.startsWith(`.claude${path.sep}`))
      .some((rel) => filesAt(targetDir, rel).some(initPut)),
  ).map((p) => p.name);
}

/** The packs among `names` that have at least one entry of an installed kind
 *  on disk under `.claude` — what an init run really put in place. */
export function packsOnDisk(
  targetDir: string,
  names: readonly string[],
  kinds: { skills: boolean; commands: boolean; agents: boolean },
): string[] {
  const claude = path.join(targetDir, '.claude');
  return OPTIONAL_PACKS.filter(
    (p) =>
      names.includes(p.name) &&
      ((kinds.skills && p.skills.some((s) => fs.existsSync(path.join(claude, 'skills', s)))) ||
        (kinds.commands &&
          p.commands.some((c) => fs.existsSync(path.join(claude, 'commands', c)))) ||
        (kinds.agents && p.agents.some((a) => fs.existsSync(path.join(claude, 'agents', a))))),
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

const hasKimi = (targetDir: string) => fs.existsSync(path.join(targetDir, '.kimi-code'));
const hasOpencode = (targetDir: string) => fs.existsSync(path.join(targetDir, '.opencode'));

function packOptions(targetDir: string, packs: readonly string[], sourceBaseDir?: string) {
  const off = { core: false, all: false };
  return {
    ...structuredClone(DEFAULT_INIT_OPTIONS),
    targetDir,
    sourceBaseDir,
    force: false,
    packs: [...packs],
    skills: off,
    commands: off,
    agents: off,
    selectedPlatforms: platformsOnDisk(targetDir),
  } satisfies InitOptions;
}

/** Install `packs` into an initialised project; edited files are kept (the
 *  new version goes beside them as `.monomind-new`), like `init`. The Kimi
 *  Code and OpenCode trees, when the project has them, are converted again. */
export async function addPacks(
  targetDir: string,
  packs: readonly string[],
  sourceBaseDir?: string,
): Promise<InitResult> {
  const result = freshResult();
  const options = packOptions(targetDir, packs, sourceBaseDir);
  await copySkills(targetDir, options, result);
  await copyCommands(targetDir, options, result);
  await copyAgents(targetDir, options, result);
  if (hasKimi(targetDir)) writeKimiTree(targetDir, options, result);
  if (hasOpencode(targetDir)) writeOpencodeTree(targetDir, options, result);
  finalizeGuard(result);
  recordPacks(targetDir, [...installedPacks(targetDir), ...packs]);
  result.indexes = buildProjectIndexes(targetDir);
  result.success = result.errors.length === 0;
  return result;
}

/** Remove `dir` and its parents up to (not including) `stop` while empty. */
function pruneEmpty(dir: string, stop: string): void {
  let current = dir;
  while (current.startsWith(stop) && current !== stop && fs.existsSync(current)) {
    if (fs.readdirSync(current).length > 0) return;
    fs.rmdirSync(current);
    current = path.dirname(current);
  }
}

/** Every converted mirror file a `.claude` tree yields: path → content. */
function mirrorFiles(targetDir: string): Map<string, string> {
  const claude = path.join(targetDir, '.claude');
  const out = new Map<string, string>();
  if (hasKimi(targetDir)) {
    const kimi = convertClaudeTreeToKimi(claude);
    for (const [f, c] of kimi.agents) out.set(path.join('.kimi-code', 'agents', f), c);
    for (const [d, c] of kimi.skills) out.set(path.join('.kimi-code', 'skills', d, 'SKILL.md'), c);
    for (const [f, c] of kimi.pluginCommands) {
      out.set(path.join('.kimi-code', 'plugin', 'commands', f), c);
    }
  }
  if (hasOpencode(targetDir)) {
    const oc = convertClaudeTreeToOpencode(claude);
    for (const [f, c] of oc.agents) out.set(path.join('.opencode', 'agent', f), c);
    for (const [f, c] of oc.commands) out.set(path.join('.opencode', 'command', f), c);
    for (const [d, c] of oc.skills) out.set(path.join('.opencode', 'skills', d, 'SKILL.md'), c);
  }
  return out;
}

/**
 * Remove `packs` from a project. Only files init installed and nobody has
 * changed since are deleted: a `.claude`/`.gemini`/`.agents` file whose content
 * still matches the hash init recorded, or a Kimi Code/OpenCode file that still
 * holds exactly what the removed files convert to. Anything else — an edited
 * file, a file of the user's own inside a pack directory, a file with no
 * recorded hash, a symlink, a path that resolves outside the project — is
 * kept and listed in `result.kept`.
 */
export function removePacks(targetDir: string, packs: readonly string[]): InitResult {
  const result = freshResult();
  result.kept = [];
  const kept = result.kept;
  const root = fs.realpathSync(targetDir);
  const hashes = readInitManifest(targetDir)?.files ?? {};
  const mirrorsBefore = mirrorFiles(targetDir);

  /** Delete `rel` when `owned(disk)` says init wrote it as it is now. */
  const removeFile = (rel: string, owned: (disk: Buffer) => boolean, stop: string) => {
    const key = rel.split(path.sep).join('/');
    const full = path.join(targetDir, rel);
    const st = fs.lstatSync(full, { throwIfNoEntry: false });
    if (!st) return;
    const real = st.isFile() ? fs.realpathSync(full) : '';
    if (!st.isFile() || !real.startsWith(root + path.sep) || !owned(fs.readFileSync(full))) {
      kept.push(key);
      return;
    }
    fs.rmSync(full);
    result.removed.push(key);
    pruneEmpty(path.dirname(full), path.join(targetDir, stop));
  };

  for (const pack of OPTIONAL_PACKS.filter((p) => packs.includes(p.name))) {
    for (const rel of packPaths(pack)) {
      const kindRoot = rel.split(path.sep).slice(0, 2).join(path.sep);
      for (const file of filesAt(targetDir, rel)) {
        const key = file.split(path.sep).join('/');
        removeFile(file, (disk) => !!hashes[key] && hashes[key] === sha256(disk), kindRoot);
      }
    }
  }

  // Kimi Code / OpenCode: what the removed .claude files converted to.
  const mirrorsAfter = mirrorFiles(targetDir);
  for (const [rel, content] of mirrorsBefore) {
    if (mirrorsAfter.has(rel)) continue;
    const kindRoot = rel
      .split(path.sep)
      .slice(0, rel.includes('plugin') ? 3 : 2)
      .join(path.sep);
    removeFile(rel, (disk) => disk.equals(Buffer.from(content)), kindRoot);
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
  const kimiLeft = (manifest?.kimiSkills ?? []).filter((n) =>
    fs.existsSync(path.join(targetDir, '.kimi-code', 'skills', n)),
  );
  if (manifest && kimiLeft.length !== manifest.kimiSkills.length) {
    recordGenerated(targetDir, 'kimiSkills', kimiLeft);
  }
  const ocLeft = (manifest?.opencodeSkills ?? []).filter((n) =>
    fs.existsSync(path.join(targetDir, '.opencode', 'skills', n)),
  );
  if (manifest && ocLeft.length !== manifest.opencodeSkills.length) {
    recordGenerated(targetDir, 'opencodeSkills', ocLeft);
  }
  recordPacks(
    targetDir,
    installedPacks(targetDir).filter((n) => !packs.includes(n)),
  );
  result.indexes = buildProjectIndexes(targetDir);
  return result;
}
