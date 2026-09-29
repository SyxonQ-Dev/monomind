---
name: mastermind-budgets
description: Mastermind budgets — view, set, and track the spend caps the Org Runtime enforces (roles[].budget_usd, roles[].budget_tokens, run_config.budget_tokens) in the org definition. Shows each role's cap next to its spend from the runtime's own cost records, flags roles near or over a cap, and hot-reloads a running org after a change.
type: domain-skill
default_mode: auto
pick: low
---

# Mastermind Budgets

This skill is invoked by `mastermind:budgets` or directly via `/mastermind-budgets`.

The Org Runtime enforces exactly three caps, all in the org definition `.monomind/orgs/<org>.json`
(schemas: `packages/@monomind/cli/src/orgrt/types-role.ts` and `types.ts`; enforcement:
`orgrt/budget-closure.ts`):

| Field | Scope | What happens at the cap |
|-------|-------|-------------------------|
| `roles[].budget_usd` | one role, USD | its session closes and its tasks are blocked. Unset = no USD cap for that role |
| `roles[].budget_tokens` | one role, tokens | same; replaces the role's even split of `run_config.budget_tokens` |
| `run_config.budget_tokens` | whole org, tokens | every role's session closes (default `1000000`) |

A role's `policy.maxUsd` / `policy.maxTokens`, when set, win over `budget_usd` / `budget_tokens`.
Caps are per run: a new `monomind org run` starts at zero spend, `--resume` keeps it. The coordinator
is warned once when a role or the org passes 80% of a cap.

There is **no org-wide USD cap**. `monomind org run --budget-usd N` only refuses to start a run whose
upfront cost *estimate* exceeds N; it does not stop a run that overspends. To cap an org in dollars,
give every session role its own `budget_usd`. Never store budgets in a side-car file such as
`.monomind/orgs/<org>-budgets.json` — the runtime does not read it, so a limit written there is not
enforced.

---

## Inputs

- `brain_context`: BRAIN CONTEXT block (injected by command, or loaded below if standalone)
- `org_name`: org to manage budgets for (required)
- `action`: show | set | clear | alert
- `agent_id`: role id to scope to (optional — omit for the org-wide `run_config.budget_tokens`)
- `limit_tokens`: token cap to set (for set) — `roles[].budget_tokens`, or `run_config.budget_tokens` without `agent_id`
- `limit_usd`: USD cap to set (for set, requires `agent_id`) — `roles[].budget_usd`
- `run`: run id to read spend from (optional — defaults to the latest run)
- `caller`: command | master

---

## Step 0 — Brain Load (standalone only)

If `caller` is not "command", load brain context following mastermind-protocol/SKILL.md Brain Load Procedure with namespace: `ops`.

---

## Step 1 — Load Org and Spend

```bash
orgFile=".monomind/orgs/${org_name}.json"
[ ! -f "$orgFile" ] && { echo "ERROR: Org '${org_name}' not found."; exit 1; }

# Spend comes from the runtime's own records (runtime.json + the run's event log),
# the same numbers the daemon enforces against. Empty when the org has never run.
spendJson=$(npx -y monomind@latest org costs "$org_name" ${run:+--run "$run"} --format json 2>/dev/null \
  | tail -n 1)
echo "$spendJson" | jq -e '.items' >/dev/null 2>&1 \
  || spendJson='{"items":[],"totals":{"tokens":0,"cost_usd":0,"messages":0}}'
```

---

## Step 2 — Execute Action

### show (default)

