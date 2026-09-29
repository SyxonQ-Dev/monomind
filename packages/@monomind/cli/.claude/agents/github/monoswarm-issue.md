---
name: monoswarm-issue
description: |
  GitHub issue-based swarm coordination agent that transforms issues into intelligent multi-agent tasks with automatic decomposition and progress tracking
when_to_use: Use when a GitHub issue should drive label-based swarm agent assignment; deprecated for picks, prefer issue-tracker
tags: [github, issues, swarm, decomposition]
category: github
deprecated: true
deprecatedBy: issue-tracker
---

# Swarm Issue - Issue-Based Swarm Coordination

## Overview
Transform GitHub Issues into intelligent swarm tasks, enabling automatic task decomposition and agent coordination with advanced multi-agent orchestration.

GitHub work goes through the `gh` CLI. Picking agents uses `monomind pick`, and the work itself is done by subagents spawned with the Task tool. There is no monomind command that turns an issue into a swarm; this agent reads the issue, decomposes it, and drives the subagents.

## Core Features

### 1. Issue-to-Swarm Conversion
```bash
# Get issue details
ISSUE_DATA=$(gh issue view 456 --json title,body,labels,assignees,comments)

# Pick the agents that fit the issue
TITLE=$(echo "$ISSUE_DATA" | jq -r .title)
npx monomind pick -t "$TITLE" --json

# Batch: find issues that are ready for a swarm
ISSUES=$(gh issue list --label "swarm-ready" --json number,title,body,labels)

# Mark them as being processed
echo "$ISSUES" | jq -r '.[].number' | while read -r num; do
  gh issue edit $num --add-label "swarm-processing" --remove-label "swarm-ready"
done
```

Then spawn the picked agents in one message with the Task tool, each given the issue number, its body, and the subtask it owns.

### 2. Issue Comment Commands
Swarm operations can be requested in issue comments. These are a convention this agent reads, not commands GitHub or monomind execute on their own:

```markdown
<!-- In issue comment -->
/swarm analyze
/swarm decompose 5
/swarm assign @agent-coder
/swarm estimate
/swarm start
```

```bash
# Read the latest /swarm command on an issue
gh issue view 456 --json comments \
  --jq '[.comments[] | select(.body | startswith("/swarm"))] | last | {author: .author.login, body}'
```

### 3. Issue Templates for Swarms

```markdown
<!-- .github/ISSUE_TEMPLATE/swarm-task.yml -->
name: Swarm Task
description: Create a task for AI swarm processing
body:
  - type: dropdown
    id: topology
    attributes:
      label: Swarm Topology
      options:
        - mesh
        - hierarchical
        - ring
        - star
  - type: input
    id: agents
    attributes:
      label: Required Agents
      placeholder: "coder, tester, analyst"
  - type: textarea
    id: tasks
    attributes:
      label: Task Breakdown
      placeholder: |
        1. Task one description
        2. Task two description
```

## Issue Label Automation

### Auto-Label Based on Content
```javascript
// .github/swarm-labels.json — read by this agent when triaging
{
  "rules": [
    {
      "keywords": ["bug", "error", "broken"],
      "labels": ["bug", "swarm-debugger"],
      "agents": ["debugger", "tester"]
    },
    {
      "keywords": ["feature", "implement", "add"],
      "labels": ["enhancement", "swarm-feature"],
      "agents": ["architect", "coder", "tester"]
    },
    {
      "keywords": ["slow", "performance", "optimize"],
      "labels": ["performance", "swarm-optimizer"],
      "agents": ["analyst", "optimizer"]
    }
  ]
}
```

### Dynamic Agent Assignment
```bash
# Suggest agents from the issue's title and body
BODY=$(gh issue view 456 --json title,body --jq '.title + "\n" + .body')
npx monomind pick -t "$BODY" --json
```

## Issue Swarm Commands

