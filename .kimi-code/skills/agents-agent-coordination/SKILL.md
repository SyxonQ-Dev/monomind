---
name: agents-agent-coordination
description: Coordination patterns for multi-agent collaboration.
type: flow
---

# agent-coordination

Coordination patterns for multi-agent collaboration.

## Coordination Patterns

Agents run through Claude Code's Task tool; spawn independent agents in one
message so they run in parallel. For a standing team of roles, run an org with
`monomind org run <org>`.

### Hierarchical
A lead routes work to specialists and reconciles their results — use the
`coordinator` agent.

### Mesh
Equal peers work on independent slices and share state through memory — use
the `mesh-coordinator` agent.

## Best Practices
- Use hierarchical for complex projects
- Use mesh for research tasks
