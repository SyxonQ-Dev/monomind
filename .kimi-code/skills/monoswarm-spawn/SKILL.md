---
name: monoswarm-spawn
description: Deprecated, removed in 2.22.0 — Write worker agent records into the agent store and register their ids on the monoswarm state file (combines `agent_spawn` + `monoswarm_join`).
type: flow
---

# monoswarm spawn

> **Deprecated ([#418](https://github.com/monoes/monomind/issues/418)):** `monoswarm` — the `monomind monoswarm` CLI command and the `monoswarm_*` MCP tools — records state and starts no agents, and is removed in monomind 2.22.0. Skip its steps: spawn agents with Claude Code's Task tool, or run an org with `monomind org run`.

Write worker agent records into the agent store and register their ids on
the monoswarm state file (combines `agent_spawn` + `monoswarm_join`).

There is no `spawn` subcommand of `monomind monoswarm`, and no `--claude`
flag that launches Claude Code as a lead process — this tool creates
bookkeeping entries only. No process, thread, or agent is started; real
concurrency comes from Claude Code's Task tool.

## MCP Tool

```javascript
mcp__monomind__monoswarm_agent_add({
  count: 5,
  role: "specialist",
  agentType: "coder",
  prefix: "monoswarm-worker"
})
```

## Parameters

| Param | Type | Default | Description |
|---|---|---|---|
| `count` | number | `1` | Number of workers to add (capped at 20 per call) |
| `role` | string | `worker` | Worker role: `worker`, `specialist`, `scout` |
| `agentType` | string | `worker` | Agent type for spawned workers (matches agent registry types) |
| `prefix` | string | `monoswarm-worker` | Prefix for generated worker IDs |

## Examples

```javascript
// Add 5 default workers
mcp__monomind__monoswarm_agent_add({ count: 5 })

// Add 3 specialists
mcp__monomind__monoswarm_agent_add({ count: 3, role: "specialist" })

// Add a coder-type worker with a custom ID prefix
mcp__monomind__monoswarm_agent_add({ agentType: "coder", prefix: "my-coder" })
```

Requires the run to already be initialized via `monoswarm_init` — the
handler returns `{ success: false }` otherwise.
