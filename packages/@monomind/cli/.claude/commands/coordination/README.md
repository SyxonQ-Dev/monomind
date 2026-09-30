---
name: coordination:readme
---

# Coordination Commands

> **Deprecated ([#418](https://github.com/monoes/monomind/issues/418)):** `monoswarm` — the `monomind monoswarm` CLI command and the `monoswarm_*` MCP tools — records state and starts no agents, and is removed in monomind 2.22.0. Skip its steps: spawn agents with Claude Code's Task tool, or run an org with `monomind org run`.

Commands and guidance for swarm coordination and task orchestration in Monomind.

## Commands (invoke as slash commands)

- [swarm-init](./swarm-init.md) — initialize a swarm with topology and strategy (`monomind monoswarm init`)
- [agent-spawn](./agent-spawn.md) — spawn a new agent in the swarm (`monomind agent spawn`)
- [task-orchestrate](./task-orchestrate.md) — coordinate tasks across swarm agents (`monomind monoswarm init`)
