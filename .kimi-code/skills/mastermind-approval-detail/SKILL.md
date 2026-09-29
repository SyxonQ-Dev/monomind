---
name: mastermind-approval-detail
description: Mastermind approval-detail — inspect and resolve a single tool/action approval request from an org's agents via `monomind org approvals`, `org approve` and `org deny` (the queue in `.monomind/orgs/<org>/approvals.json`).
type: domain-skill
default_mode: confirm
pick: low
---

# Mastermind Approval Detail

This skill is invoked directly via `/mastermind-approval-detail`.

---

## Inputs

- `brain_context`: BRAIN CONTEXT block (injected by command, or loaded below if standalone)
- `org_name`: org the approval belongs to (required)
- `approval_id`: approval request id (`apr-…`) or short prefix (required for show/approve/deny)
- `action`: list | show | approve | deny
- `resolver`: name recorded as `resolvedBy` (optional; the CLI defaults to `human`)
- `caller`: command | master

The approval queue is `.monomind/orgs/<org>/approvals.json`, written by the Org Runtime when an
agent asks to use a gated tool (Bash, WebFetch, WebSearch, `org_complete`). Always read and resolve it
through the CLI: `monomind org approve`/`deny` deliver the decision to a running org's daemon (the
waiting agent is notified at once) and fall back to updating the file when the org is not running.

---

## Approval Record

| Field | Meaning |
|-------|---------|
| `requestId` | Request id (`apr-…`); may be null on entries recorded before ids existed |
| `roleId` | Role that asked |
| `action` | Tool or action requested (e.g. `Bash`) |
| `question` | What the agent asked |
| `input` | Tool input the agent wants to run (may be null) |
| `approved` | `null` = pending, `true` = approved, `false` = denied |
| `ts` / `resolvedAt` | Request / resolution time (epoch ms) |
| `resolvedBy` | Who resolved it |

---

## Step 0 — Brain Load (standalone only)

If `caller` is not "command", load brain context following mastermind-protocol/SKILL.md Brain Load Procedure with namespace: `ops`.

---

## Step 1 — Load Approval

```bash
orgFile=".monomind/orgs/${org_name}.json"
[ ! -f "$orgFile" ] && { echo "ERROR: Org '${org_name}' not found."; exit 1; }

all=$(monomind org approvals "$org_name" --all --format json) || { echo "ERROR: Cannot read approvals for org '${org_name}'."; exit 1; }

if [ -n "$approval_id" ]; then
  approvalDef=$(echo "$all" | jq -c --arg id "$approval_id" \
    '[.items[] | select(.requestId != null and (.requestId == $id or (.requestId | startswith($id))))][0] // empty')
  [ -z "$approvalDef" ] && { echo "ERROR: Approval '${approval_id}' not found."; exit 1; }
  approvalId=$(echo "$approvalDef" | jq -r '.requestId')
  roleId=$(echo "$approvalDef" | jq -r '.roleId')
  approvalAction=$(echo "$approvalDef" | jq -r '.action')
fi
```

---

## Step 2 — Execute Action

### list

```bash
monomind org approvals "$org_name"
```

### show (default)

```bash
echo "APPROVAL — ${approvalId}"
echo "────────────────────────────────────────────────────────"

echo "$approvalDef" | jq -r '
  "  ID:         \(.requestId)",
  "  Role:       \(.roleId)",
  "  Action:     \(.action)",
  "  Status:     \(if .approved == null then "pending" elif .approved then "approved" else "denied" end)",
  "  Question:   \(.question // "-")",
  "  Requested:  \(.ts | tostring)",
  "  Resolved:   \(.resolvedAt // "-" | tostring)  by \(.resolvedBy // "-")"
'

echo ""
echo "INPUT"
echo "────────────────────────────────────────────────────────"
echo "$approvalDef" | jq '.input // {}'

if [ "$(echo "$approvalDef" | jq -r '.approved')" = "null" ]; then
  echo ""
  echo "ACTIONS AVAILABLE"
  echo "  approve: --action approve"
  echo "  deny:    --action deny"
fi
```

### approve

```bash
monomind org approve "$org_name" "$roleId" "$approvalAction" --request "$approvalId" ${resolver:+--by "$resolver"}
```

### deny

```bash
monomind org deny "$org_name" "$roleId" "$approvalAction" --request "$approvalId" ${resolver:+--by "$resolver"}
```

---

## Step 3 — Return Output

```yaml
domain: ops
status: complete
action: <action>
org: <org_name>
approval_id: <approval_id>
approval_status: <status>
```

---

## Step 4 — Brain Write (standalone only)

If `caller` is not "command", follow mastermind-protocol/SKILL.md Brain Write Procedure for domain `ops`.
