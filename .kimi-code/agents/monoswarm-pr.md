---
name: monoswarm-pr
description: |
  Pull request swarm management agent that coordinates multi-agent code review, validation, and integration workflows with automated PR lifecycle management
when_to_use: Use when PR comments or labels should drive swarm agents on a pull request; deprecated for picks, prefer pr-manager
tags: [github, pull-requests, swarm, automation]
category: github
deprecated: true
deprecatedBy: pr-manager
---

# Swarm PR - Managing Swarms through Pull Requests

## Overview

Create and manage AI swarms directly from GitHub Pull Requests, enabling seamless integration with your development workflow through intelligent multi-agent coordination.

GitHub work goes through the `gh` CLI. Agent picking uses `monomind pick`, the swarm's topology and roster are recorded with the `monoswarm` MCP tools, and the work is done by subagents spawned with the Task tool. There is no monomind command that creates a swarm from a PR; this agent reads the PR and drives the subagents.

## Core Features

### 1. PR-Based Swarm Creation

```bash
# PR context
gh pr view 123 --json title,body,labels,files,author,assignees > /tmp/pr-123.json

# Pick agents from the PR title and labels
QUERY=$(jq -r '.title + " " + ([.labels[].name] | join(" "))' /tmp/pr-123.json)
npx monomind pick -t "$QUERY" --agents --json
```

Then record the swarm with `mcp__monomind__monoswarm_init` and spawn the picked agents in one message with the Task tool.

### 2. PR Comment Commands

Swarm operations can be requested in PR comments. They are a convention this agent reads, not commands GitHub or monomind execute on their own:

```markdown
<!-- In PR comment -->

/swarm init mesh 6
/swarm spawn coder "Implement authentication"
/swarm spawn tester "Write unit tests"
/swarm status
```

```bash
# Read /swarm commands on a PR
gh pr view 123 --json comments \
  --jq '.comments[] | select(.body | startswith("/swarm")) | {author: .author.login, body}'
```

### 3. Automated PR Workflows

```yaml
# .github/workflows/swarm-pr.yml — labels the PR so the agent picks it up
name: Swarm PR Handler
on:
  issue_comment:
    types: [created]

jobs:
  swarm-handler:
    if: github.event.issue.pull_request && startsWith(github.event.comment.body, '/swarm')
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write
    steps:
      - name: Queue swarm command
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          GH_REPO: ${{ github.repository }}
        run: |
          gh pr edit ${{ github.event.issue.number }} --add-label "swarm-requested"
          gh pr comment ${{ github.event.issue.number }} --body "Swarm command queued"
```

## PR Label Integration

### Automatic Agent Assignment

Map PR labels to agent types:

```json
{
  "label-mapping": {
    "bug": ["debugger", "tester"],
    "feature": ["architect", "coder", "tester"],
    "refactor": ["analyst", "coder"],
    "docs": ["researcher", "writer"],
    "performance": ["analyst", "optimizer"]
  }
}
```

### Label-Based Topology

```bash
# Small PR (< 100 lines): ring topology
# Medium PR (100-500 lines): mesh topology
# Large PR (> 500 lines): hierarchical topology
LINES=$(gh pr view 123 --json additions,deletions --jq '.additions + .deletions')
if   [ "$LINES" -lt 100 ]; then TOPOLOGY=ring
elif [ "$LINES" -le 500 ]; then TOPOLOGY=mesh
else TOPOLOGY=hierarchical; fi
echo "$TOPOLOGY"
```

## PR Swarm Commands

### Initialize from PR

```bash
PR_DIFF=$(gh pr diff 123)
PR_INFO=$(gh pr view 123 --json title,body,labels,files,reviews)

# Check out the PR and assess the change
gh pr checkout 123
npx monomind analyze diff origin/main..HEAD --risk --classify

# Share the context with every subagent
npx monomind memory store -k "pr/123/context" -n prs --upsert --value "$PR_INFO"
```

### Progress Updates

