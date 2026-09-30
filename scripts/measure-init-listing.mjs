#!/usr/bin/env node
// Measure the skill/command/agent listing a `monomind init` preset installs
// (GH #411). Copies the preset's skills, commands and agents from the package
// tree into a throwaway directory with the built CLI's own copy functions,
// then prints what Claude Code would list: name + description chars per kind,
// against the ~8k-char skill+command budget (1% of a 200k context).
//
// Build the CLI first (pnpm -r run build).
//
// Run: node scripts/measure-init-listing.mjs [--minimal|--full] [--packs a,b|--all-packs] [--top N] [--json]

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { compileGeneratedSkills } from './sync-claude-trees.mjs';

const ROOT = process.cwd();
// monodesign is compiled into the package tree at pack time.
compileGeneratedSkills(ROOT);
const DIST = join(ROOT, 'packages/@monomind/cli/dist/src/init');
const load = (m) => import(pathToFileURL(join(DIST, m)).href);

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};

const { copyAgents, copyCommands, copySkills } = await load('copy-assets.js');
const types = await load('types.js');
const { measureListing, LISTING_BUDGET_CHARS } = await load('listing-size.js');
const packsMod = await load('packs.js');

const preset = flag('--minimal')
  ? types.MINIMAL_INIT_OPTIONS
  : flag('--full')
    ? types.FULL_INIT_OPTIONS
    : types.DEFAULT_INIT_OPTIONS;
const target = mkdtempSync(join(tmpdir(), 'mm-listing-'));
let options = {
  ...structuredClone(preset),
  targetDir: target,
  sourceBaseDir: join(ROOT, 'packages/@monomind/cli'),
};
if (flag('--all-packs') || value('--packs')) {
  const packs = flag('--all-packs') ? packsMod.PACK_NAMES : value('--packs').split(',');
  options = { ...options, packs };
}
const result = {
  created: { directories: [], files: [] },
  updated: [],
  skipped: [],
  removed: [],
  errors: [],
  summary: { skillsCount: 0, commandsCount: 0, agentsCount: 0, hooksEnabled: 0 },
};

try {
  if (options.components.skills) await copySkills(target, options, result);
  if (options.components.commands) await copyCommands(target, options, result);
  if (options.components.agents) await copyAgents(target, options, result);
  const size = measureListing(join(target, '.claude'));
  if (flag('--json')) {
    console.log(JSON.stringify({ ...size, budget: LISTING_BUDGET_CHARS }, null, 2));
  } else {
    const row = (label, s) =>
      `  ${label.padEnd(9)} ${String(s.count).padStart(4)}  ${String(s.chars).padStart(7)} chars`;
    console.log(row('skills', size.skills));
    console.log(row('commands', size.commands));
    console.log(row('agents', size.agents));
    const over = size.skillsAndCommandsChars > LISTING_BUDGET_CHARS;
    console.log(
      `  skills+commands: ${size.skillsAndCommandsChars} / ${LISTING_BUDGET_CHARS} chars ${over ? '(OVER budget)' : '(fits)'}`,
    );
    const top = Number(value('--top') ?? 0);
    if (top > 0) {
      console.log(`\n  Longest ${top} entries:`);
      for (const e of [...size.entries].sort((a, b) => b.chars - a.chars).slice(0, top)) {
        console.log(`  ${String(e.chars).padStart(5)}  ${e.kind.padEnd(7)} ${e.name}`);
      }
    }
  }
  for (const err of result.errors) console.error(`  error: ${err}`);
} finally {
  rmSync(target, { recursive: true, force: true });
}
