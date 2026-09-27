/**
 * CLAUDE.md section generators: CLI/agent/hooks/memory reference, build and
 * test, security, performance, intelligence, second brain, monograph and
 * setup sections.
 */

import { agentCommand } from '../commands/agent.js';
import { hooksCommand } from '../commands/hooks.js';
import { initCommand } from '../commands/init.js';
import { memoryCommand } from '../commands/memory.js';
import { monoswarmCommand } from '../commands/monoswarm.js';
import { sessionCommand } from '../commands/session.js';
import { taskCommand } from '../commands/task.js';
import { mcpAddHint } from '../platform-adapters/renderers/mcp.js';
import {
  detectOptionalPackages,
  detectStackConventions,
  unavailNote,
  workerCountLabel,
} from './claudemd-detect.js';
import { WORKER_COUNT, WORKER_ROWS } from './generated-counts.js';
import { subcommandCount, workerTableRows } from './shared.js';
import type { InitOptions } from './types.js';

export function cliCommandsTable(): string {
  const avail = detectOptionalPackages();
  return `## CLI Commands

### Core Commands

| Command | Subcommands | Description |
|---------|-------------|-------------|
| \`init\` | ${subcommandCount(initCommand)} | Project initialization |
| \`agent\` | ${subcommandCount(agentCommand)} | Agent lifecycle management |
| \`monoswarm\` | ${subcommandCount(monoswarmCommand)} | Multi-agent coordination |
| \`memory\` | ${subcommandCount(memoryCommand)} | SQLite memory with ANN search |
| \`task\` | ${subcommandCount(taskCommand)} | Task creation and lifecycle |
| \`session\` | ${subcommandCount(sessionCommand)} | Session state management |
| \`hooks\` | ${subcommandCount(hooksCommand)} | Self-learning hooks + ${workerCountLabel(avail.hooks)}background workers${unavailNote(avail.hooks)} |

> Note: there is no \`neural\` CLI command. Neural pattern learning was merged
> into \`hooks intelligence\`. See \`doc/concepts/monoswarm.md\` for monoswarm
> coordination and vote strategies.

### Quick CLI Examples

\`\`\`bash
npx monomind init wizard
npx monomind agent spawn -t coder --name my-coder
npx monomind monoswarm init --v1-mode
npx monomind memory search --query "authentication patterns"
npx monomind doctor --fix
\`\`\``;
}

export function agentPicking(): string {
  return `## Agent & Skill Picking

- When a prompt carries a \`[PICK]\` line (\`[PICK] agent: <name> · skill: <invoke>\`), use that agent/skill unless it is clearly wrong for the task.
- Before choosing a subagent yourself, call \`mcp__monomind__pick\` if that tool is available (\`{ task, kind: "agents" }\`) and use a returned \`name\` as \`subagent_type\`. Otherwise (no MCP, or an older server without it) run \`monomind pick -t "<task>" --json\`, or \`npx -y monomind pick -t "<task>" --json\` when \`monomind\` is not installed.
- A skill's \`invoke\`: a platform skill (\`Skill("<name>")\` or \`/command\`) loads with the Skill tool; an Org skill (\`source: "org"\`, invoke \`mcp__monomind__org_skill_show {"name":"<name>"}\`) is read by calling that MCP tool with that input, or with \`npx -y monomind org skills show <name>\` when the tool is unavailable.
- \`pick\` results carry \`confident\`; when it is false, nothing fits well enough — pick yourself or proceed without a specialist.
- Never invent agent names — a \`subagent_type\` that is not installed fails at spawn time.`;
}

export function agentTypes(): string {
  return `## Available Agents (Curated Subset)

The full roster ships as \`.claude/agents/**/*.md\` — this is a hand-picked
fallback subset for when picking (see above) returns nothing; it is not the
complete set.

### Core Development
\`coder\`, \`reviewer\`, \`tester\`, \`planner\`, \`researcher\`

### Specialized
\`Security Engineer\`

### Monoswarm Coordination
\`mesh-coordinator\`

### GitHub & Repository
\`pr-manager\`, \`monoswarm-code-review\`, \`issue-tracker\`, \`release-manager\``;
}