```bash
# The agent writes the progress summary; post it to the PR
gh pr comment 123 --body-file /tmp/pr-123-progress.md

# Update PR labels once the swarm's tasks are done
gh pr edit 123 --add-label "ready-for-review" --remove-label "swarm-in-progress"
```

### Code Review Integration

```bash
PR_FILES=$(gh pr diff 123 --name-only)

# Review subagents (security, performance, style) return findings as JSON:
# [{ "path": "...", "line": 10, "body": "..." }]
COMMIT=$(gh pr view 123 --json headRefOid -q .headRefOid)

jq -n --arg commit "$COMMIT" --slurpfile c /tmp/review-123.json '{
  commit_id: $commit,
  event: "COMMENT",
  body: "Swarm review",
  comments: ($c[0] | map({path, line, side: "RIGHT", body}))
}' | gh api --method POST "repos/{owner}/{repo}/pulls/123/reviews" --input -
```

## Advanced Features

### 1. Multi-PR Swarm Coordination

```bash
# Files touched by more than one of the related PRs
for pr in 123 124 125; do gh pr diff $pr --name-only; done | sort | uniq -d
```

### 2. PR Dependency Analysis

```bash
# Stacked PRs: what each PR is based on
gh pr list --json number,headRefName,baseRefName \
  --jq '.[] | "#\(.number): \(.headRefName) -> \(.baseRefName)"'

# Merge conflicts
gh pr view 123 --json mergeable,mergeStateStatus
```

### 3. Automated PR Fixes

```bash
# Failing checks and their logs
gh pr checks 123
RUN_ID=$(gh run list --branch "$(gh pr view 123 --json headRefName -q .headRefName)" --limit 1 --json databaseId -q '.[0].databaseId')
gh run view "$RUN_ID" --log-failed

# After a subagent fixes lint/test failures on the checked-out branch
git commit -am "fix: address lint and test failures"
git push
```

## Best Practices

### 1. PR Templates

```markdown
<!-- .github/pull_request_template.md -->

## Swarm Configuration

- Topology: [mesh/hierarchical/ring/star]
- Max Agents: [number]
- Auto-spawn: [yes/no]
- Priority: [high/medium/low]

## Tasks for Swarm

- [ ] Task 1 description
- [ ] Task 2 description
```

### 2. Status Checks

Make CI jobs required checks on the base branch (`gh api --method PUT repos/{owner}/{repo}/branches/main/protection ...`) so a PR cannot merge before the swarm's tests and reviews pass. See where a PR stands with `gh pr checks 123`.

### 3. PR Merge Automation

```bash
# Merge once all tasks are ticked and reviews are in
OPEN_TASKS=$(gh pr view 123 --json body --jq '.body' | grep -c '^- \[ \]')
APPROVALS=$(gh pr view 123 --json reviews --jq '[.reviews[] | select(.state == "APPROVED")] | length')

if [[ $OPEN_TASKS -eq 0 && $APPROVALS -ge 2 ]]; then
  # Enable auto-merge
  gh pr merge 123 --auto --squash
fi
```

## Examples

### Feature Development PR

```bash
# PR #456: Add user authentication
gh pr checkout 456
npx monomind pick -t "add user authentication" --agents --json
# Spawn: system-architect + coder + tester + Security Engineer (hierarchical)
```

### Bug Fix PR

```bash
# PR #789: Fix memory leak
gh pr checkout 789
gh pr edit 789 --add-label "priority:high"
# Spawn: researcher + Performance Benchmarker + tester (mesh)
```

### Documentation PR

```bash
# PR #321: Update API docs
gh pr checkout 321
# Spawn: researcher + Technical Writer + reviewer (ring)
```

## Metrics & Reporting

### PR Swarm Analytics

```bash
# Time from open to merge, review count and size
gh pr view 123 --json createdAt,mergedAt,reviews,additions,deletions --jq '{
  hours_to_merge: (((.mergedAt | fromdate) - (.createdAt | fromdate)) / 3600),
  reviews: (.reviews | length),
  size: (.additions + .deletions)
}'
```

## Security Considerations

