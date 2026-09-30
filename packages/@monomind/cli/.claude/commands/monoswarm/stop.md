---
name: monoswarm:stop
description: Deprecated, removed in 2.21.0 — Clear monoswarm workers from the shared agent store and reset run state.
---

# monoswarm shutdown

> **Deprecated ([#418](https://github.com/monoes/monomind/issues/418)):** `monoswarm` — the `monomind monoswarm` CLI command and the `monoswarm_*` MCP tools — records state and starts no agents, and is removed in monomind 2.21.0. Skip its steps: spawn agents with Claude Code's Task tool, or run an org with `monomind org run`.

Clear monoswarm workers from the shared agent store and reset run state.

```bash
npx monomind@latest monoswarm stop
```

Or, as a direct MCP tool call (needed to also clear vote/consensus state):

```javascript
mcp__monomind__monoswarm_shutdown({ graceful: true, force: false })
```

## Parameters

| Param | Type | Default | Description |
|---|---|---|---|
| `graceful` | boolean | `true` | If pending vote items exist, refuse to shut down unless `force: true` |
| `force` | boolean | `false` | Override the graceful refusal above |

There is no interactive confirmation prompt (this is a direct tool call, not
a CLI), and no `saveState` option — vote history is always kept, shared
memory is always cleared.

## Examples

```javascript
// Graceful shutdown — fails if there are pending vote items
mcp__monomind__monoswarm_shutdown({})

// Force shutdown even with pending vote items
mcp__monomind__monoswarm_shutdown({ force: true })
```

## Behavior

Removes all worker ids from the agent store, then resets run state:
`initialized: false`, no lead, empty worker list, cleared pending votes
and shared memory. Vote history is retained on the state file. The
response includes `workersTerminated`, `previousLead`, `votesCleared`,
and a summary `message`.
