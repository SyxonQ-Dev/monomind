---
name: mastermind-routines
description: Mastermind routines — manage an org's recurring runs through the one trigger the Org Runtime enforces, the org definition's `schedule` interval (run by `monomind org serve`). Set, clear, pause, resume, or trigger a run now; per-agent cron routines are not supported by the runtime and are flagged as not enforced.
type: domain-skill
default_mode: confirm
pick: low
---

# Mastermind Routines

This skill is invoked directly via `/mastermind-routines`.

The Org Runtime has exactly one recurring trigger: the `schedule` field of the org definition
`.monomind/orgs/<org>.json` (`OrgDefSchema` in `packages/@monomind/cli/src/orgrt/types.ts`).

- Format (`parseSchedule` in `orgrt/scheduler.ts`): `"<N>s"`, `"<N>m"`, `"<N>h"`, or a number of
  minutes. `null` = manual only. Cron expressions are **not** accepted — "weekdays at 9am" cannot be
  expressed; use an interval.
- Only `monomind org serve` runs schedules, and it reads them when it starts. After changing
  `schedule`, restart `org serve` (`org reload` does not re-arm the timer).
- Each tick starts a full org run toward the org's `goal`, bounded by `run_config.max_run` (default:
  the interval). A tick that lands while the org is already running yields; ticks missed while a
  run was in progress coalesce into one catch-up run when it ends. `run_config.prechecks` that fail
  skip the tick. A paused org (`monomind org pause`) skips its ticks until resumed.

There are no per-agent routines, cron schedules, or concurrency/catch-up policies in the runtime.
Never write routines to `.monomind/orgs/<org>-routines.json` — the runtime does not read that file
(only the dashboard displays it), so a routine stored there never fires. When a user asks for one
recurring task, map it to the org's `schedule` + `goal`; when they need several independent
cadences, suggest one org per cadence.

---

## Inputs

- `brain_context`: BRAIN CONTEXT block
- `org_name`: org to manage routines for
- `action`: list | set | clear | pause | resume | trigger
- `schedule`: interval for set (e.g. `30m`, `2h`, `24h` — no `d` unit, no cron)
- `task_title`: for trigger — overrides the org goal for that one run (optional)
- `caller`: command | master

---

## Step 0 — Brain Load (standalone only)

If `caller` is not "command", load brain context following mastermind-protocol/SKILL.md Brain Load Procedure with namespace: `ops`.

---

## Step 1 — Load Org

```bash
orgFile=".monomind/orgs/${org_name}.json"
[ ! -f "$orgFile" ] && { echo "ERROR: Org '${org_name}' not found."; exit 1; }
```

---

## Step 2 — Execute Action

### list (default)

```bash
echo "ROUTINES — org: $org_name"
echo "──────────────────────────────────────────────────────"
jq -r '
  "  schedule: \(.schedule // "none (manual — monomind org run)")",
  "  goal:     \(.goal // "" | .[0:100])",
  "  max_run:  \(.run_config.max_run // "(the interval)")",
  "  prechecks: \((.run_config.prechecks // []) | length)"
' "$orgFile"
[ -f ".monomind/orgs/${org_name}/pause" ] && echo "  status:   PAUSED — scheduled ticks are skipped"
echo ""
echo "  Last runs:"
npx -y monomind@latest org report "$org_name" --all 2>/dev/null | tail -n 5

legacy=".monomind/orgs/${org_name}-routines.json"
if [ -f "$legacy" ] && [ "$(jq '(.routines // []) | length' "$legacy" 2>/dev/null)" != "0" ]; then
  echo ""
  echo "  NOT ENFORCED — entries in $legacy (the runtime never reads this file):"
  jq -r '(.routines // [])[] | "    - \(.name // .id) (\(.schedule // "?"))"' "$legacy"
  echo "  Fold the one that matters into the org schedule with --action set, then remove the file."
fi
```

### set

```bash
echo "$schedule" | grep -qE '^[0-9]+(s|m|h)$' \
  || { echo "ERROR: schedule must match ^[0-9]+(s|m|h)$ (e.g. 30m, 2h, 24h) — cron is not supported"; exit 1; }
tmp="${orgFile}.tmp"
jq --arg v "$schedule" '.schedule = $v' "$orgFile" > "$tmp" && mv "$tmp" "$orgFile"
echo "Updated: schedule → $schedule"
npx -y monomind@latest org validate "$org_name" \
  || echo "WARNING: '${org_name}' no longer passes validation — fix it before 'monomind org serve'"
echo "Start (or restart) the scheduler to apply it: npx -y monomind@latest org serve"
```

### clear

```bash
tmp="${orgFile}.tmp"
jq '.schedule = null' "$orgFile" > "$tmp" && mv "$tmp" "$orgFile"
echo "Updated: schedule → none (manual — run with monomind org run ${org_name})"
echo "Restart a running 'monomind org serve' so it drops the timer."
```

### pause / resume

Pausing keeps the schedule but makes every tick skip; resume re-enables them.

```bash
npx -y monomind@latest org "$action" "$org_name"
```

### trigger

Start one run now, outside the schedule:

```bash
npx -y monomind@latest org run "$org_name" ${task_title:+--task "$task_title"}
```

---

## Step 3 — Return Output

```yaml
domain: ops
status: complete
action: <action>
org: <org_name>
schedule: <the org's schedule after the action, or null>
config_file: .monomind/orgs/<org_name>.json
```

---

## Step 4 — Brain Write (standalone only)

If `caller` is not "command", follow mastermind-protocol/SKILL.md Brain Write Procedure for domain `ops`.
