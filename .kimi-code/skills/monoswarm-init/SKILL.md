---
name: monoswarm-init
description: Deprecated, removed in 2.21.0 — Initialize a monoswarm run with topology and (optionally) vote-strategy settings.
type: flow
---

# monoswarm init

> **Deprecated ([#418](https://github.com/monoes/monomind/issues/418)):** `monoswarm` — the `monomind monoswarm` CLI command and the `monoswarm_*` MCP tools — records state and starts no agents, and is removed in monomind 2.21.0. Skip its steps: spawn agents with Claude Code's Task tool, or run an org with `monomind org run`.

Initialize a monoswarm run with topology and (optionally) vote-strategy settings.

There is no `npx monomind monoswarm init` CLI command for the vote/consensus
side — that part is invoked directly as an MCP tool call. For plain agent
coordination without voting, use `npx monomind monoswarm init` (see `monoswarm.md`).

```javascript
mcp__monomind__monoswarm_init({
  topology: "hierarchical",
  voteStrategy: "supermajority",
  maxAgents: 15,
  persist: true,
  memoryBackend: "hybrid"
})
```

## Parameters

| Param | Type | Default | Description |
|---|---|---|---|
| `topology` | string | `mesh` | `mesh`, `hierarchical`, `ring`, `star` |
| `voteStrategy` | string | `supermajority` | `majority`, `supermajority`, `unanimous`, `threshold` |
| `maxAgents` | number | `15` | Maximum number of agents (bookkeeping only, not enforced by a scheduler) |
| `persist` | boolean | `true` | Whether to persist state to disk |
| `memoryBackend` | string | `hybrid` | Label stored with the config — not validated against a real backend list |
| `leadId` | string | `lead-<timestamp>` | Initial lead/coordinator agent ID |

`gossip` and `crdt` are **not implemented** as vote strategies — passing
either is rejected with an error listing the supported set.

## Examples

```javascript
// Initialize with recommended settings
mcp__monomind__monoswarm_init({})

// Hierarchical topology with a supermajority vote bar
mcp__monomind__monoswarm_init({ topology: "hierarchical", voteStrategy: "supermajority" })

// Larger run with a plain majority vote bar
mcp__monomind__monoswarm_init({ topology: "mesh", voteStrategy: "majority", maxAgents: 20 })

// Minimal run with no persistence
mcp__monomind__monoswarm_init({ topology: "hierarchical", voteStrategy: "majority", persist: false })
```

## Topology Guide

- **`hierarchical`** — Lead controls workers directly. Best for small teams (< 8 agents). Prevents drift.
- **`mesh`** — Fully connected peers. Best when all agents are equals.
- **`ring`** — Circular communication pattern.
- **`star`** — Central coordinator with spokes.

## Vote Strategy Guide

- **`supermajority`** — Requires 2f+1 votes. Tolerates f < n/3 dissenting voters. Default.
- **`majority`** — Simple majority. Tolerates f < n/2.
- **`unanimous`** — Rejects on the first dissenting vote.
- **`threshold`** — Caller-supplied vote count or fraction.

These are vote-threshold implementations over one JSON state file — see
`doc/concepts/monoswarm.md` for how the mechanism works.
