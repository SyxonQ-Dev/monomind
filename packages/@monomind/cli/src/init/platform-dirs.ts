// packages/@monomind/cli/src/init/platform-dirs.ts
/**
 * #372: which non-Claude directories an init run may create. `.gemini/` is
 * Antigravity/Gemini's; `.agents/` (skills + shared_instructions.md) is the
 * shared root Codex, OpenCode, Kimi and other agents read. Claude Code reads
 * neither, so `--target claude` must not add them to a user's repo.
 * `selectedPlatforms` absent (a programmatic caller predating adapter
 * selection) keeps the legacy behavior: create both.
 */

import type { InitOptions } from './types.js';

type Selection = Pick<InitOptions, 'selectedPlatforms'>;

export function wantsGeminiDirs(options: Selection): boolean {
  const sel = options.selectedPlatforms;
  return !sel || sel.some((p) => p === 'antigravity' || p === 'gemini');
}

export function wantsAgentsDirs(options: Selection): boolean {
  const sel = options.selectedPlatforms;
  return !sel || sel.some((p) => p !== 'claude');
}
