---
name: hooks:README
---

# Hooks Commands

Lifecycle hooks that log edits, outcomes and trajectories to local pattern files and pick agents. No model is trained. Invoked as `npx monomind hooks <subcommand>`.

## Commands (invoke as slash commands)

- [overview](./overview.md) — hooks system overview, Claude Code integration, settings.json config
- [setup](./setup.md) — how to configure hooks in settings.json
- [pre-edit](./pre-edit.md) — get context and agent suggestions before editing a file
- [post-edit](./post-edit.md) — record an edit outcome in the local feedback log
- [pre-task](./pre-task.md) — register task start, get agent suggestions and model routing
- [post-task](./post-task.md) — record a task outcome against its routed agent
- [session-end](./session-end.md) — end session and persist state

## All Real Subcommands (<!-- doc-count:hooks-subcommands -->28<!-- /doc-count:hooks-subcommands -->, including 4 deprecated aliases)

```
pre-edit          Get context and agent suggestions before editing a file
post-edit         Record an edit outcome in the local feedback log
pre-command       Assess risk before executing a command
post-command      Record command execution outcome
pre-task          Register task start and get agent suggestions + model routing
post-task         Record a task outcome against its routed agent
session-end       End current session and persist state
session-restore   Restore a previous session
route             Route task to an agent through the central picker
explain           Explain routing decision with transparency
pretrain          Consolidate hook activity into JSON state (no model is trained)
metrics           View recorded routing/outcome metrics
transfer          Copy recorded patterns from another local project
list              List all registered hooks
intelligence      JS pattern/trajectory store (train, patterns, predict, optimize, export, import)
notify            Send notification with level and message
worker            Background worker management (run in-process)
statusline        Generate dynamic statusline for Claude Code display
coverage-route    Route tasks based on test coverage gaps
coverage-suggest  Suggest coverage improvements for a path
coverage-gaps     List all coverage gaps with priorities
model-route       Route to optimal model (haiku/sonnet/opus)
model-outcome     Record model routing outcome
model-stats       View model routing statistics
route-task        Deprecated alias of route
session-start     Deprecated alias of session-restore
pre-bash          Alias of pre-command
post-bash         Alias of post-command
```

Worker subcommands (<!-- doc-count:workers -->9<!-- /doc-count:workers --> background workers):

```
worker list       List all background workers
worker run <name> Run one worker once, in-process
```

## Real MCP Tools

- `mcp__monomind__hooks_pre-edit` / `hooks_post-edit`
- `mcp__monomind__hooks_pre-command` / `hooks_post-command`
- `mcp__monomind__hooks_pre-task` / `hooks_post-task`
- `mcp__monomind__hooks_session-end` / `hooks_session-restore`
- `mcp__monomind__hooks_route` / `hooks_explain`
- `mcp__monomind__hooks_pretrain`
- `mcp__monomind__hooks_metrics` / `hooks_transfer`
- `mcp__monomind__hooks_intelligence`
