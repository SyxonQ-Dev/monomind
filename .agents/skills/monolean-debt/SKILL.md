---
name: monolean-debt
description: "Collect every `monolean:` comment into a debt ledger so deliberate shortcuts and deferrals get tracked. Use for \"monolean debt\" or \"what did we defer\". Changes nothing."
---

Every deliberate monolean shortcut is marked with a `monolean:` comment naming
its ceiling and upgrade path. This collects them into one ledger so a deferral
can't quietly become permanent.

## Scan

Grep the repo for comment markers, skipping `node_modules`, `.git`, and build
output:

`grep -rnE '(#|//) ?monolean:' .`  (add other comment prefixes if your stack uses them)

Each hit is one ledger row. The comment prefix keeps prose that merely mentions
the convention out of the ledger.

## Output

One row per marker, grouped by file:

`<file>:<line>, <what was simplified>. ceiling: <the limit named>. upgrade: <the trigger to revisit>.`

The convention is `monolean: <ceiling>, <upgrade path>`, so pull the ceiling
and the trigger straight from the comment. Want an owner per row too? add
`git blame -L<line>,<line>`.

Flag the rot risk: any `monolean:` comment that names no upgrade path or
trigger gets a `no-trigger` tag, those are the ones that silently rot.

End with `<N> markers, <M> with no trigger.` Nothing found: `No monolean: debt. Clean ledger.`

Also writes findings to `.monomind/metrics/monolean-debt.json` when run inside a monomind project.

## Boundaries

Reads and reports only, changes nothing. To persist it, ask and it writes the
ledger to a file (e.g. `MONOLEAN-DEBT.md`). One-shot. "stop monolean-debt" or
"normal mode" to revert.