```bash
echo "BUDGETS — $org_name  (run: $(echo "$spendJson" | jq -r '.run // "none yet"'))"
echo "════════════════════════════════════════════════════════"

jq -r --argjson spend "$spendJson" --arg only "${agent_id:-}" '
  def usd: . * 10000 | round / 10000;
  ($spend.items | map({key: .role, value: .}) | from_entries) as $s
  | [.roles[] | select(.kind != "endpoint")] as $roles
  | (.run_config.budget_tokens // 1000000) as $orgTok
  # even split as orgrt/role-slot.ts computeReplacementBudget: what the roles
  # with their own budget_tokens leave, shared by the roles without one
  | [$roles[] | select(.budget_tokens == null)] as $even
  | (($orgTok - ([$roles[].budget_tokens // 0] | add // 0)) / ([$even | length, 1] | max)
     | floor | [., 0] | max) as $split
  | "ORG   run_config.budget_tokens \($orgTok)   spent \($spend.totals.tokens) tokens / $\($spend.totals.cost_usd | usd)",
    "      (no org-wide USD cap — set budget_usd per role)",
    "",
    ( $roles[] | select($only == "" or .id == $only)
      | ($s[.id] // {cost_usd: 0, tokens: 0}) as $r
      | (.policy.maxUsd // .budget_usd) as $usd
      | (.policy.maxTokens // .budget_tokens // $split) as $tok
      | (if ($usd and $r.cost_usd >= $usd) or $r.tokens >= $tok then "  OVER"
         elif ($usd and $r.cost_usd >= $usd * 0.8) or $r.tokens >= $tok * 0.8 then "  >80%"
         else "" end) as $flag
      | "\(.id)\($flag)",
        "    USD:    $\($r.cost_usd | usd) / \(if $usd then "$\($usd)" else "no cap (budget_usd unset)" end)",
        "    tokens: \($r.tokens) / \($tok)\(if .policy.maxTokens or .budget_tokens then "" else " (even split of run_config.budget_tokens)" end)" )
' "$orgFile"

echo ""
echo "  Set a role USD cap:   /mastermind-budgets --org $org_name --action set --agent-id <role> --limit-usd 5"
echo "  Set the org token cap: /mastermind-budgets --org $org_name --action set --limit-tokens 2000000"
echo "  Spend history:        npx -y monomind@latest org report $org_name --all"
```

### set

Edits the enforced fields in the org definition, validates it, then hot-reloads a running org.
`org reload` applies `budget_usd`, `budget_tokens` and `run_config.budget_tokens` to live sessions
with their spend kept, and reopens a role that was closed for budget once it is under the new cap
(`orgrt/org-reload.ts`). A stopped org picks the new caps up on its next `monomind org run`.

```bash
tmp="${orgFile}.tmp"
if [ -n "${agent_id:-}" ]; then
  jq -e --arg id "$agent_id" '.roles[] | select(.id == $id)' "$orgFile" >/dev/null \
    || { echo "ERROR: role '$agent_id' not found in $orgFile"; exit 1; }
  jq -e --arg id "$agent_id" '.roles[] | select(.id == $id) | .kind == "endpoint"' "$orgFile" >/dev/null \
    && { echo "ERROR: '$agent_id' is an endpoint role — endpoint roles cannot carry budgets"; exit 1; }
  if [ -n "${limit_usd:-}" ]; then
    [[ "$limit_usd" =~ ^[0-9]+(\.[0-9]+)?$ ]] && awk -v v="$limit_usd" 'BEGIN{exit !(v>0)}' \
      || { echo "ERROR: limit_usd must be a positive number"; exit 1; }
    jq --arg id "$agent_id" --argjson v "$limit_usd" \
      '(.roles[] | select(.id == $id)).budget_usd = $v' "$orgFile" > "$tmp" && mv "$tmp" "$orgFile"
    echo "  roles[$agent_id].budget_usd → \$$limit_usd"
    jq -e --arg id "$agent_id" '.roles[] | select(.id == $id) | .policy.maxUsd != null' "$orgFile" >/dev/null \
      && echo "  NOTE: this role's policy.maxUsd is set and takes precedence over budget_usd."
  fi
  if [ -n "${limit_tokens:-}" ]; then
    [[ "$limit_tokens" =~ ^[1-9][0-9]*$ ]] || { echo "ERROR: limit_tokens must be a positive integer"; exit 1; }
    jq --arg id "$agent_id" --argjson v "$limit_tokens" \
      '(.roles[] | select(.id == $id)).budget_tokens = $v' "$orgFile" > "$tmp" && mv "$tmp" "$orgFile"
    echo "  roles[$agent_id].budget_tokens → $limit_tokens"
  fi
else
  [ -n "${limit_usd:-}" ] && {
    echo "ERROR: the runtime has no org-wide USD cap. Pass --agent-id to set roles[].budget_usd per role."
    exit 1
  }
  [[ "${limit_tokens:-}" =~ ^[1-9][0-9]*$ ]] || { echo "ERROR: limit_tokens must be a positive integer"; exit 1; }
  jq --argjson v "$limit_tokens" '.run_config.budget_tokens = $v' "$orgFile" > "$tmp" && mv "$tmp" "$orgFile"
  echo "  run_config.budget_tokens → $limit_tokens"
fi

npx -y monomind@latest org validate "$org_name" \
  || echo "WARNING: '${org_name}' no longer passes validation — fix it before 'monomind org run ${org_name}'"
npx -y monomind@latest org reload "$org_name"
```