export function hooksSystem(): string {
  const avail = detectOptionalPackages();
  const workerHeading = avail.hooks ? ` + ${WORKER_COUNT} Background Workers` : '';
  return `## Hooks System (${subcommandCount(hooksCommand)} Hook Subcommands${workerHeading})

### Essential Hooks

| Hook | Description |
|------|-------------|
| \`pre-task\` / \`post-task\` | Task lifecycle with learning |
| \`pre-edit\` / \`post-edit\` | File editing with pattern logging |
| \`session-restore\` / \`session-end\` | Session state persistence |
| \`route\` | Route task to optimal agent |
| \`intelligence\` | Pattern-learning intelligence system |
| \`worker\` | Background worker management |

### Background Workers (@monoes/hooks, run in-process)${unavailNote(avail.hooks)}

| Worker | Priority | Description |
|--------|----------|-------------|
${workerTableRows(WORKER_ROWS)}

Metrics-producing workers refresh at session start when output is >6h old.
${avail.hooks ? '' : '\n> \\@monoes/hooks is not resolvable in this install — background workers will fail to load (see `hooks worker list`). This is an install/publish gap, not a project misconfiguration.\n'}
\`\`\`bash
npx monomind hooks pre-task --description "[task]"
npx monomind hooks post-task --task-id "[id]" --success true
npx monomind hooks worker run audit
\`\`\``;
}

export function learningProtocol(): string {
  return `## Auto-Learning Protocol

### Before Starting Any Task
\`\`\`bash
npx monomind memory search --query "[task keywords]" --namespace patterns
npx monomind hooks route --task "[task description]"
\`\`\`

### After Completing Any Task Successfully
\`\`\`bash
npx monomind memory store --namespace patterns --key "[pattern-name]" --value "[what worked]"
npx monomind hooks post-task --task-id "[id]" --success true --store-results true
\`\`\`

- ALWAYS check memory before starting new features, debugging, or refactoring
- ALWAYS store patterns in memory after solving bugs, completing features, or finding optimizations`;
}

export function memoryCommands(): string {
  return `## Memory Commands

\`\`\`bash
npx monomind memory store --key "pattern-auth" --value "JWT with refresh" --namespace patterns
npx monomind memory search --query "authentication patterns"
\`\`\`

Full command reference: \`npx monomind memory --help\``;
}

export function securityRulesLight(): string {
  return `## Security Rules

- NEVER hardcode API keys, secrets, or credentials in source files
- NEVER commit .env files or any file containing secrets
- Always validate user input at system boundaries
- Always sanitize file paths to prevent directory traversal
- Run \`npx monomind security scan\` after security-related changes`;
}

export function buildAndTest(options: InitOptions): string {
  const { build, test, lint } = detectStackConventions(options.targetDir);
  const commands = [
    ...(build ? ['# Build', build, ''] : []),
    '# Test',
    test,
    '',
    '# Lint',
    lint,
  ].join('\n');
  return `## Build & Test

\`\`\`bash
${commands}
\`\`\`

- ALWAYS run tests after making code changes
- ALWAYS verify build succeeds before committing`;
}

export function securitySection(): string {
  return `## Security Protocol

- NEVER hardcode API keys, secrets, or credentials in source files
- NEVER commit .env files or any file containing secrets
- Always validate all user input at system boundaries using Zod schemas
- Always sanitize file paths to prevent directory traversal attacks
- Always use parameterized queries — never concatenate SQL strings
- Run security audit after any authentication or authorization changes

### Security Scanning
\`\`\`bash
npx monomind security scan --depth full
npx monomind security audit --report
npx monomind security cve --check
\`\`\`

### Security Agents
- \`Security Engineer\` — threat modeling, secure code and architecture review
- Use agent routing code 9 (hierarchical/specialized) for security tasks`;
}

