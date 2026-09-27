// packages/@monomind/cli/src/orgrt/agent-runner.ts
/**
 * AgentRunner — provider-agnostic execution surface for Org Runtime v2.
 *
 * Why this exists: session.ts used to import `query`, `tool`, and
 * `createSdkMcpServer` directly from `@anthropic-ai/claude-agent-sdk`, which
 * hard-coupled the entire org runtime to Claude. This interface lets session.ts
 * describe WHAT to run (an agent with a set of org tools, a system prompt, and
 * a mailbox prompt stream) without knowing WHICH SDK executes it.
 *
 * Behavior preservation (the invariant the Claude path must not break):
 * ClaudeAgentRunner is a faithful, line-for-line extraction of the previous
 * inline logic in session.ts's runOneSession — same options object, same
 * message normalization, same queryFn injection seam that test-loop.ts relies
 * on. The default runner is ClaudeAgentRunner, so an org that doesn't ask for
 * opencode executes through exactly the same code path it always did.
 */

export { ClaudeAgentRunner, defaultClaudeRunner } from './agent-runner-claude.js';
export type { AgentMessage, AgentRunArgs, AgentRunner, OrgToolDef } from './agent-runner-types.js';
export { killOnAbort } from './agent-runner-types.js';
