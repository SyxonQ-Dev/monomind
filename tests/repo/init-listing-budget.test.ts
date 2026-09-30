/**
 * GH #411: Claude Code lists every installed skill and command with its
 * description in a budget of ~1% of the context window (~8k chars on a 200k
 * model) and drops descriptions past it. The default `monomind init` used
 * ~39.5k chars of skill/command listing (88 skills, 112 commands) and ~13k of
 * agent listing (84 agents), so most descriptions never reached the model.
 *
 * The default install is now the core pack, and it must stay under budget.
 * Every shipped skill, command and agent belongs to exactly one pack.
 *
 * Reads the BUILT init code (dist/) against the shipped package tree, with
 * monodesign compiled in as at pack time. `node scripts/measure-init-listing.mjs`
 * prints the same numbers.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DESCRIPTION_MAX_CHARS as LINT_MAX } from '../../scripts/lint-skills.mjs';
import { compileGeneratedSkills } from '../../scripts/sync-claude-trees.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PKG = join(REPO_ROOT, 'packages/@monomind/cli');
const DIST = join(PKG, 'dist/src/init');
const load = (m: string) => import(pathToFileURL(join(DIST, m)).href);

let init: Record<string, any>;
let target: string;

beforeAll(async () => {
  compileGeneratedSkills(REPO_ROOT);
  init = {
    ...(await load('copy-assets.js')),
    ...(await load('types.js')),
    ...(await load('listing-size.js')),
    ...(await load('packs.js')),
  };
  target = mkdtempSync(join(tmpdir(), 'mm-budget-'));
});
afterAll(() => rmSync(target, { recursive: true, force: true }));

async function installDefault() {
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
  return result;
}

describe('the default init listing', () => {
  it('fits Claude Code’s skill/command listing budget, and agents stay under half of it', async () => {
    const result = await installDefault();
    expect(result.errors).toEqual([]);
    const size = init.measureListing(join(target, '.claude'));
    expect(size.skills.count).toBe(init.CORE_PACK.skills.length);
    expect(size.skillsAndCommandsChars).toBeLessThanOrEqual(init.LISTING_BUDGET_CHARS);
    expect(size.agents.chars).toBeLessThanOrEqual(init.AGENT_LISTING_BUDGET_CHARS);
  });

  it('lint and init agree on the description cap', () => {
    expect(init.DESCRIPTION_MAX_CHARS).toBe(LINT_MAX);
  });
});

describe('packs cover what ships', () => {
  // Every file, not only .md: a shipped file no pack covers (agents/schemas/*.json)
  // is retired from projects that had it the next time init runs.
  const files = (dir: string): string[] =>
    readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .filter((f) => !f.split(/[\\/]/).pop()?.startsWith('._') && statSync(join(dir, f)).isFile())
      .map((f) => f.split('\\').join('/'));

  /** Every file an entry covers, relative to the kind's directory. */
  const covered = (root: string, entries: string[]): string[] =>
    entries.flatMap((e) =>
      statSync(join(root, e)).isDirectory() ? files(join(root, e)).map((f) => `${e}/${f}`) : [e],
    );

  it('every entry exists in the package tree and none is in two packs', () => {
    for (const kind of ['skills', 'commands', 'agents'] as const) {
      const root = join(PKG, '.claude', kind);
      const all = init.PACKS.flatMap((p: Record<string, string[]>) =>
        kind === 'skills' ? p[kind].map((s) => `${s}/SKILL.md`) : covered(root, p[kind]),
      );
      expect(
        all.filter((rel: string) => !statSync(join(root, rel), { throwIfNoEntry: false })),
      ).toEqual([]);
      expect(all.filter((rel: string, i: number) => all.indexOf(rel) !== i)).toEqual([]);
    }
  });

  it('every shipped skill, command and agent is in some pack', () => {
    const inPacks = (kind: string, root: string) =>
      new Set(init.PACKS.flatMap((p: Record<string, string[]>) => covered(root, p[kind])));
    const skillsRoot = join(PKG, '.claude/skills');
    const skills = readdirSync(skillsRoot).filter((d) =>
      statSync(join(skillsRoot, d, 'SKILL.md'), { throwIfNoEntry: false }),
    );
    const packSkills = new Set(init.PACKS.flatMap((p: Record<string, string[]>) => p.skills));
    expect(skills.filter((s) => !packSkills.has(s))).toEqual([]);

    const commandsRoot = join(PKG, '.claude/commands');
    const commands = files(commandsRoot).filter((rel) => {
      const segs = rel.split('/');
      // Docs are never installed; monoes/ ships with the package but not via init.
      return (
        segs[0] !== 'monoes' &&
        segs.at(-1) !== 'README.md' &&
        !segs.at(-1)?.startsWith('_') &&
        !segs.includes('references')
      );
    });
    const packCommands = inPacks('commands', commandsRoot);
    expect(commands.filter((c) => !packCommands.has(c))).toEqual([]);

    const agentsRoot = join(PKG, '.claude/agents');
    // reengineer-squad is repo-only (excluded from the npm package's files).
    const agents = files(agentsRoot).filter((rel) => !rel.startsWith('reengineer-squad/'));
    const packAgents = inPacks('agents', agentsRoot);
    expect(agents.filter((a) => !packAgents.has(a))).toEqual([]);
  });

  it('core holds every skill the platform adapters always write', async () => {
    const { MASTERMIND_SKILLS } = await import(
      pathToFileURL(join(PKG, 'dist/src/mastermind/manifest-data.js')).href
    );
    const core = new Set(init.CORE_PACK.skills);
    expect(
      MASTERMIND_SKILLS.map((s: { source: string }) => s.source).filter(
        (s: string) => !core.has(s),
      ),
    ).toEqual([]);
  });

  it('every .claude file a core command or skill reads by path is in core', async () => {
    await installDefault();
    const missing: string[] = [];
    const installed = join(target, '.claude');
    for (const rel of files(installed)) {
      const text = readFileSync(join(installed, rel), 'utf-8');
      for (const [, ref] of text.matchAll(/`(\.claude\/(?:commands|skills)\/[\w./-]+\.md)`/g)) {
        if (!statSync(join(target, ref), { throwIfNoEntry: false })) {
          missing.push(`${relative(target, join(installed, rel))} -> ${ref}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
