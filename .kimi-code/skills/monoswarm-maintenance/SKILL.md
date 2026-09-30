---
name: monoswarm-maintenance
description: Deprecated, removed in 2.22.0 — Maintenance swarm strategy — sequential coordinated system maintenance for dependency updates, security audits, and documentation
type: flow
---

# Maintenance Swarm Strategy

> **Deprecated ([#418](https://github.com/monoes/monomind/issues/418)):** `monoswarm` — the `monomind monoswarm` CLI command and the `monoswarm_*` MCP tools — records state and starts no agents, and is removed in monomind 2.22.0. Skip its steps: spawn agents with Claude Code's Task tool, or run an org with `monomind org run`.

System maintenance and updates through coordinated agents.

## How to Invoke

```
Skill("monoswarm:maintenance")
```

Then describe the maintenance task:
> "Run a maintenance swarm to update all dependencies safely."
> "Start a maintenance swarm for the monthly security audit."

---

## Swarm Setup

```javascript
// Initialize maintenance swarm
mcp__monomind__monoswarm_init({
  topology: "star",
  maxAgents: 5,
  strategy: "sequential"
})

// Coordinate maintenance
mcp__monomind__task_create({
  description: "update dependencies",
  strategy: "sequential"
})
```

```bash
# CLI equivalent
npx monomind monoswarm init --topology star --max-agents 5
npx monomind monoswarm start "update dependencies" --strategy maintenance
```

## Agent Roles

```javascript
mcp__monomind__agent_spawn({ type: "analyst", capabilities: ["dependency-analysis", "version-management"] })
mcp__monomind__agent_spawn({ type: "tester", capabilities: ["testing", "validation"] })
mcp__monomind__agent_spawn({ type: "documenter", capabilities: ["documentation", "changelog"] })
```

## Maintenance Sequence

Star topology runs sequentially — each agent completes before the next starts:

1. **Analyzer agent** — audit outdated dependencies, find vulnerabilities
2. **Tester agent** — verify tests pass on current state (baseline)
3. **Analyst agent** — apply updates, verify no regressions
4. **Tester agent** — rerun tests to confirm updates are safe
5. **Documenter agent** — update CHANGELOG, document what changed

## Security Scanning

```bash
npx monomind@latest security scan
```

## Monitoring

```javascript
mcp__monomind__monoswarm_status({ swarmId: "current" })
mcp__monomind__system_health({})
```
