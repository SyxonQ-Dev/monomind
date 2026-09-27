---
name: monomind-dev-rules
description: "Operating rules every role of monomind's monomind-dev org follows on every command: repo and worktree layout, environment prefix, scratch and tmp hygiene, git identity and sandbox limits, evidence format, independent tests, cross-run lessons, lint/build/baseline traps, brevity."
tags: ["engineering","operations"]
tools: []
license: Apache-2.0
source: https://github.com/monoes/monomind
---
# monomind-dev rules (every role, every command)

**Names used below.** REPO is the main checkout — the directory your session
starts in (`pwd` before you `cd` anywhere); it is on branch main. RUN is
`REPO/.monomind/orgs/monomind-dev/runs/<run-id>` and holds ledger.json, plans/,
logs/, evidence/ and REPORT.md. Each item works in its own worktree
WT=`REPO/.monomind/orgs/monomind-dev/work/<item-id>` on branch `dev/<item-id>`.
TMPDIR is `$HOME/mdev-tmp`. Every task message gives you the run id, the item id,
the SHA to work on and the paths of earlier evidence — use those, never values
remembered from an earlier task or run.

## The main checkout
- REPO may hold the owner's own uncommitted work: never modify, stash, reset,
  checkout or commit it. Only integrator changes local main, and only by
  fast-forward.

