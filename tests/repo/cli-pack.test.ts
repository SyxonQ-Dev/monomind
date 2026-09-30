/**
 * @monoes/monomindcli 2.16.2–2.16.4 shipped WITHOUT the monodesign skill.
 * packages/@monomind/cli/.claude/skills/monodesign/ is gitignored and only
 * compiled by packages/@monoes/monodesign/scripts/sync-skill.mjs, so it shipped
 * only when the publishing checkout happened to have compiled it — while
 * SKILLS_MAP.core lists it and the Monodesign agent depends on it.
 *
 * Now the CLI's `prepack` compiles it (every npm/pnpm pack and publish runs
 * prepack), and scripts/check-cli-pack.mjs asserts the packed file list holds
 * the monodesign SKILL.md and every SKILLS_MAP skill: in prepublishOnly (the
 * publish fails) and in the publish smoke test on the real tarball.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { missingFromPack, packEntries, requiredPackFiles } from '../../scripts/check-cli-pack.mjs';
import { compileGeneratedSkills } from '../../scripts/sync-claude-trees.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI_DIR = join(REPO_ROOT, 'packages/@monomind/cli');
const SCRIPT = join(REPO_ROOT, 'scripts', 'check-cli-pack.mjs');

describe('CLI package contents', () => {
  it('requires the monodesign skill and every SKILLS_MAP skill', () => {
    const required = requiredPackFiles({ core: ['monodesign', 'mastermind-*'], x: ['foo'] });
    expect(required).toEqual(['.claude/skills/foo/SKILL.md', '.claude/skills/monodesign/SKILL.md']);
  });

  it('reports what a pack is missing, with or without the tarball package/ prefix', () => {
    const required = ['.claude/skills/monodesign/SKILL.md', '.claude/skills/foo/SKILL.md'];
    expect(missingFromPack(['package/.claude/skills/foo/SKILL.md'], required)).toEqual([
      '.claude/skills/monodesign/SKILL.md',
    ]);
    expect(
      missingFromPack(
        ['.claude/skills/foo/SKILL.md', '.claude/skills/monodesign/SKILL.md'],
        required,
      ),
    ).toEqual([]);
  });

  it('reads npm pack --json from npm 11 (array) and npm 12 (object keyed by name)', () => {
    const entry = { id: '@x/demo@1.0.0', name: '@x/demo', files: [{ path: 'index.js' }] };
    const npm11 = JSON.stringify([entry], null, 2);
    const npm12 = JSON.stringify({ '@x/demo': entry }, null, 2);
    expect(packEntries(npm11)).toEqual([entry]);
    expect(packEntries(npm12)).toEqual([entry]);
  });

  it('prepack compiles monodesign and prepublishOnly checks the pack after building', () => {
    const { scripts } = JSON.parse(readFileSync(join(CLI_DIR, 'package.json'), 'utf8'));
    expect(scripts.prepack).toContain('monodesign/scripts/sync-skill.mjs');
    const publish: string = scripts.prepublishOnly;
    expect(publish).toContain('scripts/check-cli-pack.mjs');
    expect(publish.indexOf('check-cli-pack.mjs')).toBeGreaterThan(publish.indexOf('npm run build'));
  });

  it('the publish smoke test asserts the packed tarball contents', () => {
    const workflow = readFileSync(
      join(REPO_ROOT, '.github/workflows/publish-smoke-test.yml'),
      'utf8',
    );
    expect(workflow).toContain('scripts/check-cli-pack.mjs');
  });

  it('the CLI package as packed from this checkout passes the check', () => {
    compileGeneratedSkills(REPO_ROOT);
    expect(() =>
      execFileSync('node', [SCRIPT, CLI_DIR], { cwd: REPO_ROOT, encoding: 'utf8', stdio: 'pipe' }),
    ).not.toThrow();
  }, 60_000);
});
