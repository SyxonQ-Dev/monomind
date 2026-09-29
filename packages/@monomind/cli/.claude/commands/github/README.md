---
name: github:README
---

# GitHub Commands

> **Deprecated ([#418](https://github.com/monoes/monomind/issues/418)):** `monoswarm` — the `monomind monoswarm` CLI command and the `monoswarm_*` MCP tools — records state and starts no agents, and is removed in monomind 2.21.0. Skip its steps: spawn agents with Claude Code's Task tool, or run an org with `monomind org run`.

Commands and guidance for GitHub workflow automation in Monomind. All GitHub operations use the `gh` CLI and real monomind MCP tools — the `monomind` CLI has no `github` command group.

## Commands (invoke as slash commands)

- [github-modes](./github-modes.md) — overview of all GitHub workflow modes and swarm integration patterns
- [issue-tracker](./issue-tracker.md) — issue management and project coordination with swarm agents
- [pr-manager](./pr-manager.md) — pull request lifecycle management with multi-agent review coordination
- [release-manager](./release-manager.md) — release preparation, versioning, and deployment pipeline coordination
- [repo-architect](./repo-architect.md) — repository structure optimization and template management
- [sync-coordinator](./sync-coordinator.md) — multi-package version alignment and cross-repo synchronization

## Real Tools Used

- `gh` CLI — all GitHub operations (issues, PRs, releases, repos, branches)
- `mcp__monomind__monoswarm_init` / `agent_spawn` — swarm coordination
- `mcp__monomind__task_create` — task tracking across agents
- `mcp__monomind__memory_pattern-store` / `memory_pattern-search` — cross-agent state persistence
- `gh` CLI — preferred for all direct GitHub API operations not covered by the above
