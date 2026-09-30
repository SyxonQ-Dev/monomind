/**
 * GH #411: `init` installs the core pack; the rest of what ships is in opt-in
 * packs chosen with `--packs` / `--all-packs`, the wizard, or `monomind packs
 * add` later. Upgrading or re-running init never deletes what a project has.
 *
 * Runs against a copy of the shipped package tree plus a monodesign stub
 * (monodesign is compiled into the package only at pack time).
 */

// Load through init.ts first, as the CLI does: init/index has an import cycle
// back into commands/init.ts that only resolves in that order.
import '../src/commands/init.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { copyAgents, copyCommands, copySkills } from '../src/init/copy-assets.js';
import { readInitManifest, recordPacks } from '../src/init/init-manifest.js';
import { addPacks, installedPacks, removePacks } from '../src/init/pack-install.js';
import { CORE_PACK, OPTIONAL_PACKS, PACK_NAMES, parsePackList } from '../src/init/packs.js';
import { resolveInitOptions } from '../src/init/resolve-options.js';
import {
  DEFAULT_INIT_OPTIONS,
  detectPlatform,
  FULL_INIT_OPTIONS,
  type InitOptions,
  type InitResult,
} from '../src/init/types.js';
import { executeUpgradeWithMissing } from '../src/init/upgrade.js';

// Platform detection is stubbed so the results don't depend on this machine (#420).
const noPlatforms = () => [];
import type { CommandContext } from '../src/types.js';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

let source: string;
let target: string;
beforeAll(() => {
  source = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-packs-src-'));
  fs.cpSync(path.join(PKG_ROOT, '.claude'), path.join(source, '.claude'), { recursive: true });
  const monodesign = path.join(source, '.claude', 'skills', 'monodesign');
  fs.mkdirSync(monodesign, { recursive: true });
  fs.writeFileSync(
    path.join(monodesign, 'SKILL.md'),
    '---\nname: monodesign\ndescription: "Design UI."\n---\n',
  );
});
afterAll(() => fs.rmSync(source, { recursive: true, force: true }));
beforeEach(() => {
  target = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-packs-'));
});
afterEach(() => fs.rmSync(target, { recursive: true, force: true }));

function options(base: InitOptions, packs?: string[]): InitOptions {
  return { ...structuredClone(base), targetDir: target, sourceBaseDir: source, packs };
}

async function copyAll(opts: InitOptions): Promise<InitResult> {
  const result = freshResult();
  await copySkills(target, opts, result);
  await copyCommands(target, opts, result);
  await copyAgents(target, opts, result);
  return result;
}

const skills = () => fs.readdirSync(path.join(target, '.claude', 'skills')).sort();
const exists = (rel: string) => fs.existsSync(path.join(target, rel));

function ctx(flags: Record<string, unknown>): CommandContext {
  return { args: [], flags: { _: [], ...flags }, cwd: target, interactive: false } as CommandContext;
}