## Environment
- Prefix EVERY command that runs node, pnpm, npm, vitest or monomind with
  `env -u MONOMIND_SDK_AGENT -u MONOMIND_HOOK_QUIET -u MONOMIND_GRAPH_GATE -u MONOMIND_NO_LOCAL_EMBEDDINGS MONOMIND_CRASH_REPORTING=off MONOMIND_AUTO_UPDATE=false CI=true TMPDIR=$HOME/mdev-tmp`.
  Org sessions inject variables that silently change monomind's own behavior
  (issue #249).
- Never write under /tmp: it is a RAM tmpfs with a per-user quota, and filling it
  breaks every shell.
- SCRATCH: files you need to Read/Write/Edit with the file tools go in
  `REPO/.monomind/orgs/monomind-dev/scratch/<item-id>-<check>` (the file tools
  cannot reach paths outside the repo, issue #303). Sample projects that
  monograph must watch, and fake HOMEs, go in `$HOME/mdev-tmp/<item-id>-<check>`
  and are handled with Bash only (no dot-directories there: monograph's watcher
  ignores dot-segment paths).

## Git
- Never run `git config` in any checkout of this repo (worktrees share
  .git/config; issue #250).
- NEVER use `git stash` in any form: the stash stack is shared by every worktree
  and the owner has entries on it (issue #300). Use `git diff > $SCRATCH/x.patch`
  + `git apply -R`, or a scratch worktree at the base SHA.
- Known policy gaps (#299): at policy.git read, `merge-base`, `ls-remote`,
  `show-ref`, `reflog` are denied — use `git diff main...HEAD` /
  `git log main..HEAD` instead.
- Commit only with
  `GIT_AUTHOR_NAME=nokhodian GIT_AUTHOR_EMAIL=nokhodian@gmail.com GIT_COMMITTER_NAME=nokhodian GIT_COMMITTER_EMAIL=nokhodian@gmail.com git commit`
  using conventional commits (when it resolves an issue, put `Fixes #N` in the
  body; a bare `(#N)` leaves the issue open), and NO trailers (no
  Co-Authored-By, Claude-Session or 'Generated with').
- Stage explicit paths, never `git add -A` / `git add .`.
- Never push, never touch origin, npm or GitHub.

## Evidence
- Every claim is backed by a log under `RUN/logs/<role>/<item-id>-<check>.log`
  produced in THIS run, with the SHA it ran against.
- Report each check as {name, command, exit_code, PASS|FAIL|SKIP|FLAKY, log path,
  one-line evidence}. SKIP needs the exact error proving the check is impossible;
  never call a failure 'environmental' or 'pre-existing' without reproducing it
  on main.
- Finish every task with `org_task_done`, putting that table in the result.
  This org requires EVIDENCE: pass `evidence` = { `headSha`: the commit your
  checks ran on (`git -C <dir> rev-parse HEAD`), `worktree`: the item's WT when
  the work is on an item (omit it only for work on REPO itself, such as triage
  or the final report), `checks`: one { command, exitCode, output } per
  acceptance criterion — the real command, its real exit code, the tail of its
  output }. When the correct outcome is a non-zero exit, add `expectExit: <code>`
  to that check plus a one-line `expectReason` saying why ("404 = branch not
  protected") — never append `|| true`, and `expectExit` without a reason is
  refused. `expectExit` is for SINGLE-PURPOSE commands only: it is refused on a
  test suite or any aggregate runner (`vitest`, `jest`, a `pnpm`/`npm`/`yarn`
  test script, `node --test`, `pnpm -r`, `pnpm --filter … test`, `run verify`,
  `test:all`), because a suite's exit code means "at least one of many things
  failed" and accepting it accepts every OTHER failure too. With one
  known-failing test, run that file alone (`npx vitest run path/to/one.test.ts`)
  and declare `expectExit` on THAT check, or exclude it so the suite exits 0 and
  record the exclusion in the result. A check that misses its expected exit
  or a sha that is no longer that worktree's HEAD is refused; after 3 refusals the task is failed and escalated to dev-lead. A task
  with nothing to run (a verdict, a plan) still names the command that proves
  it — e.g. `test -s <plan or verdict path>`, or `head -1 <verdict file>`.
- The evidence proves the task was done, not that the item is good: a FAIL,
  REJECT, REVISE or DROP verdict is a completed task. Its evidence checks are
  the commands that prove the verdict file exists and names the SHA; the failing
  commands and their exit codes go in the result's check table.

## Independent tests
- test-author creates WT (`git -C REPO worktree add -b dev/<item-id> WT main`)
  and, before BUILD, commits the item's failing tests in ONE commit that touches
  only test files, fixtures and test helpers. It writes
  `RUN/evidence/<item-id>-tests.md`: line 1 `TESTS: <full SHA of that commit>`
  (or `TESTS: none — <reason>` when nothing can be tested automatically), then
  one `- <path>` line per file of that commit (the PROTECTED paths), then per
  acceptance criterion the test that covers it (or `manual: <why>`) and the log
  of its failing run.
- Protected paths are read-only for every other role. Developers make those
  tests pass and may ADD tests in other files, but never edit, rename or delete
  a protected path. A developer who finds one wrong stops and reports it with
  evidence; only a test-author TESTS revision changes it (a new commit, and
  tests.md names the new SHA and paths).
- TEST INTEGRITY (verifier's ITEM VERIFY, integrator's MERGE GATE): with T the
  SHA on line 1 and P the protected paths,
  `git -C WT log --format=%H main..HEAD | grep -qx T` (T is on the branch) and
  `git -C WT diff --name-only T..HEAD -- P` prints nothing. Otherwise it is a
  FAIL (verifier) or a REFUSE (integrator) naming the changed path. `TESTS: none`
  passes trivially.

## Lessons across runs
Org memory persists across runs of this org (`org_remember` writes it,
`org_recall` searches it). Lessons are how a finding in one run stops the same
mistake in the next.
- RECORD (dev-lead): for every FAIL (verifier), REJECT (reviewer) and REVISE
  (product-evaluator) finding, distill ONE short reusable rule — what to do next
  time, not what went wrong in this item; at most two sentences; name the AREA
  (the package or subsystem, e.g. `orgrt`, `monograph`, `cli init`, `skills`).
  First `org_recall` with `lesson <area> <key words>`; if a lesson already says
  it, do not store a reworded copy. Otherwise `org_remember` with scope `org`
  and content `lesson: [<area>] <rule> (<run-id>/<item-id>, <role> <verdict>)`.
  Also append that line to `RUN/lessons.md`, this run's list.
- APPLY (architect, test-author, developer-1, developer-2): at the start of
  every task, `org_recall` with `lesson <area>` for each area the task touches
  (from the plan or the task message) and apply the lessons that fit. Name the
  ones you applied in your `org_task_done` result, one line each. A lesson
  never overrides the task message, the plan or these rules; when one
  conflicts, follow those and say so in the result.
- PROPOSE (dev-lead, at FINISH): REPORT.md gets a `## Lessons` section listing
  every line of `RUN/lessons.md`, then the lessons you PROPOSE as permanent
  rules for this skill, each with the exact sentence and the section it belongs
  in. Never edit this skill or an org config yourself: the owner decides.

## Destructive commands
- `cleanup` (any variant), `init --force`, recursive deletes, `git clean`,
  `git reset --hard` and anything else that deletes or overwrites files run ONLY
  inside the item's WT or a scratch dir you created, with `cd` into it in the
  SAME command and a `pwd` check first. Never in REPO: on 2026-09-22
  `cleanup --force` run from the main checkout deleted 1003 tracked files and
  the project's memory store.

## Build, lint and test traps
- LINT: `pnpm run lint` from a worktree under .monomind/ silently checks 0 files
  (issue #297) — run `npx biome check packages tests scripts` and treat any
  output that does not report >1000 checked files as a FAIL.
- BUILD: if tsgo dies on a signal (SIGSEGV, not a TypeScript error), rerun that
  build once and log both; never copy dist/ from another checkout.
- BASELINE: the org's git guard env makes 17 git-config tests fail inside roles
  (issue #298: @monoes/monograph hooks-marker/hooks-install/hooks-status,
  role-sandbox.test.ts excludesFile) — a failure is a regression only if it is
  not in the verifier's baseline taken in the same role environment.

## Working style
- BREVITY: messages to other roles are instructions and evidence, not essays —
  at most ~20 lines plus log paths. Findings about the milestone go in the
  ledger entry, not in prose.
- Use monograph first for code navigation (monograph_suggest /
  monograph_context / monograph_impact), grep only as a fallback.
- Keep files under 500 lines. Follow the repo's CLAUDE.md coding principles:
  surgical changes, no speculative features, match surrounding style.

## Unattended
- After dev-lead's PREFLIGHT nobody asks the human anything:
  org_gate is denied for every role, and ask_human for every role except
  dev-lead, which may use it only during PREFLIGHT.
