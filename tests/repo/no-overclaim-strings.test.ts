/**
 * Shipped user-facing text must not call monomind "self-learning" or suggest
 * the nonexistent `hooks post-edit --train-neural` flag.
 *
 * What actually happens: hooks log edits, outcomes and trajectories to local
 * JSON pattern files, the picker routes prompts by keyword, pick stats act as
 * a bounded ranking prior, and the reflexion worker writes templated notes.
 * No model is trained. Both phrases were removed from --help text, the
 * generated CLAUDE.md/CAPABILITIES.md templates, the guidance quick reference,
 * worker descriptions, the shipped slash commands and the docs site; this
 * keeps them from coming back.
 *
 * Only git-tracked files are scanned, so local scratch files never matter.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Surfaces a user reads: CLI/hooks source strings, the shipped asset trees,
 *  generated docs and the docs site. */
const PATHSPECS = [
  'packages/@monomind/cli/src',
  'packages/@monomind/hooks/src',
  'packages/@monomind/cli/.claude/commands',
  'packages/@monomind/cli/.claude/skills',
  'packages/@monomind/cli/.claude/helpers',
  '.claude/commands',
  '.claude/skills',
  '.claude/helpers',
  '.agents/skills',
  '.gemini/skills',
  '.kimi-code/plugin',
  '.kimi-code/skills',
  'doc',
  'README.md',
  'CLAUDE.md',
  'AGENTS.md',
  'GEMINI.md',
  '.monomind/CAPABILITIES.md',
  '.monomind/config.yaml',
  'packages/@monomind/cli/README.md',
  'packages/@monomind/cli/CLAUDE.md',
  'packages/@monomind/hooks/README.md',
];

/** agentic-jujutsu documents a separate npm package whose own README calls
 *  it self-learning; that is the package's claim, not monomind's. */
const EXCLUDED = [/(^|\/)skills\/agentic-jujutsu\//, /(^|\/)__tests__\//, /\.test\.ts$/];

const FORBIDDEN: Array<[string, RegExp]> = [
  ['self-learning', /self[- ]learning/i],
  ['--train-neural', /train-neural/i],
];

function trackedFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z', '--', ...PATHSPECS], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return out
    .split('\0')
    .filter(Boolean)
    .filter((f) => !EXCLUDED.some((re) => re.test(f)))
    .filter((f) => /\.(ts|cjs|mjs|js|md|html|json|yaml|yml|txt)$/.test(f));
}

describe('no self-learning / --train-neural claims in shipped text', () => {
  const files = trackedFiles();

  it('scans a non-trivial set of files', () => {
    expect(files.length).toBeGreaterThan(500);
  });

  for (const [label, re] of FORBIDDEN) {
    it(`no shipped file says "${label}"`, () => {
      const hits: string[] = [];
      for (const f of files) {
        let text: string;
        try {
          text = readFileSync(join(REPO_ROOT, f), 'utf8');
        } catch {
          continue; // deleted in the working tree but still in the index
        }
        text.split('\n').forEach((line, i) => {
          if (re.test(line)) hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 160)}`);
        });
      }
      expect(hits).toEqual([]);
    });
  }
});
