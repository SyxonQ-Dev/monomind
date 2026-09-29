/**
 * V1 Init System Types — component/feature configuration interfaces.
 * File-size sweep: split out of types.ts.
 */

/**
 * Components that can be initialized
 */
export interface InitComponents {
  /** Create .claude/settings.json with hooks */
  settings: boolean;
  /** Copy skills to .claude/skills/, .gemini/skills/, .agents/skills/ */
  skills: boolean;
  /** Copy commands to .claude/commands/ */
  commands: boolean;
  /** Copy agents to .claude/agents/ */
  agents: boolean;
  /** Create helper scripts in .claude/helpers/ */
  helpers: boolean;
  /** Configure statusline */
  statusline: boolean;
  /** Create MCP configuration */
  mcp: boolean;
  /** Create .monomind/ directory (V1 runtime) */
  runtime: boolean;
  /** Create CLAUDE.md with swarm guidance */
  claudeMd: boolean;
  /** Build knowledge graph on init using monograph (TypeScript) */
  monograph: boolean;
  /** Emit Antigravity (Gemini) artifacts. */
  antigravity: boolean;
  /** Emit opencode artifacts (opencode.json + .opencode/). Opt-in — default
   *  false so standard `monomind init` (Claude + Antigravity) is unchanged. */
  opencode: boolean;
  /** Emit Kimi Code artifacts (.kimi-code/ + AGENTS.md). Opt-in — default
   *  false so standard `monomind init` is unchanged. */
  kimicode: boolean;
  /** Emit Codex artifacts (.codex/config.toml + AGENTS.md). Opt-in — default
   *  false so standard `monomind init` is unchanged. */
  codex: boolean;
  /** Emit cline artifacts (.clinerules/monomind.md). Opt-in via `--target
   *  cline`; absent means false. */
  cline?: boolean;
  /** `--target agents`: write AGENTS.md and nothing else (no Claude files,
   *  no `.monomind/` state) — for runtimes that read AGENTS.md natively.
   *  Absent means false. */
  agentsOnly?: boolean;
}

/**
 * Hook configuration options
 * Valid Claude Code hook events (23 total):
 *   PreToolUse, PostToolUse, PostToolUseFailure, UserPromptSubmit,
 *   SessionStart, SessionEnd, Stop, SubagentStart, SubagentStop,
 *   PreCompact, PostCompact, Notification, ConfigChange,
 *   InstructionsLoaded, PermissionRequest, WorktreeCreate, WorktreeRemove,
 *   TeammateIdle, TaskCompleted, Elicitation, ElicitationResult
 */
export interface HooksConfig {
  /** Enable PreToolUse hooks */
  preToolUse: boolean;
  /** Enable PostToolUse hooks */
  postToolUse: boolean;
  /** Enable UserPromptSubmit for routing */
  userPromptSubmit: boolean;
  /** Enable SessionStart hooks */
  sessionStart: boolean;
  /** No longer generates a hook (#417); kept so existing option objects stay valid */
  stop: boolean;
  /** Enable PreCompact hooks (context preservation before compaction) */
  preCompact: boolean;
  /** No longer generates a hook (#417); kept so existing option objects stay valid */
  notification: boolean;
  /** Enable TeammateIdle hooks (agent teams auto-assign) */
  teammateIdle: boolean;
  /** Enable TaskCompleted hooks (agent teams pattern learning) */
  taskCompleted: boolean;
  /** Hook timeout in milliseconds */
  timeout: number;
  /** Continue on hook error */
  continueOnError: boolean;
}

/**
 * Skills configuration
 */
export interface SkillsConfig {
  /** Include core skills (the mastermind engineering workflows, monolean, monodesign) */
  core: boolean;
  /** Include extended skills (mastermind org admin, monoswarm, hooks, monomotion, …) */
  extended?: boolean;
  /** Include memory/SQLite skills */
  memory: boolean;
  /** Include GitHub integration skills */
  github: boolean;
  /** Include browser automation skills */
  browser: boolean;
  /** Include advanced skills (agentic-jujutsu, security, performance, etc.) */
  advanced: boolean;
  /** Include all available skills */
  all: boolean;
}

