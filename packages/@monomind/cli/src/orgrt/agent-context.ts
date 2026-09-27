// packages/@monomind/cli/src/orgrt/agent-context.ts
/**
 * #365 (integrator review): scoped chats/orgs already let an agent run
 * `monomind org …` through an allowed Bash prefix, so `org role set-access
 * ... full` must refuse outright when it detects it is running inside an
 * agent's own process tree — no flag, TTY, or confirmation can override
 * this (a human granting full access runs the command themselves, in their
 * own terminal, with none of these env vars set).
 */

/** Env vars set (by Claude Code itself, or by monomind) on any process tree
 *  spawned FOR an agent turn — a chat's Bash tool, `agent exec`'s runner
 *  child, or an org role's own session:
 *   - `CLAUDECODE` / `CLAUDE_CODE_ENTRYPOINT` — set by Claude Code on every
 *     process it spawns for a turn (interactive or headless).
 *   - `MONOMIND_ORG_ROLE` — set on an org role's session env
 *     (session-stream.ts).
 *   - `MONOMIND_SDK_AGENT` — set on a codex/kimicode/opencode hook-handler
 *     process spawned from inside an org role's own tool call (the init
 *     generators' hook bridges).
 *   - `MONOMIND_AGENT_EXEC` — set on `agent exec`'s runner child env
 *     (agent-exec.ts), covering a coder-mode chat turn that has no org role
 *     of its own to set `MONOMIND_ORG_ROLE`. */
const AGENT_CONTEXT_ENV_MARKERS = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'MONOMIND_ORG_ROLE',
  'MONOMIND_SDK_AGENT',
  'MONOMIND_AGENT_EXEC',
] as const;

/** The first agent-context marker found set in `env`, or `undefined` when
 *  none are — i.e. this looks like a human's own terminal. */
export function detectAgentContextMarker(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return AGENT_CONTEXT_ENV_MARKERS.find((k) => !!env[k]);
}