export function performanceSection(): string {
  return `## Performance Optimization Protocol

- Always run benchmarks before and after performance changes
- Always profile before optimizing — never guess at bottlenecks
- Prefer algorithmic improvements over micro-optimizations
- Prefer indexed (HNSW) vector search over brute-force scans for pattern lookup
- Keep memory reduction within 50-75% target with quantization

### Performance Tooling
\`\`\`bash
npx monomind performance benchmark --suite all
npx monomind performance profile --target "[component]"
npx monomind performance metrics --format table
\`\`\`

### Performance Agents
- \`Performance Benchmarker\` — bottleneck detection, benchmarking, analysis
- Use agent routing code 7 (hierarchical/specialized) for performance tasks`;
}

export function intelligenceSystem(): string {
  return `## Intelligence System

- **Keyword routing**: Deterministic task→agent routing via \`createKeywordRouter\`
- **Outcome measurement**: Route and command outcomes are recorded and scored to surface routing accuracy over time
- **Pattern search**: SQLite-backed ANN vector search for finding similar past patterns

Routing and learning are JS-only — no native engine is required. Outcomes
feed back into the recorded metrics so routing quality is measured, not assumed.`;
}

export function secondBrainSection(): string {
  return `## Second Brain — Document Knowledge Base

If the \`documents\` capability is active (check \`.monomind/capabilities.json\`), this project indexes documents (Office, PDF, plain text, and more) into a semantic search engine.

**When documents are indexed, search knowledge before answering questions about business, compliance, legal, or organizational topics:**
- Call \`mcp__monomind__knowledge_search\` with a relevant query (add \`store: "project"\` or \`"global"\` to search one brain only; default merges both)
- Use the returned excerpts as grounding context for your answer
- Cite the source document name when referencing specific information
- Add with \`mcp__monomind__knowledge_ingest\`; retract a wrong or stale document with \`mcp__monomind__knowledge_remove\` (hides it from search immediately, reversible by re-ingesting)

**Global brain:** the user has a personal cross-project knowledge store at \`~/.monomind/global-brain\`. All searches (knowledge_search, doc search, per-prompt injection) automatically merge it with project knowledge — project results win ties, global hits are labeled \`[global]\`. Cite the label so the user knows which brain answered.

**Re-indexing** happens automatically on session start (unchanged files are skipped via content hash).`;
}

export function monographSection(): string {
  return `## Knowledge Graph — Monograph (Use Before Codebase Exploration)

Built into monomind — no separate install. Pure TypeScript, parses TS/JS/Python/Go/Rust/C/C++/Java/Ruby/Swift into a SQLite graph with BM25 full-text search.

### MANDATORY: Graph-First, Grep-Last

**Before ANY grep/rg/find via Bash for code navigation:**
1. Call \`mcp__monomind__monograph_query\` first — returns file path + line number
2. Only fall back to Bash grep if monograph returns 0 results or reports DB missing

**When starting any task touching 3+ files:**
1. \`mcp__monomind__monograph_suggest\` — relevant nodes ranked by task description
2. \`mcp__monomind__monograph_context\` — 360° view of a symbol (callers, callees, imports)
3. \`mcp__monomind__monograph_impact\` — blast radius before changing anything

**If graph is empty:** call \`mcp__monomind__monograph_build\` (runs in background; proceed with grep while it builds).

Core tools (prefix: \`mcp__monomind__\`): \`monograph_build\`, \`monograph_query\`, \`monograph_suggest\`, \`monograph_impact\` — the full tool list self-describes via MCP.

### Skip monograph for
Single-file edits, doc/config changes, quick fixes where you already know the exact file.`;
}

export function setupAndBoundary(): string {
  return `## Quick Setup

\`\`\`bash
# Add MCP server — includes monograph, monoswarm, memory, hooks, all 66+ tools
${mcpAddHint()}

# Verify everything works
npx monomind doctor --fix
\`\`\`

> **Package name changed:** Use \`monomind\` (not \`@monomind/cli@latest\` which is the old name and returns 404).

## Claude Code vs CLI Tools

- Claude Code's Task tool handles ALL execution: agents, file ops, code generation, git
- CLI tools handle coordination via Bash: monoswarm init, memory, hooks, routing
- NEVER use CLI tools as a substitute for Task tool agents

## Support

- Documentation: https://github.com/monoes/monomind
- Issues: https://github.com/monoes/monomind/issues`;
}
