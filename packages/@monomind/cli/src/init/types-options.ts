/**
 * V1 Init System Types — the complete InitOptions shape and its presets.
 * File-size sweep: split out of types.ts.
 */

import type {
  AgentsConfig,
  CommandsConfig,
  HooksConfig,
  InitComponents,
  MCPConfig,
  RuntimeConfig,
  SkillsConfig,
  StatuslineConfig,
} from './types-components.js';
import { DEFAULT_EMBEDDING_MODEL, type EmbeddingsConfig } from './types-embeddings.js';

/**
 * Complete init options
 */
export interface InitOptions {
  /** Target directory */
  targetDir: string;
  /** Source base directory for skills/commands/agents (optional) */
  sourceBaseDir?: string;
  /** Explicit adapter targets selected by init flags; absent keeps legacy init behavior. */
  selectedPlatforms?: readonly import('../platform-adapters/types.js').PlatformId[];
  /** Opt in to platform-native deterministic hooks; disabled by default. */
  enablePlatformHooks?: boolean;
  /** Force overwrite existing files */
  force: boolean;
  /** Keep a managed block the user edited even though `force` is set —
   *  `init upgrade` refreshes blocks with `force` but is not the user's
   *  explicit --force (see file-guard.ts). */
  preserveEdits?: boolean;
  /** `--if-missing`: create only files that don't exist yet; never touch an
   *  existing file (CLAUDE.md, .claude/settings.json, skills/commands/agents
   *  copies, …), even one `force` would otherwise refresh. Idempotent: a
   *  second run against the same directory creates nothing new. */
  ifMissing?: boolean;
  /** Run in interactive mode */
  interactive: boolean;
  /** Components to initialize */
  components: InitComponents;
  /** Hooks configuration */
  hooks: HooksConfig;
  /** Skills configuration */
  skills: SkillsConfig;
  /** Commands configuration */
  commands: CommandsConfig;
  /** Agents configuration */
  agents: AgentsConfig;
  /** Statusline configuration */
  statusline: StatuslineConfig;
  /** MCP configuration */
  mcp: MCPConfig;
  /** Runtime configuration */
  runtime: RuntimeConfig;
  /** Embeddings configuration */
  embeddings: EmbeddingsConfig;
  /**
   * Run the post-init `doctor --install` pass, which may perform a global
   * `npm install -g @anthropic-ai/claude-code` if the Claude Code CLI isn't
   * already present. Defaults to true (undefined is treated as true) for
   * backward compatibility; set false (`monomind init --no-install`) to skip
   * it entirely.
   */
  installClaudeCode?: boolean;
  /**
   * Initialize the memory database (`.swarm/memory.db`) the way `monomind
   * memory init` does, keeping an existing one. Runs only with
   * `components.runtime`; undefined is treated as true (`--no-memory` sets false).
   */
  initMemory?: boolean;
}

/**
 * Default init options - full V1 setup
 */
export const DEFAULT_INIT_OPTIONS: InitOptions = {
  targetDir: process.cwd(),
  force: false,
  interactive: true,
  components: {
    settings: true,
    skills: true,
    commands: true,
    agents: true,
    helpers: true,
    statusline: true,
    mcp: true,
    runtime: true,
    claudeMd: true,
    monograph: true,
    antigravity: true,
    opencode: false,
    kimicode: false,
    codex: false,
  },
  hooks: {
    preToolUse: true,
    postToolUse: true,
    userPromptSubmit: true,
    sessionStart: true,
    stop: true,
    preCompact: true,
    notification: true,
    teammateIdle: true,
    taskCompleted: true,
    timeout: 5000,
    continueOnError: true,
  },
  skills: {
    core: true,
    extended: true,
    memory: true,
    github: true,
    browser: true,
    advanced: true,

    all: true,
  },
  commands: {
    core: true,
    analysis: true,
    automation: true,
    github: true,
    hooks: true,
    monitoring: true,
    optimization: true,
    all: true,
  },
  agents: {
    core: true,
    consensus: true,
    github: true,
    monoswarm: true,
    optimization: true,
    testing: true,

    all: true,
  },
  statusline: {
    enabled: true,
    showProgress: true,
    showSecurity: true,
    showSwarm: true,
    showHooks: true,
    showPerformance: true,
    refreshInterval: 5000,
  },
  mcp: {
    monomind: true,
    monograph: false,
    autoStart: false,
    port: 3000,
  },
  runtime: {
    topology: 'hierarchical-mesh',
    maxAgents: 15,
    memoryBackend: 'hybrid',
    enableNeural: true,
    enableLearningBridge: true,
    enableAgentScopes: true,
  },
  embeddings: {
    enabled: true,
    model: DEFAULT_EMBEDDING_MODEL,
    hyperbolic: true,
    curvature: -1.0,
    predownload: false, // Don't auto-download to speed up init
    cacheSize: 256,
    neuralSubstrate: true,
  },
};

/**
 * Minimal init options
 */
export const MINIMAL_INIT_OPTIONS: InitOptions = {
  ...DEFAULT_INIT_OPTIONS,
  components: {
    settings: true,
    skills: true,
    commands: false,
    agents: false,
    helpers: false,
    statusline: false,
    mcp: true,
    runtime: true,
    claudeMd: true,
    monograph: false,
    antigravity: false,
    opencode: false,
    kimicode: false,
    codex: false,
  },
  hooks: {
    ...DEFAULT_INIT_OPTIONS.hooks,
    userPromptSubmit: false,
    stop: false,
    notification: false,
    teammateIdle: false,
    taskCompleted: false,
  },
  skills: {
    core: true,
    extended: false,
    memory: true,
    github: true,
    browser: true,
    advanced: false,

    all: false,
  },
  agents: {
    core: true,
    consensus: false,
    github: false,
    monoswarm: false,
    optimization: false,
    testing: false,

    all: false,
  },
  runtime: {
    topology: 'mesh',
    maxAgents: 5,
    memoryBackend: 'memory',
    enableNeural: false,
    enableLearningBridge: false,
    enableAgentScopes: false,
  },
  embeddings: {
    enabled: false,
    model: DEFAULT_EMBEDDING_MODEL,
    hyperbolic: false,
    curvature: -1.0,
    predownload: false,
    cacheSize: 128,
    neuralSubstrate: false,
  },
};

/**
 * Full init options (everything enabled)
 */
export const FULL_INIT_OPTIONS: InitOptions = {
  ...DEFAULT_INIT_OPTIONS,
  components: {
    settings: true,
    skills: true,
    commands: true,
    agents: true,
    helpers: true,
    statusline: true,
    mcp: true,
    runtime: true,
    claudeMd: true,
    monograph: true,
    antigravity: true,
    opencode: false,
    kimicode: false,
    codex: false,
  },
  skills: {
    core: true,
    extended: true,
    memory: true,
    github: true,
    browser: true,
    advanced: true,

    all: true,
  },
  commands: {
    ...DEFAULT_INIT_OPTIONS.commands,
    all: true,
  },
  agents: {
    ...DEFAULT_INIT_OPTIONS.agents,
    all: true,
  },
  mcp: {
    monomind: true,
    monograph: false,
    autoStart: false,
    port: 3000,
  },
  embeddings: {
    enabled: true,
    model: DEFAULT_EMBEDDING_MODEL,
    hyperbolic: true,
    curvature: -1.0,
    predownload: true, // Pre-download for full init
    cacheSize: 256,
    neuralSubstrate: true,
  },
};