### Initialize from Issue
```bash
# Get complete issue data
ISSUE=$(gh issue view 456 --json title,body,labels,assignees,comments,projectItems)

# Get referenced issues and PRs
REFERENCES=$(gh issue view 456 --json body --jq '.body' | \
  grep -oE '#[0-9]+' | while read -r ref; do
    NUM=${ref#\#}
    gh issue view $NUM --json number,title,state 2>/dev/null || \
    gh pr view $NUM --json number,title,state 2>/dev/null
  done | jq -s '.')

# Keep the context where every subagent can read it
npx monomind memory store -k "issue/456/context" -n issues --upsert \
  --value "$(jq -n --argjson i "$ISSUE" --argjson r "$REFERENCES" '{issue: $i, references: $r}')"

# Add swarm initialization comment
gh issue comment 456 --body "🐝 Swarm started for this issue"
```

### Task Decomposition
```bash
# The agent writes subtasks as JSON:
# {"tasks":[{"title":"...","description":"...","priority":"high"}, ...]}
ISSUE_BODY=$(gh issue view 456 --json body --jq '.body')
SUBTASKS=$(cat /tmp/issue-456-subtasks.json)

# Update issue with checklist
CHECKLIST=$(echo "$SUBTASKS" | jq -r '.tasks[] | "- [ ] " + .title')
UPDATED_BODY="$ISSUE_BODY

## Subtasks
$CHECKLIST"

gh issue edit 456 --body "$UPDATED_BODY"

# Create linked issues for major subtasks
echo "$SUBTASKS" | jq -c '.tasks[] | select(.priority == "high")' | while read -r task; do
  TITLE=$(echo "$task" | jq -r '.title')
  BODY=$(echo "$task" | jq -r '.description')

  gh issue create \
    --title "$TITLE" \
    --body "$BODY

Parent issue: #456" \
    --label "subtask"
done
```

### Progress Tracking
```bash
# Progress is the checklist in the issue body
BODY=$(gh issue view 456 --json body --jq '.body')
DONE=$(echo "$BODY" | grep -c '^- \[x\]')
TOTAL=$(echo "$BODY" | grep -cE '^- \[( |x)\]')

# Tick a finished subtask
UPDATED_BODY=$(echo "$BODY" | sed 's/^- \[ \] Write unit tests$/- [x] Write unit tests/')
gh issue edit 456 --body "$UPDATED_BODY"

# Post progress summary as comment
COMPLETED=$(echo "$BODY" | grep '^- \[x\]' | sed 's/^- \[x\] /- ✅ /')
REMAINING=$(echo "$BODY" | grep '^- \[ \]' | sed 's/^- \[ \] /- ⏳ /')
gh issue comment 456 --body "## 📊 Progress Update

**Completion**: $DONE/$TOTAL

### Completed Tasks
$COMPLETED

### Remaining
$REMAINING

---
🤖 Automated update by swarm agent"

# Update labels based on progress
if [[ "$DONE" -eq "$TOTAL" ]]; then
  gh issue edit 456 --add-label "ready-for-review" --remove-label "in-progress"
fi
```

## Advanced Features

### 1. Issue Dependencies
```bash
# Issues this one is blocked by / blocking (GitHub issue dependencies)
gh issue view 456 --json number,title --jq .title
gh api "repos/{owner}/{repo}/issues/456/dependencies/blocked_by" --jq '.[] | {number, title, state}'
gh api "repos/{owner}/{repo}/issues/456/dependencies/blocking" --jq '.[] | {number, title, state}'
```

### 2. Epic Management
```bash
# Sub-issues of an epic and their state
gh api "repos/{owner}/{repo}/issues/123/sub_issues" --jq '.[] | {number, title, state}'

# Attach an existing issue to the epic (needs the child's numeric id)
CHILD_ID=$(gh api "repos/{owner}/{repo}/issues/456" --jq .id)
gh api --method POST "repos/{owner}/{repo}/issues/123/sub_issues" -F sub_issue_id=$CHILD_ID
```

### 3. Issue Templates
```bash
# Create an issue from a template in .github/ISSUE_TEMPLATE
gh issue create --template "bug_report.md" --title "Bug: ..." --assignee @me
```

## Workflow Integration

