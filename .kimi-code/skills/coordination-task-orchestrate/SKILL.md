---
name: coordination-task-orchestrate
description: Deprecated, removed in 2.22.0 — Coordinate tasks across a swarm of agents.
type: flow
---

# task-orchestrate

> **Deprecated ([#418](https://github.com/monoes/monomind/issues/418)):** `monoswarm` — the `monomind monoswarm` CLI command and the `monoswarm_*` MCP tools — records state and starts no agents, and is removed in monomind 2.22.0. Skip its steps: spawn agents with Claude Code's Task tool, or run an org with `monomind org run`.

Coordinate tasks across a swarm of agents.

## Usage

```bash
npx monomind monoswarm init [options]
```

## Options

- `--task <description>` - Task to distribute across agents
- `--agents <list>` - Comma-separated agent IDs or types
- `--strategy <type>` - Coordination strategy: `parallel`, `sequential`, `pipeline`, `broadcast`
- `--timeout <seconds>` - Max time to wait for completion

## Examples

### Coordinate in parallel (default)

```bash
npx monomind monoswarm init --task "Run all tests" --strategy parallel
```

### Sequential pipeline

```bash
npx monomind monoswarm init --task "Build, test, and deploy" --strategy pipeline
```

### Broadcast to all agents

```bash
npx monomind monoswarm init --task "Update shared context" --strategy broadcast
```

## Task Lifecycle (separate from orchestration)

Use `monomind task` subcommands for individual task management:

```bash
npx monomind task create --title "Fix auth bug" --priority high
npx monomind task list --status pending
npx monomind task status --id <task-id>
npx monomind task assign --id <task-id> --agent <agent-id>
npx monomind task cancel --id <task-id>
```

## Strategies

| Strategy | Description |
|----------|-------------|
| `parallel` | All agents work simultaneously (default) |
| `sequential` | Agents execute one after another |
| `pipeline` | Output of one agent feeds the next |
| `broadcast` | Same task sent to all agents |

## Integration with Claude Code

```javascript
mcp__monomind__task_create({
  description: "Implement user authentication",
  agents: ["architect", "coder", "tester"],
  strategy: "sequential",
  timeout: 300
})
```

## See Also

- `swarm-init` — initialize the swarm before orchestrating
- `agent-spawn` — create agents to orchestrate tasks across
- `swarm status` — check current swarm state (`monomind monoswarm status`)
