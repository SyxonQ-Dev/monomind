/**
 * What init ships: the skill, command and agent selections per pack, the
 * directories it creates, and every name this version ships.
 */

import * as fs from 'node:fs';
import { type AssetKind, PACKS, topLevel } from './packs.js';

/** One section per pack (see packs.ts): what each pack installs. */
function mapOf(kind: AssetKind): Record<string, string[]> {
  return Object.fromEntries(PACKS.map((p) => [p.name, [...p[kind]]]));
}

/** Skill directory names per pack. */
export const SKILLS_MAP: Record<string, string[]> = mapOf('skills');

/** Command files/directories (relative to `.claude/commands`) per pack. */
export const COMMANDS_MAP: Record<string, string[]> = mapOf('commands');

/** Agent files/category directories (relative to `.claude/agents`) per pack. */
export const AGENTS_MAP: Record<string, string[]> = mapOf('agents');

/**
 * True for a file under a shipped commands directory that is not a command:
 * a README, a `_`-prefixed shared include or anything under `references/`.
 * Claude Code registers every `.md` under `.claude/commands/` as a slash
 * command, so installing these added descriptionless entries to the listing
 * (GH #411).
 */
export function isCommandDoc(srcPath: string): boolean {
  const segs = srcPath.split(/[\\/]/);
  const base = segs[segs.length - 1];
  return base === 'README.md' || base.startsWith('_') || segs.includes('references');
}

/** True for an agent definition whose frontmatter says `deprecated: true`. */
export function isDeprecatedAgent(srcPath: string): boolean {
  if (!srcPath.endsWith('.md')) return false;
  const frontmatter = fs.readFileSync(srcPath, 'utf-8').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return !!frontmatter && /^deprecated:\s*true\s*$/m.test(frontmatter[1]);
}

/**
 * Directory structure to create
 */
export const DIRECTORIES = {
  claude: [
    '.claude',
    '.claude/skills',
    '.claude/commands',
    '.claude/agents',
    '.claude/helpers',
    '.gemini',
    '.gemini/skills',
    '.gemini/rules',
    '.agents',
    '.agents/skills',
  ],
  runtime: [
    '.monomind',
    '.monomind/data',
    '.monomind/logs',
    '.monomind/sessions',
    '.monomind/hooks',
    '.monomind/agents',
    '.monomind/workflows',
  ],
};

/**
 * Every top-level name this version ships in `.claude/<kind>`, across ALL
 * packs — unlike a run's selection (core plus the packs asked for), this
 * ignores what the user asked for THIS run entirely. o-38: the stale sweep
 * must ask "does this version still ship X" and never "did the user select X
 * this run" — the two questions were conflated, so `--minimal` (a documented
 * flag, no upgrade required) deleted every previously-installed skill outside
 * the minimal set, user files inside included.
 */
function allShipped(kind: AssetKind): Set<string> {
  return new Set(PACKS.flatMap((p) => p[kind].map(topLevel)));
}

export const allShippedSkills = (): Set<string> => allShipped('skills');
export const allShippedCommands = (): Set<string> => allShipped('commands');
export const allShippedAgents = (): Set<string> => allShipped('agents');
