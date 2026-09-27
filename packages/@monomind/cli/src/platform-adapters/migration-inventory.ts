/** Inventory of legacy pre-adapter platform install surfaces.
 * File-size sweep: split out of migration.ts.
 */

export interface LegacySurface {
  id: string;
  path: string;
  scope: 'project' | 'user';
  ownership: 'marker' | 'named-entry' | 'monomind-file';
  action: 'remove-block' | 'remove-entry' | 'remove-file' | 'migrate';
}

export interface LegacyMigrationResult {
  changed: readonly string[];
  skipped: readonly string[];
  diagnostics: readonly string[];
}

/**
 * Every surface is explicit so detection can remain read-only and never infer
 * ownership from an arbitrary file name or config location.
 */
export const LEGACY_SURFACE_INVENTORY: readonly LegacySurface[] = Object.freeze([
  {
    id: 'codex-sessionstart',
    path: '.codex/config.toml',
    scope: 'user',
    ownership: 'marker',
    action: 'remove-block',
  },
  {
    id: 'codex-activate-script',
    path: '.codex/monomind-activate.cjs',
    scope: 'user',
    ownership: 'monomind-file',
    action: 'remove-file',
  },
  {
    id: 'cursor-sessionstart',
    path: '.cursor/settings.json',
    scope: 'project',
    ownership: 'named-entry',
    action: 'remove-entry',
  },
  {
    id: 'cursor-activate-script',
    path: '.cursor/monomind-activate.cjs',
    scope: 'user',
    ownership: 'monomind-file',
    action: 'remove-file',
  },
  {
    id: 'antigravity-plugin',
    path: '.gemini/antigravity-cli/plugins/monomind',
    scope: 'user',
    ownership: 'monomind-file',
    action: 'remove-file',
  },
  {
    id: 'shared-agent-skills',
    path: '.agents/skills',
    scope: 'project',
    ownership: 'monomind-file',
    action: 'remove-file',
  },
  {
    id: 'shared-gemini-skills',
    path: '.gemini/skills',
    scope: 'user',
    ownership: 'monomind-file',
    action: 'remove-file',
  },
  {
    id: 'openclaw-config',
    path: '.claw/config.md',
    scope: 'project',
    ownership: 'marker',
    action: 'migrate',
  },
  {
    id: 'cursor-rules',
    path: '.cursorrules',
    scope: 'project',
    ownership: 'marker',
    action: 'remove-block',
  },
  {
    id: 'droid-instructions',
    path: 'DROID.md',
    scope: 'project',
    ownership: 'marker',
    action: 'remove-block',
  },
  {
    id: 'antigravity-rules',
    path: '.agents/rules/monomind.md',
    scope: 'project',
    ownership: 'marker',
    action: 'remove-block',
  },
  {
    id: 'trae-rules',
    path: '.trae/rules/monomind.md',
    scope: 'project',
    ownership: 'marker',
    action: 'migrate',
  },
  {
    id: 'hermes-instructions',
    path: 'HERMES.md',
    scope: 'project',
    ownership: 'marker',
    action: 'remove-block',
  },
  {
    id: 'kiro-steering',
    path: '.kiro/steering/monomind.md',
    scope: 'project',
    ownership: 'marker',
    action: 'migrate',
  },
  {
    id: 'aider-corrupted-yaml',
    path: '.aider.conf.yml',
    scope: 'project',
    ownership: 'marker',
    action: 'migrate',
  },
  {
    id: 'bare-instruction-markers',
    path: 'AGENTS.md',
    scope: 'project',
    ownership: 'marker',
    action: 'migrate',
  },
  {
    id: 'claude-bare-instruction-markers',
    path: 'CLAUDE.md',
    scope: 'project',
    ownership: 'marker',
    action: 'migrate',
  },
  {
    id: 'gemini-bare-instruction-markers',
    path: 'GEMINI.md',
    scope: 'project',
    ownership: 'marker',
    action: 'migrate',
  },
  {
    id: 'copilot-bare-instruction-markers',
    path: '.github/copilot-instructions.md',
    scope: 'project',
    ownership: 'marker',
    action: 'migrate',
  },
  {
    id: 'cursor-bare-instruction-markers',
    path: '.cursor/rules/monomind.mdc',
    scope: 'project',
    ownership: 'marker',
    action: 'migrate',
  },
  {
    id: 'claude-global-instructions',
    path: '.claude/CLAUDE.md',
    scope: 'user',
    ownership: 'marker',
    action: 'remove-block',
  },
  {
    id: 'claude-global-sessionstart',
    path: '.claude/settings.json',
    scope: 'user',
    ownership: 'named-entry',
    action: 'remove-entry',
  },
]);
