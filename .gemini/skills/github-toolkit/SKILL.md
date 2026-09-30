---
name: github-toolkit
description: "GitHub workflows for monomind projects: issues, PRs, releases, repo structure, multi-package sync, Actions. Uses the gh CLI; monomind has no github command."
---

# GitHub Toolkit

Guidance for GitHub-integrated workflows in monomind projects. All GitHub
operations go through the `gh` CLI directly (for PRs, issues, releases) or
through monomind's MCP GitHub tools when running inside a swarm.

## Core operations

- **Issues** — triage, label, and track via `gh issue` or `mcp__monomind__github_issue_track`.
  See `/github:issue-tracker` (pack github — `monomind packs add github`).
- **Pull requests** — create, review, and merge via `gh pr` or `mcp__monomind__github_pr_manage`.
  See `/github:pr-manager` (pack github — `monomind packs add github`).
- **Releases** — version bump, changelog, tag, and publish coordination.
  See `/github:release-manager` (pack github — `monomind packs add github`).
- **Repo structure** — multi-repo layout and package boundary decisions.
  See `/github:repo-architect` (pack github — `monomind packs add github`).
- **Multi-package sync** — version alignment and dependency sync across a monorepo.
  See `/github:sync-coordinator` (pack github — `monomind packs add github`).
- **Integration modes overview** — which mode to use for which workflow.
  See `/github:github-modes` (pack github — `monomind packs add github`).

## Quick reference

```bash
# Issues
gh issue list --state open
gh issue create --title "..." --body "..."

# Pull requests
gh pr create --title "..." --body "..."
gh pr view <number> --json reviews,statusCheckRollup

# Releases
gh release create v1.2.3 --generate-notes
```

## MCP tools (when running inside a swarm)

```javascript
mcp__monomind__github_pr_manage({ action: "review", pr: 123 })
mcp__monomind__github_issue_track({ action: "list", state: "open" })
mcp__monomind__github_metrics({ repo: "owner/repo" })
```

## When to reach for the full docs

Each `/github:*` command above has the complete option/flag reference and
swarm-coordination patterns for its area — read the relevant one before doing
multi-step GitHub automation (e.g. spawning a `pr-manager` or
`release-manager` agent). They come with the github pack: run
`monomind packs add github` if `.claude/commands/github/` is missing.