/**
 * Commands configuration
 */
export interface CommandsConfig {
  /** Include core commands (mastermind.md, tokens.md, browse.md, ts.md) */
  core: boolean;
  /** Include agents commands */
  agents?: boolean;
  /** Include analysis commands */
  analysis: boolean;
  /** Include automation commands */
  automation: boolean;
  /** Include coordination commands */
  coordination?: boolean;
  /** Include github commands */
  github: boolean;
  /** Include monoswarm commands */
  monoswarm?: boolean;
  /** Include hooks commands */
  hooks: boolean;
  /** Include mastermind commands */
  mastermind?: boolean;
  /** Include memory commands */
  memory?: boolean;
  /** Include monitoring commands */
  monitoring: boolean;
  /** Include monograph commands */
  monograph?: boolean;
  /** Include monomind commands */
  monomind?: boolean;
  /** Include optimization commands */
  optimization: boolean;
  /** Include pair commands */
  pair?: boolean;
  /** Include stream-chain commands */
  streamChain?: boolean;
  /** Include truth commands */
  truth?: boolean;
  /** Include workflows commands */
  workflows?: boolean;
  /** Include all commands */
  all: boolean;
}

/**
 * Agents configuration
 */
export interface AgentsConfig {
  /** Include core agents (coder, tester, reviewer) */
  core: boolean;
  /** Include consensus agents */
  consensus: boolean;
  /** Include GitHub agents */
  github: boolean;
  /** Include monoswarm agents */
  monoswarm: boolean;
  /** Include optimization agents */
  optimization: boolean;
  /** Include testing agents */
  testing: boolean;
  /** Include all agents */
  all: boolean;
}

/**
 * Statusline configuration
 */
export interface StatuslineConfig {
  /** Enable statusline */
  enabled: boolean;
  /** Show V1 progress */
  showProgress: boolean;
  /** Show security status */
  showSecurity: boolean;
  /** Show swarm activity */
  showSwarm: boolean;
  /** Show hooks metrics */
  showHooks: boolean;
  /** Show performance targets */
  showPerformance: boolean;
  /** Refresh interval in milliseconds */
  refreshInterval: number;
}

/**
 * MCP configuration
 */
export interface MCPConfig {
  /** Include monomind MCP server */
  monomind: boolean;
  /** Include monograph knowledge graph MCP server */
  monograph: boolean;
  /** Auto-start MCP server */
  autoStart: boolean;
  /** Server port */
  port: number;
  /**
   * Exact version to pin the generated MCP entry to (`monomind init --pin`).
   * Undefined — the default — pins to the running CLI's version (#419);
   * `latest` keeps the floating `monomind@latest` command. `init --force`
   * refreshes the pin after an upgrade.
   */
  pin?: string;
}

/**
 * Runtime configuration (.monomind/)
 */
export interface RuntimeConfig {
  /** Swarm topology */
  topology: 'mesh' | 'hierarchical' | 'hierarchical-mesh' | 'adaptive';
  /** Maximum agents */
  maxAgents: number;
  /** Memory backend */
  memoryBackend: 'memory' | 'sqlite' | 'hybrid';
  /** Enable neural learning */
  enableNeural: boolean;
  /** Enable learning system - connects insights to the pattern store */
  enableLearningBridge?: boolean;
  /** Enable AgentMemoryScope (ADR-049) - 3-scope agent memory */
  enableAgentScopes?: boolean;
  /** CLAUDE.md template variant */
  claudeMdTemplate?: ClaudeMdTemplate;
}

/** Template variants for generated CLAUDE.md files */
export type ClaudeMdTemplate =
  | 'minimal'
  | 'standard'
  | 'full'
  | 'security'
  | 'performance'
  | 'solo';
