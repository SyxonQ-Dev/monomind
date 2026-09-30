---
name: swarm-analysis
description: Deprecated, removed in 2.22.0 — Analysis swarm strategy — distributed codebase, performance, and security analysis through coordinated mesh agents
---

# Analysis Swarm Strategy

> **Deprecated ([#418](https://github.com/monoes/monomind/issues/418)):** `monoswarm` — the `monomind monoswarm` CLI command and the `monoswarm_*` MCP tools — records state and starts no agents, and is removed in monomind 2.22.0. Skip its steps: spawn agents with Claude Code's Task tool, or run an org with `monomind org run`.

Comprehensive analysis through distributed agent coordination.

## How to Invoke

```
Skill("monoswarm:analysis")
```

Then describe what to analyze:
> "Run an analysis swarm on the src/ directory."
> "Analyze API performance bottlenecks across all services."

---

## Swarm Setup

```javascript
// Initialize analysis swarm
mcp__monomind__monoswarm_init({
  topology: "mesh",
  maxAgents: 6,
  strategy: "adaptive"
})

// Coordinate analysis
mcp__monomind__task_create({
  description: "analyze system performance",
  strategy: "parallel"
})
```

```bash
# CLI equivalent
npx monomind monoswarm init --topology mesh --max-agents 6
npx monomind monoswarm start "analyze system performance" --strategy analysis --parallel
```

## Agent Roles

```javascript
mcp__monomind__agent_spawn({ type: "analyst", capabilities: ["metrics", "logging", "monitoring"] })
mcp__monomind__agent_spawn({ type: "analyst", capabilities: ["pattern-recognition", "anomaly-detection"] })
mcp__monomind__agent_spawn({ type: "documenter", capabilities: ["reporting", "visualization"] })
mcp__monomind__agent_spawn({ type: "coordinator", capabilities: ["synthesis", "correlation"] })
```

## Coordination Modes

| Mode | When to use |
|------|-------------|
| Mesh | Exploratory analysis — agents search in parallel |
| Hierarchical | Complex systems — coordinator aggregates sub-agent findings |
| Star | Sequential pipeline — each step depends on previous |

## Monitoring

```javascript
// Check analysis progress
mcp__monomind__monoswarm_status({ swarmId: "current" })

// Performance metrics
mcp__monomind__performance_report({ format: "detailed" })

// System health
mcp__monomind__system_health({})
```
