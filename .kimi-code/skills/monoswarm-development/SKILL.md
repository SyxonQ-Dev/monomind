---
name: monoswarm-development
description: Deprecated, removed in 2.21.0 — Development swarm strategy — hierarchical team coordination for building features with architect → coder → tester flow
type: flow
---

# Development Swarm Strategy

> **Deprecated ([#418](https://github.com/monoes/monomind/issues/418)):** `monoswarm` — the `monomind monoswarm` CLI command and the `monoswarm_*` MCP tools — records state and starts no agents, and is removed in monomind 2.21.0. Skip its steps: spawn agents with Claude Code's Task tool, or run an org with `monomind org run`.

Coordinated development through specialized agent teams.

## How to Invoke

```
Skill("monoswarm:development")
```

Then describe the feature to build:
> "Start a development swarm to build OAuth2 authentication."
> "Coordinate agents to implement the payment processing module."

---

## Swarm Setup

```javascript
// Initialize development swarm
mcp__monomind__monoswarm_init({
  topology: "hierarchical",
  maxAgents: 8,
  strategy: "specialized"
})

// Coordinate development
mcp__monomind__task_create({
  description: "build feature X",
  strategy: "parallel"
})
```

```bash
# CLI equivalent
npx monomind monoswarm init --topology hierarchical --max-agents 8 --strategy specialized
npx monomind monoswarm start "build feature X" --strategy development --parallel
```

## Agent Roles

```javascript
mcp__monomind__agent_spawn({ type: "architect", capabilities: ["system-design", "api-design"] })
mcp__monomind__agent_spawn({ type: "coder", capabilities: ["react", "typescript", "ui"] })
mcp__monomind__agent_spawn({ type: "coder", capabilities: ["nodejs", "api", "database"] })
mcp__monomind__agent_spawn({ type: "tester", capabilities: ["integration", "e2e", "api-testing"] })
```

## Best Practices

- Use hierarchical topology for large features (architect leads, coders implement, tester validates)
- Enable parallel execution for independent modules
- Run tester agent concurrently on completed units rather than waiting for all code

## Monitoring

```javascript
// Check swarm status
mcp__monomind__monoswarm_status({ swarmId: "current" })

// System health
mcp__monomind__system_health({})
```

```bash
npx monomind monoswarm status
```
