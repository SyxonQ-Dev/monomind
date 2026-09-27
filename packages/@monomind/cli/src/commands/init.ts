/**
 * CLI Init Command
 * Comprehensive initialization for Monomind with Claude Code integration
 */

import { DEFAULT_INIT_OPTIONS } from '../init/index.js';
import type { Command } from '../types.js';
import { initAction } from './init-action.js';
import { quickstartCommand } from './init-quickstart.js';
import { checkCommand, hooksCommand, skillsCommand } from './init-subcommands.js';
import { upgradeCommand } from './init-upgrade.js';
import { wizardCommand } from './init-wizard.js';

export const initCommand: Command = {
  name: 'init',
  description: 'Initialize MonoMind in the current directory',
  subcommands: [
    wizardCommand,
    checkCommand,
    skillsCommand,
    hooksCommand,
    upgradeCommand,
    quickstartCommand,
  ],
  options: [
    {
      name: 'force',
      short: 'f',
      description: 'Overwrite existing configuration',
      type: 'boolean',
      default: false,
    },
    {
      name: 'yes',
      short: 'y',
      description: 'Skip confirmation prompts (also honoured via CI=true env var)',
      type: 'boolean',
      default: false,
    },
    {
      name: 'minimal',
      short: 'm',
      description: 'Create minimal configuration',
      type: 'boolean',
      default: false,
    },
    {
      name: 'full',
      description: 'Create full configuration with all components',
      type: 'boolean',
      default: false,
    },
    {
      name: 'skip-claude',
      description: 'Skip .claude/ directory creation (runtime only)',
      type: 'boolean',
      default: false,
    },
    {
      name: 'only-claude',
      description: 'Only create .claude/ directory (skip runtime)',
      type: 'boolean',
      default: false,
    },
    {
      name: 'no-install',
      description:
        'Skip the post-init `doctor --install` pass, which may otherwise run a global `npm install -g @anthropic-ai/claude-code`',
      type: 'boolean',
      default: false,
    },
    {
      name: 'target',
      short: 't',
      description: 'Coding system to initialize (default: all)',
      type: 'string',
      choices: ['all', 'claude', 'antigravity', 'opencode', 'kimicode', 'codex'],
    },
    {
      name: 'platform',
      description: 'Adapter platform id(s), comma-separated; preserves --target compatibility',
      type: 'string',
    },
    {
      name: 'enable-hooks',
      description: 'Opt in to deterministic native platform hooks',
      type: 'boolean',
      default: false,
    },
    {
      // Opt-in on purpose (#312): a pin written without being asked for would
      // silently freeze the project on whichever version happened to run
      // `init`, and upgrading monomind would stop changing the MCP server it
      // starts. Projects whose policy forbids `@latest` ask for it explicitly.
      name: 'pin',
      description:
        'Pin the generated MCP entry to an exact version instead of monomind@latest ' +
        '(bare --pin uses the running version; --pin <version> uses that one)',
      type: 'string',
    },
    {
      name: 'opencode',
      description: 'Initialize only OpenCode (alias for --target opencode)',
      type: 'boolean',
      default: false,
    },
    {
      name: 'kimicode',
      description: 'Initialize only Kimi Code (alias for --target kimicode)',
      type: 'boolean',
      default: false,
    },
    {
      name: 'codex',
      description: 'Initialize only Codex (alias for --target codex)',
      type: 'boolean',
      default: false,
    },
    {
      name: 'start-all',
      description: 'Auto-start swarm and seed worker metrics after init (default: true)',
      type: 'boolean',
      default: true,
    },
    {
      // Declared as the positive `memory` so `--no-memory` reaches it (see
      // `watch` below). Initializes the same database `memory init` does.
      name: 'memory',
      description:
        'Initialize the memory database (.swarm/memory.db) during init (default: true; --no-memory skips)',
      type: 'boolean',
      default: true,
    },
    {
      // Declared as the positive `watch` so the parser's `--no-X` negation
      // actually reaches it. Declaring it as `no-watch` made `--no-watch` a
      // no-op — see the noWatch resolution in initAction.
      name: 'watch',
      description:
        'Start the monograph knowledge graph watcher after init ' +
        '(default: only when running interactively; --watch forces, --no-watch skips)',
      type: 'boolean',
      // Deliberately no `default`. The value must stay undefined when nobody
      // passed the flag, so init can tell "not asked" from "asked for true"
      // and only auto-start for an interactive user (#50).
    },
    {
      name: 'with-embeddings',
      description:
        'Write the embeddings config and download the local embedding model memory search uses (one-time, needs network; degrades to keyword search offline)',
      type: 'boolean',
      default: false,
    },
    {
      name: 'embedding-model',
      description: 'ONNX embedding model to use',
      type: 'string',
      default: DEFAULT_INIT_OPTIONS.embeddings.model,
      choices: [
        DEFAULT_INIT_OPTIONS.embeddings.model,
        'Xenova/all-MiniLM-L6-v2',
        'Xenova/all-mpnet-base-v2',
      ],
    },
  ],
  examples: [
    { command: 'monomind init', description: 'Initialize with default configuration' },
    {
      command: 'monomind init --no-start-all',
      description: 'Initialize without auto-starting services',
    },
    { command: 'monomind init --minimal', description: 'Initialize with minimal configuration' },
    { command: 'monomind init --full', description: 'Initialize with all components' },
    { command: 'monomind init --force', description: 'Reinitialize and overwrite existing config' },
    { command: 'monomind init --only-claude', description: 'Only create Claude Code integration' },
    { command: 'monomind init --skip-claude', description: 'Only create v1 runtime' },
    { command: 'monomind init --opencode', description: 'Initialize only OpenCode' },
    { command: 'monomind init --kimicode', description: 'Initialize only Kimi Code' },
    { command: 'monomind init --codex', description: 'Initialize only Codex' },
    {
      command: 'monomind init --target all',
      description: 'Initialize the five legacy coding-system targets',
    },
    { command: 'monomind init --target codex', description: 'Initialize only Codex' },
    { command: 'monomind init wizard', description: 'Interactive setup wizard' },
    {
      command: 'monomind init --no-memory',
      description: 'Initialize without creating the memory database',
    },
    {
      command: 'monomind init --no-watch',
      description: 'Initialize without starting the background graph watcher',
    },
    { command: 'monomind init --with-embeddings', description: 'Initialize with ONNX embeddings' },
    {
      command: 'monomind init --with-embeddings --embedding-model Xenova/all-mpnet-base-v2',
      description: 'Use larger embedding model',
    },
    { command: 'monomind init skills --all', description: 'Install all available skills' },
    { command: 'monomind init hooks --minimal', description: 'Create minimal hooks configuration' },
    { command: 'monomind init upgrade', description: 'Update helpers while preserving data' },
    {
      command: 'monomind init upgrade --settings',
      description: 'Update helpers and merge new settings (Agent Teams)',
    },
    { command: 'monomind init upgrade --verbose', description: 'Show detailed upgrade info' },
  ],
  action: initAction,
};

export default initCommand;