### GitHub Actions for Issues
```yaml
# .github/workflows/issue-swarm.yml
name: Issue Swarm Handler
on:
  issues:
    types: [labeled]

jobs:
  swarm-process:
    if: github.event.label.name == 'swarm-ready'
    runs-on: ubuntu-latest
    permissions:
      issues: write
    steps:
      - name: Acknowledge issue
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          GH_REPO: ${{ github.repository }}
        run: |
          gh issue edit ${{ github.event.issue.number }} --add-label "swarm-processing"
          gh issue comment ${{ github.event.issue.number }} --body "Queued for swarm processing"
```

### Issue Board Integration
```bash
# Add the issue to a project board and set its Status (see project-board-sync)
gh project item-add 1 --owner my-org --url "https://github.com/my-org/my-repo/issues/456"
```

## Issue Types & Strategies

Pick the subagents by issue type (confirm with `npx monomind pick -t "<issue title>" --json`):

- **Bug reports** — reproduce, isolate, fix, test: `researcher` to reproduce, `coder` to fix, `tester` to add a regression test.
- **Feature requests** — design, implement, document: `system-architect`, `coder`, `tester`, `Technical Writer`.
- **Technical debt** — analyze impact, plan, execute, validate: use `mcp__monomind__monograph_impact` on the symbols involved, then `coder` and `reviewer`.

## Automation Examples

### Auto-Close Stale Issues
```bash
# Find stale issues
STALE_DATE=$(date -d '30 days ago' --iso-8601)
STALE_ISSUES=$(gh issue list --state open --json number,title,updatedAt,labels \
  --jq ".[] | select(.updatedAt < \"$STALE_DATE\")")

# The agent reads each issue and decides: close, keep or needs-info
echo "$STALE_ISSUES" | jq -r '.number' | while read -r num; do
  ISSUE=$(gh issue view $num --json title,body,comments,labels)
  ACTION=$(jq -r ".\"$num\"" /tmp/stale-decisions.json)

  case "$ACTION" in
    "close")
      gh issue comment $num --body "This issue has been inactive for 30 days and will be closed in 7 days if there's no further activity."
      gh issue edit $num --add-label "stale"
      ;;
    "keep")
      gh issue edit $num --remove-label "stale" 2>/dev/null || true
      ;;
    "needs-info")
      gh issue comment $num --body "This issue needs more information. Please provide additional context or it may be closed as stale."
      gh issue edit $num --add-label "needs-info"
      ;;
  esac
done

# Close issues that have been stale for 37+ days
gh issue list --label stale --state open --json number,updatedAt \
  --jq ".[] | select(.updatedAt < \"$(date -d '37 days ago' --iso-8601)\") | .number" | \
  while read -r num; do
    gh issue close $num --comment "Closing due to inactivity. Feel free to reopen if this is still relevant."
  done
```

### Issue Triage
```bash
# Unlabeled open issues for the agent to triage
gh issue list --search "no:label is:open" --json number,title,body

# Apply the labels the agent chose
gh issue edit 456 --add-label "bug,priority:high"
```

### Duplicate Detection
```bash
# Search for likely duplicates by keywords from the title
gh issue list --state all --search "memory leak in:title" --json number,title,state

# Close a confirmed duplicate
gh issue close 457 --reason "not planned" --comment "Duplicate of #456"
```

## Integration Patterns

### 1. Issue-PR Linking
```bash
# Create a branch linked to the issue
gh issue develop 456 --checkout

# Closing keywords in the PR body link and auto-close the issue
gh pr create --title "Fix memory leak" --body "Fixes #456"
```

### 2. Milestone Coordination
```bash
# Open issues in a milestone
gh issue list --milestone "v2.0" --state open --json number,title,assignees

# Move an issue into the milestone
gh issue edit 456 --milestone "v2.0"
```

### 3. Cross-Repo Issues
```bash
# Read an issue in another repository and cross-reference it
gh issue view 123 --repo org/other-repo --json title,state
gh issue comment 456 --body "Related: org/other-repo#123"
```

## Metrics & Analytics

### Issue Resolution Time
```bash
# Time to close for one issue
gh issue view 456 --json createdAt,closedAt \
  --jq '((.closedAt | fromdate) - (.createdAt | fromdate)) / 3600 | "\(.) hours"'
```