describe('pack selection', () => {
  it('the default install is exactly the core pack', async () => {
    const result = await copyAll(options(DEFAULT_INIT_OPTIONS));
    expect(result.errors).toEqual([]);
    expect(skills()).toEqual([...CORE_PACK.skills].sort());
    expect(exists('.claude/commands/mastermind/do.md')).toBe(true);
    expect(exists('.claude/commands/mastermind/createorg.md')).toBe(false);
    expect(exists('.claude/commands/monoswarm')).toBe(false);
    expect(exists('.claude/agents/core/coder.md')).toBe(true);
    expect(exists('.claude/agents/engineering/engineering-security-engineer.md')).toBe(true);
    expect(exists('.claude/agents/engineering/engineering-wechat-mini-program-developer.md')).toBe(
      false,
    );
    expect(exists('.claude/agents/marketing')).toBe(false);
  });

  it('--packs adds the named packs on top of core', async () => {
    const resolved = resolveInitOptions(ctx({ packs: 'orgs,specialists' }), target, noPlatforms);
    expect(resolved.ok && resolved.options.packs).toEqual(['orgs', 'specialists']);
    if (!resolved.ok) return;
    await copyAll({ ...resolved.options, sourceBaseDir: source });
    expect(skills()).toContain('mastermind-createorg');
    expect(skills()).toContain('mastermind');
    expect(skills()).not.toContain('mastermind-access');
    expect(exists('.claude/commands/mastermind/runorg.md')).toBe(true);
    expect(exists('.claude/agents/engineering/engineering-wechat-mini-program-developer.md')).toBe(
      true,
    );
  });

  it('--all-packs selects every pack; --full installs every skill', async () => {
    const resolved = resolveInitOptions(ctx({ 'all-packs': true }), target, noPlatforms);
    expect(resolved.ok && resolved.options.packs).toEqual([...PACK_NAMES]);
    await copyAll(options(FULL_INIT_OPTIONS));
    const all = [...CORE_PACK.skills, ...OPTIONAL_PACKS.flatMap((p) => p.skills)].sort();
    expect(skills()).toEqual(all);
  });

  it('rejects an unknown pack name', () => {
    const resolved = resolveInitOptions(ctx({ packs: 'orgs,nope' }), target, noPlatforms);
    expect(resolved.ok).toBe(false);
    expect(!resolved.ok && resolved.message).toMatch(/Unknown pack: nope/);
    expect(parsePackList('core,github')).toEqual({ ok: true, packs: ['github'] });
  });

  it('--minimal still installs only core skills, and takes --packs', () => {
    const resolved = resolveInitOptions(ctx({ minimal: true, packs: 'extras' }), target, noPlatforms);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.options.components.commands).toBe(false);
    expect(resolved.options.components.agents).toBe(false);
    expect(resolved.options.skills).toEqual({ core: true, all: false });
    expect(resolved.options.packs).toEqual(['extras']);
  });
});

describe('upgrading an install made before packs', () => {
  it('re-running the default init keeps every skill, command and agent it has', async () => {
    await copyAll(options(FULL_INIT_OPTIONS));
    const before = fs.readdirSync(path.join(target, '.claude'), { recursive: true }).sort();
    const result = await copyAll(options(DEFAULT_INIT_OPTIONS));
    expect(result.removed).toEqual([]);
    const after = fs.readdirSync(path.join(target, '.claude'), { recursive: true }).sort();
    expect(after).toEqual(before);
  });

  it('counts every pack it has on disk as installed', async () => {
    await copyAll(options(FULL_INIT_OPTIONS));
    expect(readInitManifest(target)?.packs).toBeUndefined();
    expect(installedPacks(target)).toEqual([...PACK_NAMES]);
  });

  it('init upgrade --add-missing adds only the packs the project has', async () => {
    recordPacks(target, ['orgs']);
    const result = await executeUpgradeWithMissing(target);
    expect(result.addedSkills).toContain('mastermind-runorg');
    expect(result.addedSkills).toContain('mastermind-review');
    expect(result.addedSkills).not.toContain('mastermind-access');
    expect(result.addedAgents).not.toContain('marketing');
  });
});

describe('packs add / remove', () => {
  it('add installs a pack into an initialised project and records it', async () => {
    await copyAll(options(DEFAULT_INIT_OPTIONS));
    const result = await addPacks(target, ['org-admin', 'business'], source);
    expect(result.errors).toEqual([]);
    expect(skills()).toContain('mastermind-access');
    expect(exists('.claude/agents/marketing/marketing-cro-specialist.md')).toBe(true);
    expect(exists('.claude/commands/mastermind/sales.md')).toBe(true);
    expect(exists('.claude/commands/mastermind/do.md')).toBe(true);
    expect(installedPacks(target)).toEqual(['business', 'org-admin']);
  });

  it('remove deletes only unchanged files and keeps the user’s', async () => {
    await copyAll(options(DEFAULT_INIT_OPTIONS));
    await addPacks(target, ['business'], source);
    const edited = path.join(target, '.claude', 'commands', 'mastermind', 'sales.md');
    fs.appendFileSync(edited, '\nMy notes.\n');
    const result = removePacks(target, ['business']);
    expect(exists('.claude/agents/marketing')).toBe(false);
    expect(exists('.claude/commands/mastermind/finance.md')).toBe(false);
    expect(exists('.claude/commands/mastermind/do.md')).toBe(true);
    expect(result.kept).toEqual(['.claude/commands/mastermind/sales.md']);
    expect(installedPacks(target)).toEqual([]);
  });
});
