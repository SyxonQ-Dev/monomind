/**
 * CLAUDE.md section generators: behavioral rules, coding principles, layout,
 * architecture and swarm/concurrency/execution rules.
 */

import { MONOSWARM_AUTOPILOT_REMOVAL_VERSION } from '../deprecations.js';
import { detectStackConventions } from './claudemd-detect.js';
import type { InitOptions } from './types.js';

// i-035: `monoswarm_init` writes a JSON state record and starts no process —
// nothing links its state to Claude Code's Task agents. The templates used to
// tell every project it "MUST initialize the monoswarm" before complex work;
// this is the honest replacement, worded from the same disclosure this repo
// already carries at .claude/agents/core/coordinator.md:105 and
// packages/@monomind/cli/CLAUDE.md's `adaptive`/`hybrid` topology annotation.
export const HONEST_MONOSWARM_SENTENCE =
  "Monoswarm records topology, roster and votes in a state file; it starts no process, and Claude Code's Task-tool agents do the work.";

// #418: monoswarm and autopilot are deprecated and removed in the next minor
// release. Headings stay as they are (renaming one needs a
// RETIRED_GENERATED_HEADINGS entry); each monoswarm section carries this line.
export const MONOSWARM_DEPRECATED_LINE = `DEPRECATED: the \`monoswarm\` and \`autopilot\` CLI commands and \`monoswarm_*\`/\`autopilot_*\` MCP tools are removed in ${MONOSWARM_AUTOPILOT_REMOVAL_VERSION}. Don't initialize a monoswarm; spawn agents with Claude Code's Task tool, or run an org with \`monomind org run\`.`;

// --- Section Generators (each returns enforceable markdown) ---

export function behavioralRules(): string {
  return `## Behavioral Rules (Always Enforced)

- Do what has been asked; nothing more, nothing less
- NEVER create files unless they're absolutely necessary for achieving your goal
- ALWAYS prefer editing an existing file to creating a new one
- NEVER proactively create documentation files (*.md) or README files unless explicitly requested
- NEVER save working files, text/mds, or tests to the root folder
- Never continuously check status after spawning a swarm — wait for results
- ALWAYS read a file before editing it
- NEVER commit secrets, credentials, or .env files`;
}

export function codingPrinciples(): string {
  return `## Coding Principles

### Think Before Coding
- State assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### Simplicity First
- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

### Surgical Changes
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.
- Every changed line should trace directly to the user's request.

### Goal-Driven Execution
- Transform tasks into verifiable goals with success criteria.
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- For multi-step tasks, state a brief plan with verification steps.`;
}

export function fileOrganization(options: InitOptions): string {
  const { srcDir, testDir } = detectStackConventions(options.targetDir);
  const lines = ['- NEVER save to root folder — use the directories below'];
  if (srcDir) lines.push(`- Use \`/${srcDir}\` for source code files`);
  if (testDir) lines.push(`- Use \`/${testDir}\` for test files`);
  lines.push('- Use `/docs` for documentation and `/scripts` for utility scripts');
  return `## File Organization\n\n${lines.join('\n')}`;
}

// GH #412: the DDD / TDD-London / event-sourcing mandates and the
// topology/max-agents "Project Config" were imposed on every project whatever
// its architecture, and cost tokens on every request without changing what
// the model does in it.
export function projectArchitecture(): string {
  return `## Project Architecture

- Keep files under 500 lines
- Use typed interfaces for all public APIs`;
}

export function concurrencyRules(): string {
  return `## Concurrency: 1 MESSAGE = ALL RELATED OPERATIONS

- ALWAYS batch independent file reads/writes/edits and Bash commands in ONE message
- ALWAYS spawn ALL agents in ONE message with full instructions via Claude Code's Task tool`;
}

export function swarmOrchestration(): string {
  return `## Monoswarm Orchestration

- ${MONOSWARM_DEPRECATED_LINE}
- MUST spawn concurrent agents using Claude Code's Task tool
- ${HONEST_MONOSWARM_SENTENCE}`;
}

export function antiDriftConfig(): string {
  return `## Monoswarm Configuration & Anti-Drift

- ${MONOSWARM_DEPRECATED_LINE} Topology and consensus settings are recorded only and change no behaviour.
- ALWAYS use hierarchical topology for coding swarms
- Keep maxAgents at 6-8 for tight coordination
- Use specialized strategy for clear role boundaries
- Use \`majority\` consensus for monoswarm
- Run frequent checkpoints via \`post-task\` hooks
- Keep shared memory namespace for all agents`;
}

export function autoStartProtocol(): string {
  return `## Monoswarm Protocols & Routing

- ${MONOSWARM_DEPRECATED_LINE}

### Auto-Start Monoswarm Protocol

When the user requests a complex task, spawn agents in background and WAIT:

\`\`\`javascript
// STEP 1: Spawn ALL agents IN BACKGROUND in a SINGLE message
Task({prompt: "Research requirements...", subagent_type: "researcher", run_in_background: true})
Task({prompt: "Design architecture...", subagent_type: "system-architect", run_in_background: true})
Task({prompt: "Implement solution...", subagent_type: "coder", run_in_background: true})
Task({prompt: "Write tests...", subagent_type: "tester", run_in_background: true})
Task({prompt: "Review code quality...", subagent_type: "reviewer", run_in_background: true})
\`\`\`

### Agent Routing

Pick agents per task with the \`[PICK]\` line or \`mcp__monomind__pick\` (CLI: \`monomind pick\`). When
neither answers, these real agents are safe defaults:

| Code | Task | Agents |
|------|------|--------|
| 1 | Bug Fix | coordinator, researcher, coder, tester |
| 3 | Feature | coordinator, system-architect, coder, tester, reviewer |
| 5 | Refactor | coordinator, system-architect, coder, reviewer |
| 7 | Performance | coordinator, Performance Benchmarker, coder |
| 9 | Security | coordinator, Security Engineer, reviewer |`;
}

export function executionRules(): string {
  return `## Monoswarm Execution Rules

- ${MONOSWARM_DEPRECATED_LINE}
- ALWAYS use \`run_in_background: true\` for all agent Task calls
- ALWAYS put ALL agent Task calls in ONE message for parallel execution
- After spawning, STOP — do NOT add more tool calls or check status
- Never poll TaskOutput or check monoswarm status — trust agents to return
- When agent results arrive, review ALL results before proceeding`;
}