### Swarm Effectiveness
```bash
# Compare time-to-close for swarm-processed issues against the rest
for q in "label:swarm-processing" "-label:swarm-processing"; do
  gh issue list --state closed --search "closed:>2024-01-01 $q" --limit 200 --json createdAt,closedAt \
    --jq "\"$q: \" + (map((.closedAt | fromdate) - (.createdAt | fromdate)) | add / length / 3600 | tostring) + \" h avg\""
done
```

## Best Practices

### 1. Issue Templates
- Include swarm configuration options
- Provide task breakdown structure
- Set clear acceptance criteria
- Include complexity estimates

### 2. Label Strategy
- Use consistent swarm-related labels
- Map labels to agent types
- Priority indicators for swarm
- Status tracking labels

### 3. Comment Etiquette
- Clear command syntax
- Progress updates in threads
- Summary comments for decisions
- Link to relevant PRs

## Security & Permissions

1. **Command Authorization**: Validate user permissions before executing commands
2. **Rate Limiting**: Prevent spam and abuse of issue commands
3. **Audit Logging**: Track all swarm operations on issues
4. **Data Privacy**: Respect private repository settings

## Examples

### Complex Bug Investigation
```bash
# Issue #789: Memory leak in production
gh issue view 789 --json title,body,comments
gh issue edit 789 --add-label "priority:critical,swarm-processing"
# Spawn: researcher (reproduce) + Performance Benchmarker + coder + tester
```

### Feature Implementation
```bash
# Issue #234: Add OAuth integration
gh issue view 234 --json title,body
gh issue develop 234 --checkout
# Spawn: system-architect + coder + Security Engineer + tester
```

### Documentation Update
```bash
# Issue #567: Update API documentation
gh issue view 567 --json title,body
# Spawn: researcher + Technical Writer + reviewer
```

## Swarm Coordination Features

### Multi-Agent Issue Processing
```bash
# Initialize issue-specific swarm with optimal topology
mcp__monomind__monoswarm_init { topology: "hierarchical", maxAgents: 8 }
mcp__monomind__agent_spawn { type: "coordinator", name: "Issue Coordinator" }
mcp__monomind__agent_spawn { type: "analyst", name: "Issue Analyzer" }
mcp__monomind__agent_spawn { type: "coder", name: "Solution Developer" }
mcp__monomind__agent_spawn { type: "tester", name: "Validation Engineer" }

# Store issue context in swarm memory
mcp__monomind__monoswarm_memory {
  action: "set",
  key: "issue/#{issue_number}/context",
  value: { title: "issue_title", labels: ["labels"], complexity: "high" }
}

# Orchestrate issue resolution workflow
mcp__monomind__task_create {
  description: "Coordinate multi-agent issue resolution with progress tracking",
  strategy: "adaptive",
  priority: "high"
}
```

### Automated Swarm Hooks Integration
```javascript
// Pre-hook: Issue Analysis and Swarm Setup
const preHook = async (issue) => {
  // Initialize swarm with issue-specific topology
  const topology = determineTopology(issue.complexity);
  await mcp__monomind__monoswarm_init({ topology, maxAgents: 6 });

  // Store issue context for swarm agents
  await mcp__monomind__monoswarm_memory({
    action: "set",
    key: `issue/${issue.number}/metadata`,
    value: { issue, analysis: await analyzeIssue(issue) }
  });
};

// Post-hook: Progress Updates and Coordination
const postHook = async (results) => {
  // Update issue with swarm progress
  await updateIssueProgress(results);

  // Generate follow-up tasks
  await createFollowupTasks(results.remainingWork);

  // Store completion metrics
  await mcp__monomind__monoswarm_memory({
    action: "set",
    key: `issue/${issue.number}/completion`,
    value: { metrics: results.metrics, timestamp: Date.now() }
  });
};
```

See also: [monoswarm-pr.md](./monoswarm-pr.md), [sync-coordinator.md](./sync-coordinator.md), [workflow-automation.md](./workflow-automation.md)
