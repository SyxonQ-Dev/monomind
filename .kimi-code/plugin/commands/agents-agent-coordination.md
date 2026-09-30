---
name: agents:agent-coordination
description: Coordination patterns for multi-agent collaboration.
---

# agent-coordination

> **Deprecated ([#418](https://github.com/monoes/monomind/issues/418)):** `monoswarm` — the `monomind monoswarm` CLI command and the `monoswarm_*` MCP tools — records state and starts no agents, and is removed in monomind 2.22.0. Skip its steps: spawn agents with Claude Code's Task tool, or run an org with `monomind org run`.

Coordination patterns for multi-agent collaboration.

## Coordination Patterns

### Hierarchical
Queen-led with worker specialization
```bash
npx monomind monoswarm init --topology hierarchical
```

### Mesh
Peer-to-peer collaboration
```bash
npx monomind monoswarm init --topology mesh
```

### Adaptive
Dynamic topology based on workload
```bash
npx monomind monoswarm init --topology adaptive
```

## Best Practices
- Use hierarchical for complex projects
- Use mesh for research tasks
- Use adaptive for unknown workloads