### clear

Removes a role's own caps (`budget_usd`, `budget_tokens`), so it falls back to no USD cap and its
even split of `run_config.budget_tokens`. `run_config.budget_tokens` itself cannot be removed — the
schema defaults it to 1000000 — only changed with `set`.

```bash
[ -z "${agent_id:-}" ] && { echo "ERROR: clear needs --agent-id <role>"; exit 1; }
tmp="${orgFile}.tmp"
jq --arg id "$agent_id" '(.roles[] | select(.id == $id)) |= del(.budget_usd, .budget_tokens)' \
  "$orgFile" > "$tmp" && mv "$tmp" "$orgFile"
echo "  Cleared budget_usd / budget_tokens for '$agent_id'"
npx -y monomind@latest org validate "$org_name" \
  || echo "WARNING: '${org_name}' no longer passes validation — fix it before 'monomind org run ${org_name}'"
npx -y monomind@latest org reload "$org_name"
```

### alert

Roles at or over 80% of an enforced cap in the selected run, and the budget events the runtime
itself recorded (`budget-warning`, `budget-exhausted`, `org-budget-exhausted`):

```bash
echo "BUDGET ALERTS — $org_name"
echo "────────────────────────────────────────────────────────"

jq -r --argjson spend "$spendJson" '
  ($spend.items | map({key: .role, value: .}) | from_entries) as $s
  | [.roles[] | select(.kind != "endpoint")] as $roles
  | [$roles[] | select(.budget_tokens == null)] as $even
  | (((.run_config.budget_tokens // 1000000) - ([$roles[].budget_tokens // 0] | add // 0))
     / ([$even | length, 1] | max) | floor | [., 0] | max) as $split
  | [ $roles[]
      | ($s[.id] // {cost_usd: 0, tokens: 0}) as $r
      | (.policy.maxUsd // .budget_usd) as $usd
      | (.policy.maxTokens // .budget_tokens // $split) as $tok
      | select(($usd and $r.cost_usd >= $usd * 0.8) or $r.tokens >= $tok * 0.8)
      | "  \(.id): $\($r.cost_usd * 10000 | round / 10000)\(if $usd then " / $\($usd)" else "" end), \($r.tokens) / \($tok) tokens" ]
  | if length == 0 then "  All roles under 80% of their caps." else .[] end
' "$orgFile"

echo ""
npx -y monomind@latest org events "$org_name" ${run:+--run "$run"} 2>/dev/null \
  | jq -Rr 'fromjson? | select(.reason | IN("budget-warning", "budget-exhausted", "org-budget-exhausted"))
            | "  [\(.reason)] \(.msg)"' | tail -n 20
```

---

## Step 3 — Return Output

```yaml
domain: ops
status: complete
action: <action>
org_name: <org_name>
config_file: .monomind/orgs/<org_name>.json
```

---

## Step 4 — Brain Write (standalone only)

If `caller` is not "command", follow mastermind-protocol/SKILL.md Brain Write Procedure for domain `ops`.