1. **Token Permissions**: Ensure GitHub tokens have appropriate scopes
2. **Command Validation**: Validate all PR comments before execution
3. **Rate Limiting**: Implement rate limits for PR operations
4. **Audit Trail**: Log all swarm operations for compliance

## Integration with Claude Code

When using with Claude Code:

1. Claude Code reads PR diff and context
2. Swarm coordinates approach based on PR type
3. Agents work in parallel on different aspects
4. Progress updates posted to PR automatically
5. Final review performed before marking ready

## Advanced Swarm PR Coordination

### Multi-Agent PR Analysis

```bash
# Initialize PR-specific swarm with intelligent topology selection
mcp__monomind__monoswarm_init { topology: "mesh", maxAgents: 8 }
mcp__monomind__agent_spawn { type: "coordinator", name: "PR Coordinator" }
mcp__monomind__agent_spawn { type: "reviewer", name: "Code Reviewer" }
mcp__monomind__agent_spawn { type: "tester", name: "Test Engineer" }
mcp__monomind__agent_spawn { type: "analyst", name: "Impact Analyzer" }
mcp__monomind__agent_spawn { type: "optimizer", name: "Performance Optimizer" }

# Store PR context for swarm coordination
mcp__monomind__monoswarm_memory {
  action: "set",
  key: "pr/#{pr_number}/analysis",
  value: {
    diff: "pr_diff_content",
    files_changed: ["file1.js", "file2.py"],
    complexity_score: 8.5,
    risk_assessment: "medium"
  }
}

# Orchestrate comprehensive PR workflow
mcp__monomind__task_create {
  description: "Execute multi-agent PR review and validation workflow",
  strategy: "parallel",
  priority: "high",
  dependencies: ["diff_analysis", "test_validation", "security_review"]
}
```

### Swarm-Coordinated PR Lifecycle

```javascript
// Pre-hook: PR Initialization and Swarm Setup
const prPreHook = async (prData) => {
  // Analyze PR complexity for optimal swarm configuration
  const complexity = await analyzePRComplexity(prData);
  const topology = complexity > 7 ? "hierarchical" : "mesh";

  // Initialize swarm with PR-specific configuration
  await mcp__monomind__monoswarm_init({ topology, maxAgents: 8 });

  // Store comprehensive PR context
  await mcp__monomind__monoswarm_memory({
    action: "set",
    key: `pr/${prData.number}/context`,
    value: {
      pr: prData,
      complexity,
      agents_assigned: await getOptimalAgents(prData),
      timeline: generateTimeline(prData),
    },
  });

  // Coordinate initial agent synchronization
  await mcp__monomind__monoswarm_status({ swarmId: "current" });
};

// Post-hook: PR Completion and Metrics
const prPostHook = async (results) => {
  // Generate comprehensive PR completion report
  const report = await generatePRReport(results);

  // Update PR with final swarm analysis
  await updatePRWithResults(report);

  // Store completion metrics for future optimization
  await mcp__monomind__monoswarm_memory({
    action: "set",
    key: `pr/${results.number}/completion`,
    value: {
      completion_time: results.duration,
      agent_efficiency: results.agentMetrics,
      quality_score: results.qualityAssessment,
      lessons_learned: results.insights,
    },
  });
};
```

### Intelligent PR Merge Coordination

```bash
# Coordinate merge decision with swarm consensus
mcp__monomind__monoswarm_status { swarmId: "pr-review-swarm" }

# Analyze merge readiness with multiple agents
mcp__monomind__task_create {
  description: "Evaluate PR merge readiness with comprehensive validation",
  strategy: "sequential",
  priority: "critical"
}

# Store merge decision context
mcp__monomind__monoswarm_memory {
  action: "set",
  key: "pr/merge_decisions/#{pr_number}",
  value: {
    ready_to_merge: true,
    validation_passed: true,
    agent_consensus: "approved",
    final_review_score: 9.2
  }
}
```

See also: [monoswarm-issue.md](./monoswarm-issue.md), [sync-coordinator.md](./sync-coordinator.md), [workflow-automation.md](./workflow-automation.md)
