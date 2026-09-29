// packages/@monomind/cli/src/orgrt/agent-context.ts
/**
 * #365 (integrator review): scoped chats/orgs already let an agent run
 * `monomind org …` through an allowed Bash prefix, so `org role set-access
 * ... full` must refuse outright when it detects it is running inside an
 * agent's own process tree — no flag, TTY, or confirmation can override
 * this (a human granting full access runs the command themselves, in their
 * own terminal, with none of these env vars set).
 */

/** Env vars set (by a coding-agent CLI itself, or by monomind) on any
 *  process tree spawned FOR an agent turn — a chat's Bash tool, `agent
 *  exec`'s runner child, or an org role's own session:
 *   - `CLAUDECODE` / `CLAUDE_CODE_ENTRYPOINT` — set by Claude Code on every
 *     process it spawns for a turn (interactive or headless).
 *   - `MONOMIND_ORG_ROLE` — set on an org role's session env
 *     (session-stream.ts).
 *   - `MONOMIND_SDK_AGENT` — set on a codex/kimicode/opencode hook-handler
 *     process spawned from inside an org role's own tool call (the init
 *     generators' hook bridges).
 *   - `MONOMIND_AGENT_EXEC` — set on `agent exec`'s runner child env
 *     (agent-exec.ts), covering a coder-mode chat turn that has no org role
 *     of its own to set `MONOMIND_ORG_ROLE`.
 *
 *  Other CLIs (a human's own session of one running `monomind org …`).
 *  Found in each installed CLI's own code (2026-09-29) unless marked:
 *   - `AI_AGENT` — the cross-vendor convention (pi sets `pi`, crush `crush`,
 *     Claude Code its own id); `AGENT` — opencode `1`, crush `crush`.
 *   - codex 0.156: `CODEX_SANDBOX`, `CODEX_SANDBOX_NETWORK_DISABLED`,
 *     `CODEX_THREAD_ID`, `CODEX_CI` on the commands it runs.
 *   - opencode 1.18: `OPENCODE`, `OPENCODE_PID` on its own process env.
 *   - antigravity (agy 1.2): `ANTIGRAVITY_AGENT=1`; gemini CLI:
 *     `GEMINI_CLI` (std-env's agent table — not installed here).
 *   - grok 1.0: `GROK_SESSION_ID` (hook and MCP processes),
 *     `GROK_MANAGED_BY_NPM` (its npm launcher).
 *   - copilot 1.0.88: `COPILOT_CLI_BINARY_VERSION` (set by its loader),
 *     `COPILOT_AGENT_SESSION_ID` (GitHub's hosted coding agent).
 *   - crush 0.96: `CRUSH=1`; pi 0.87: `PI_CODING_AGENT=true`.
 *   - qwen: `QWEN_CODE` (its gemini-CLI fork's shell marker — not installed
 *     here, unverified). kimi: none found (not installed here).
 *   - pi 0.87 also sets `PI_SESSION_ID` inside its bash tools.
 *   - dsh 0.1.7: `DSH_SHELL=1`, `DSH_SESSION_ID` on the commands it runs
 *     (not `DSH_HOME`/`DSH_PROFILE`, which a human may export themselves).
 *   - cline 3.0 and aider export none of their own: monomind's runners set
 *     `MONOMIND_CLINE_TURN` (on cline, its hub daemon and every command they
 *     run) and `MONOMIND_AIDER=1` (plus `AI_AGENT=aider`). */
export const AGENT_CONTEXT_ENV_MARKERS = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'MONOMIND_ORG_ROLE',
  'MONOMIND_SDK_AGENT',
  'MONOMIND_AGENT_EXEC',
  'AI_AGENT',
  'AGENT',
  'CODEX_SANDBOX',
  'CODEX_SANDBOX_NETWORK_DISABLED',
  'CODEX_THREAD_ID',
  'CODEX_CI',
  'OPENCODE',
  'OPENCODE_PID',
  'ANTIGRAVITY_AGENT',
  'GEMINI_CLI',
  'GROK_SESSION_ID',
  'GROK_MANAGED_BY_NPM',
  'COPILOT_CLI_BINARY_VERSION',
  'COPILOT_AGENT_SESSION_ID',
  'CRUSH',
  'PI_CODING_AGENT',
  'QWEN_CODE',
  'PI_SESSION_ID',
  'DSH_SHELL',
  'DSH_SESSION_ID',
  'MONOMIND_CLINE_TURN',
  'MONOMIND_AIDER',
] as const;

/** The first agent-context marker found set in `env`, or `undefined` when
 *  none are — i.e. this looks like a human's own terminal. */
export function detectAgentContextMarker(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return AGENT_CONTEXT_ENV_MARKERS.find((k) => !!env[k]);
}
