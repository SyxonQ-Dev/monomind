/**
 * GH #411 (PR #516 review): the default install is the core pack, so every
 * skill, command and agent a core asset tells Claude to use must be installed
 * by core too. Otherwise the default install hands Claude dead ends:
 * `Skill("mastermind-release")`, `/mastermind:understand`, a fallback agent
 * such as "Launch Strategist" that lives in an opt-in pack.
 *
 * Installs the core pack with the BUILT init code, then scans every installed
 * markdown file for:
 *   - `Skill("x")` / `Skill("a:b")`       → an installed skill or command
 *   - `/ns:cmd` for a shipped command group → an installed command
 *   - `x/SKILL.md` skill paths             → an installed skill
 *   - a non-core agent's name, quoted, backticked or as a `:-Name}` default
 * A reference to something in an opt-in pack is allowed only on a line that
 * says which pack to add: `monomind packs add <that pack>`. Names no pack
 * ships at all are left to scripts/lint-agent-refs.mjs.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileGeneratedSkills } from '../../scripts/sync-claude-trees.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PKG = join(REPO_ROOT, 'packages/@monomind/cli');
const DIST = join(PKG, 'dist/src/init');
const load = (m: string) => import(pathToFileURL(join(DIST, m)).href);

/** Claude Code's own skills and skills from other packages; not monomind's to ship. */
const EXTERNAL_SKILLS = new Set([
  'loop',
  'schedule',
  'dataviz',
  'simplify',
  'code-review',
  'security-review',
  'init',
  'claude-api',
  'update-config',
]);

type Pack = { name: string; skills: string[]; commands: string[]; agents: string[] };
let packs: Pack[];
let target: string;

const mdFiles = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.md') && statSync(join(dir, f)).isFile())
    .map((f) => f.split('\\').join('/'));

const exists = (p: string) => !!statSync(p, { throwIfNoEntry: false });

/** Frontmatter `name:` of an agent file. */
const agentName = (file: string) =>
  readFileSync(file, 'utf8').match(/^---\n[\s\S]*?^name:\s*["']?(.+?)["']?\s*$/m)?.[1];

beforeAll(async () => {
  compileGeneratedSkills(REPO_ROOT);
  const init = {
    ...(await load('copy-assets.js')),
    ...(await load('types.js')),
    ...(await load('packs.js')),
  };
  packs = init.PACKS;
  target = mkdtempSync(join(tmpdir(), 'mm-core-refs-'));
  const options = {
    ...structuredClone(init.DEFAULT_INIT_OPTIONS),
    targetDir: target,
    sourceBaseDir: PKG,
  };
  const result = {
    created: { directories: [], files: [] },
    updated: [],
    skipped: [],
    removed: [],
    errors: [] as string[],
    summary: { skillsCount: 0, commandsCount: 0, agentsCount: 0, hooksEnabled: 0 },
  };
  await init.copySkills(target, options, result);
  await init.copyCommands(target, options, result);
  await init.copyAgents(target, options, result);
  expect(result.errors).toEqual([]);
});
afterAll(() => rmSync(target, { recursive: true, force: true }));

/** Which opt-in pack ships a skill, command (`a:b`) or agent name. */
function packOf(kind: 'skill' | 'command' | 'agent', name: string): string | undefined {
  const agentsDir = join(PKG, '.claude/agents');
  for (const p of packs) {
    if (kind === 'skill' && p.skills.includes(name)) return p.name;
    if (kind === 'command') {
      const rel = `${name.split(':').join('/')}.md`;
      if (p.commands.some((c) => c === rel || rel.startsWith(`${c}/`))) return p.name;
    }
    if (kind === 'agent') {
      for (const entry of p.agents) {
        const abs = join(agentsDir, entry);
        if (!exists(abs)) continue;
        const files = statSync(abs).isDirectory() ? mdFiles(abs).map((f) => join(abs, f)) : [abs];
        if (files.some((f) => agentName(f) === name)) return p.name;
      }
    }
  }
  return undefined;
}

function problems(): string[] {
  const claude = join(target, '.claude');
  const installedSkills = new Set(readdirSync(join(claude, 'skills')));
  const installedCommand = (name: string) =>
    exists(join(claude, 'commands', `${name.split(':').join('/')}.md`));
  const installedAgents = new Set(
    mdFiles(join(claude, 'agents')).map((f) => agentName(join(claude, 'agents', f))),
  );
  const shippedAgents = new Set(
    mdFiles(join(PKG, '.claude/agents'))
      .filter((f) => !f.startsWith('reengineer-squad/'))
      .map((f) => agentName(join(PKG, '.claude/agents', f)))
      .filter((n): n is string => !!n),
  );
  const nonCoreAgents = [...shippedAgents].filter((n) => !installedAgents.has(n));
  const commandGroups = new Set(
    packs
      .flatMap((p) => p.commands)
      .filter((c) => !c.endsWith('.md') || c.includes('/'))
      .map((c) => c.split('/')[0].replace(/\.md$/, '')),
  );

  const out: string[] = [];
  for (const rel of mdFiles(claude)) {
    const lines = readFileSync(join(claude, rel), 'utf8').split('\n');
    lines.forEach((line, i) => {
      const where = `.claude/${rel}:${i + 1}`;
      const check = (kind: 'skill' | 'command' | 'agent', name: string) => {
        // Names no pack ships (repo-only skills, memory namespaces) are
        // lint-agent-refs' business, not this test's.
        const pack = packOf(kind, name);
        if (!pack || line.includes(`monomind packs add ${pack}`)) return;
        out.push(
          `${where}: ${kind} ${name} is in the ${pack} pack; add a \`monomind packs add ${pack}\` note`,
        );
      };
      for (const [, name] of line.matchAll(/\bSkill\(\s*\\?["']([^"'\\\n]+)\\?["']/g)) {
        if (/[<>${}[\]|A-Z]/.test(name) || name.endsWith('-') || EXTERNAL_SKILLS.has(name))
          continue;
        if (name.includes(':')) {
          if (!installedCommand(name) && !installedSkills.has(name.replace(':', '-')))
            check('command', name);
        } else if (!installedSkills.has(name)) check('skill', name);
      }
      // `/ns:cmd` anywhere, or `ns:cmd` in a code span, for a shipped command group.
      const cmdRefs = [
        ...line.matchAll(/(?<![\w./-])\/([a-z][\w-]*):([a-z][\w-]*)/g),
        ...line.matchAll(/`([a-z][\w-]*):([a-z][\w-]*)[`\s]/g),
      ];
      for (const name of new Set(cmdRefs.map(([, ns, cmd]) => `${ns}:${cmd}`))) {
        if (commandGroups.has(name.split(':')[0]) && !installedCommand(name))
          check('command', name);
      }
      for (const [, name] of line.matchAll(/\b([a-z][\w-]*)\/SKILL\.md/g)) {
        if (!installedSkills.has(name)) check('skill', name);
      }
      for (const name of nonCoreAgents) {
        const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (new RegExp(`["\`]${esc}["\`]|:-${esc}\\}`).test(line)) check('agent', name);
      }
    });
  }
  return out;
}

describe('the core pack', () => {
  it('references only skills, commands and agents core installs, or says which pack to add', () => {
    expect(problems()).toEqual([]);
  });
});
