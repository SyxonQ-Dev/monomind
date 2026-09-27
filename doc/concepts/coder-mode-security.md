# Coder Mode: Threat Model & Guardrails

> Part of the **Coder mode** epic ([#364](https://github.com/monoes/monomind/issues/364)) — a
> Claude Code session with full, automated, unrestricted access to the machine, driven through
> `monomind agent exec --access full` instead of a direct `claude` spawn. This document is the
> threat model and guardrail record required by
> [#360](https://github.com/monoes/monomind/issues/360), refined against what was actually built
> in [#355](https://github.com/monoes/monomind/issues/355) (`--access full`),
> [#356](https://github.com/monoes/monomind/issues/356) (`--settings`), and
> [#357](https://github.com/monoes/monomind/issues/357) (`tool_activity`). See
> [`doc/agent-exec-protocol.md`](../agent-exec-protocol.md) §3.1/§3.2 for the wire protocol these
> guardrails sit on top of.

## 1. Threat model

Coder mode is **full access by design**: the user explicitly wants the agent to run any command
and read/write any file with no approval prompts. The user is therefore **not** the adversary.
The risk is **untrusted content steering the agent** (prompt injection) into doing something the
user never asked for, now with a real, unrestricted shell.

| Source of untrusted text | Present in coder mode? | Mitigation |
|---|---|---|
| mono-agent synced messages / DMs / emails / social content (`get_message`, `list_messages`, people notes, …) | **Must not be.** | monomind has no such tool surface at all — there is nothing in this repo to wire in. The guarantee is enforced on mono-agent's side (never handing a coder-mode turn its communications/people tools — monoes/mono-agent#202/#203). Same reason `run_workflow` is locked after any message read in scoped chat. |
| Web pages (`WebFetch`/`WebSearch`, native SDK tools) | Yes, in `--access full` mode. | Accepted risk, identical to running interactive Claude Code with `--dangerously-skip-permissions`. Every native tool call — including `WebFetch` — is still observed via `tool_activity` (§3, below), so a caller can show/log what a fetched page caused the agent to do next. Not blocked; documented as residual risk (§4). |
| Files in the working folder (a cloned third-party repo's own `README`/`CLAUDE.md`/`AGENTS.md`/`.claude/settings.json`) | Yes, when the turn also opts into `--settings project` (or `user`/`local`). | Accepted, with a sharper edge than the original issue's table: `--settings project` doesn't just let the model *read* a repo's `CLAUDE.md` as ordinary file content — the Claude Code SDK's own settings discovery **loads and executes** that repo's `.claude/settings.json` hooks (`PreToolUse`/`PostToolUse`/etc.) as real, code-level hooks (see §4's residual-risk entry). `--settings none` (the default) never discovers or runs anything from the target directory. |
| Other agents' output (subagents, org bus) | Its own `Task` subagents only; in orgs, messages from other roles (for roles granted full access under #365). | Chat coder mode is not exposed as a workflow node, MCP tool, or extension action anywhere in monomind (verified — see §3). Org roles may opt in to full access per role under #365, with the taint checks that issue defines (a full-access role must not itself read untrusted input; a role that does must not hand off to one). |

## 2. Guardrails implemented (monomind side)

### 2.1 No transitive escalation — full access is human-CLI-only

`access: 'full'` can only ever originate from a **human-typed** `agent exec --access full`
invocation, parsed in [`commands/agent-exec.ts`](../../packages/@monomind/cli/src/commands/agent-exec.ts)
(`ctx.flags.access`). From there it flows through exactly one path:
`AgentExecOptions.access` → `orgrt/agent-exec.ts`'s `resolveAccess()`/`checkFullAccessGuards()`
([`orgrt/agent-exec-access.ts`](../../packages/@monomind/cli/src/orgrt/agent-exec-access.ts)) →
`AgentRunArgs.access` → `ClaudeAgentRunner.run()`'s strict `args.access === 'full'` check
([`orgrt/agent-runner-claude.ts`](../../packages/@monomind/cli/src/orgrt/agent-runner-claude.ts)),
which is the only place `permissionMode: 'bypassPermissions'` +
`allowDangerouslySkipPermissions: true` get set.

Audited (by direct source inspection, and pinned by regression tests in
`agent-exec-no-transitive-escalation.test.ts` so a future change fails loudly):

| Reachable-by-an-agent path | Status today | Guard |
|---|---|---|
| `monomind mcp exec -t <tool>` (generic "run an MCP tool" CLI/MCP surface, [`commands/mcp-tool-commands.ts`](../../packages/@monomind/cli/src/commands/mcp-tool-commands.ts)) | **Cannot reach it.** `mcp exec` only dispatches to tools registered under `src/mcp-tools/**`/`src/mcp/**`; none of those ~90 tool modules import the agent-exec engine (`orgrt/agent-exec.ts`), `resolveExecRunner`, or `runAgentExec` — verified by a source scan test. There is no `agent_exec`-shaped MCP tool to call in the first place. | Structural: nothing to strip, because the surface doesn't exist. Regression-tested. |
| `agent_spawn`/other `agent_*` MCP tools ([`mcp-tools/agent-tools-lifecycle.ts`](../../packages/@monomind/cli/src/mcp-tools/agent-tools-lifecycle.ts)) | **Unrelated surface.** These are the swarm bookkeeping tools (agent records in a JSON store) — they never call `runAgentExec`/`resolveExecRunner` and have no `access` concept at all. | N/A — different subsystem entirely. |
| Org runtime (`orgrt/session.ts` → `session-stream.ts`'s `sessionRunArgs`, driving every org role's turn) | **Only through the #365 grant gate.** `sessionRunArgs` sets `access: 'full'` only when the session's `resolvedAccess` is `'full'`, and `resolvedAccess` comes only from `access-grant.ts`'s `resolveRoleAccess` (called in `session-full-access.ts`), which requires a human `access_ack` whose HMAC `sig` verifies and whose config hash has not drifted. Anything else — no grant, a forged or copied grant, a drifted config, a runtime without full access support — runs scoped (`permissionMode: 'default'`). Regression tests pin both the single `access:` key in `sessionRunArgs` and its only source. | Signed grant (#365) + regression test. |
| `RolePolicySchema` ([`orgrt/types-policy.ts`](../../packages/@monomind/cli/src/orgrt/types-policy.ts)) | **Declares, never grants.** `policy.access: 'full'` is a real schema field since #365, but on its own it does nothing: without a valid `access_ack` the role runs scoped with state `suspended`, emits a `full-access-not-active` audit event, and `org validate` reports it. | Runtime backstop (#365). |
| Workflow/routine nodes | **No such node exists.** There is no workflow-script or routine primitive anywhere in this codebase that shells out to `monomind agent exec` or imports the agent-exec engine (verified by the same source scan — no `src/**` file outside `commands/agent-exec.ts` and its own tests calls `runAgentExec`). | Structural. |
| Local dashboard / extension UI server routes (`src/ui/server-routes-*.mjs`, `src/ui/routes-org-*.mjs`) | **No route touches it.** None of the ~35 UI route modules reference `orgrt/agent-exec`, `resolveExecRunner`, or `runAgentExec` — verified by source scan. Coder mode is deliberately **not** an extension action (epic #364, "out of scope v1"). | Structural. |
| Hooks (`hooks-*.ts` lifecycle hooks, filesystem `PreToolUse`/etc. hooks a project or `--settings` load installs) | A hook can run arbitrary code as a **side effect** of a tool call (that's what a hook is), including inside a coder-mode turn itself once one is already running under `--access full` — but a hook cannot **initiate** a new `agent exec --access full` invocation with escalated access; it has no privileged entry point into `resolveAccess`/`checkFullAccessGuards` that a plain `agent exec --access full` typed by a human doesn't also have to go through. | Same guard as "any process on this machine can run `monomind agent exec --access full` if a human decided to let it" — see §2.2. |
| Any org write path — org MCP tools, `create-json`, `import`/`okf-import`, runtime role hiring, or an agent editing the org JSON directly | **Can write the config, cannot make it run with full access.** These paths are not individually filtered; the runtime is the backstop. A role written with `policy.access: 'full'` (and even a copied or hand-written `access_ack`) runs scoped unless `sig` verifies under the machine-local key in the operator-credential directory, which sandboxed roles are denied Read/Edit on. The only command that writes a valid grant, `org role set-access <org> <role> full`, refuses in any agent context (`CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `MONOMIND_ORG_ROLE`, `MONOMIND_SDK_AGENT`, `MONOMIND_AGENT_EXEC`), even with `--yes-i-understand`. | HMAC-signed human grant + agent-context refusal (#365). |

**A note on "a script/process could just run the CLI itself":** guardrail 1 is about
monomind not *handing* full access to something that only has agent-level (tool-call) reach —
it is not, and cannot be, a defense against a human explicitly scripting
`agent exec --access full` themselves (e.g. a cron job, a Makefile target) any more than a
human can be stopped from running `claude --dangerously-skip-permissions` directly today. That is
the accepted, intended trust boundary (§1): the human who typed or scheduled the invocation is
not the adversary.

### 2.2 Guards inside `checkFullAccessGuards` (regardless of what a caller already validated)

Implemented in [`orgrt/agent-exec-access.ts`](../../packages/@monomind/cli/src/orgrt/agent-exec-access.ts),
run unconditionally by `orgrt/agent-exec.ts` before a full-access turn is allowed to start —
tested in `agent-exec.test.ts`'s `"agent exec: --access full"` suite:

- **Root refusal**: refuses `--access full` when `process.getuid?.() === 0`, the same restriction
  Claude Code itself applies to `bypassPermissions` — `error {code:"unsafe", fatal:true}` instead
  of an opaque runner failure.
- **Explicit, validated `--cwd`**: required (no silent inherit-the-caller's-cwd), must exist, must
  be a directory — `error {code:"unsafe"}` otherwise.
- **Runtime allowlist**: only a `RunnerSpec` with `supportsFullAccess: true` may run full access —
  today that is `claude` alone (`orgrt/runner-registry.ts`'s `RUNNER_SPECS`, pinned by a regression
  test in this issue's test suite). Every other of the 14 runtimes gets
  `error {code:"unsupported", fatal:true}`, never a silent scoped fallback (guardrail 5, below).
- **No silent downgrade/upgrade**: `access` is resolved once, before the runner ever starts, and
  is reported honestly on the `start` event (`access: "scoped"|"full"`) — a runtime that can't
  do what was asked fails loudly rather than quietly running the other mode.

### 2.3 Env hygiene

Guardrail requirement (#360): "monomind doesn't *add* anything sensitive to the full-access child
env beyond what the caller passed."

`agent exec` (both `scoped` and `full` — this is not access-mode-specific) sets
`envAuthoritative: false` when calling `runner.run()`
([`orgrt/agent-exec.ts`](../../packages/@monomind/cli/src/orgrt/agent-exec.ts), the `o-18` comment
at the `env:` field). `ClaudeAgentRunner` then builds the child's env as:

```
env: args.envAuthoritative === false
  ? { ...process.env, ...args.env }
  : { ...omitAnthropicManagedKeys(process.env), ...args.env }
```

For `agent exec`, that's the first branch: the **exact same `process.env`** monomind's own process
already has (HOME/PATH/USER/keychain-backed Claude credentials, and — deliberately, per the
`o-18` comment in `agent-runner-claude.ts` — an ambient `ANTHROPIC_API_KEY`/`BASE_URL`/`AUTH_TOKEN`
if the invoking shell had one) is reconstructed and merged with `--env KEY=V` overrides the caller
passed. Nothing is *added*: `{...process.env, ...args.env}` cannot introduce a key that
wasn't already in one of those two sources, and the child would have inherited `process.env`
under Node's own default spawn behavior regardless. `--env` values are the caller's
responsibility (mono-agent must not pass vault secrets into a coder-mode turn — tracked in
monoes/mono-agent#202/#203, out of monomind's scope). `omitAnthropicManagedKeys` — used by every
**other** caller (the org runtime, every non-`agent-exec` runner invocation) — is unchanged by
this epic; `agent exec`'s opt-out of it predates and is orthogonal to `--access full`.

This exact boundary — ambient `ANTHROPIC_API_KEY` reaching (or not reaching) the spawned child,
`--env`/explicit values always winning, HOME/USER/PATH always inherited — is covered by
`packages/@monomind/cli/__tests__/orgrt/env-boundary.test.ts`'s
`"agent-runner (Claude) — same boundary, no working reference implementation"` suite, specifically
the case `'is present when a caller explicitly opts out (envAuthoritative: false — agent-exec.ts's
documented case)'`. No new seam was found that needed a new test for this issue: `--access full`
does not touch env construction at all (`args.access` and `args.envAuthoritative` are independent
fields), so the existing coverage already exercises the exact code path a full-access turn runs.

### 2.4 Audit trail

Every `tool_activity` event (§3.2 of the protocol doc) is the caller's own live audit log — the
caller (e.g. mono-agent) is expected to journal it. As a backstop independent of that journal,
`orgrt/agent-exec.ts` calls
[`appendFullAccessAudit`](../../packages/@monomind/cli/src/orgrt/full-access-audit.ts) exactly
once per `--access full` turn, at the single `finish(exitCode)` chokepoint every exit path
(success, error, timeout, cancelled, budget) funnels through — **never for `scoped` access**.
Each line is one JSON object appended to `~/.monomind/logs/agent-exec-full-access.log`
(override: `MONOMIND_FULL_ACCESS_LOG`, used by tests):

```json
{"ts":"2026-09-28T00:12:03.456Z","cwd":"/home/user/scratch/coder-1","runtime":"claude","sessionId":"sess_abc","exitCode":0,"toolCalls":14}
```

- `ts` — turn-end ISO timestamp.
- `cwd`, `runtime` — from the resolved `AgentExecOptions`.
- `sessionId` — the runner's own session id once known (omitted if the turn never reached one,
  e.g. cancelled before the first message).
- `exitCode` — the protocol exit code (§3.2: `0`/`1`/`124`/`130`).
- `toolCalls` — the number of native `tool_activity` **start** events observed this turn
  (`ToolActivityTracker.toolCallCount`, `orgrt/tool-activity.ts`) — i.e. how many native tool
  calls (Bash, Edit, Write, Read, …) the agent actually made, not merely how many were requested.
- `org`/`role` — reserved for full-access org roles (#365); unset for `agent exec`.

The write is **best effort by design** (`full-access-audit.ts`'s own doc comment): a failure to
write the log (disk full, permissions) never fails or blocks the turn — the live `tool_activity`
stream remains the primary, real-time audit trail; this file is the backstop for when a caller's
own journal is lost.

### 2.5 No silent downgrade/upgrade

Covered by §2.2's runtime allowlist and root/`--cwd` guards: a request that can't be honored as
asked fails with a fatal `error` + `done`, never silently substituting `scoped` for a caller who
asked for `full` (they'd believe they had full access and didn't) or vice versa.

## 3. What callers own (not monomind's job)

- **mono-agent's coder-mode gating**: off by default, a risk-confirmation dialog before first use,
  mode fixed per conversation, local-only, and critically — **never wiring its own
  communications/people/message tools into a coder-mode turn's tool surface**
  (monoes/mono-agent#202/#203). monomind has no way to enforce this from its side; it has no
  visibility into what tools a caller decides to bridge over `--tools stdio`.
- **`--env` hygiene**: not passing vault secrets or other credentials a coder-mode turn doesn't
  need. monomind passes `--env` values through unfiltered by design (they're the caller's explicit,
  human-reviewable request).
- **Not pointing coder mode at untrusted repos**: the UI-level warning ("don't run coder mode
  against a repo you don't trust, especially with `--settings project`") is a caller/product
  responsibility; monomind's part is limited to making the risk visible and documented (§1, §4).
- **Org-role opt-in (#365)**: granting `policy.access: "full"` to an org role is a human decision
  made with `monomind org role set-access`; the grant flow, drift suspension, taint checks and
  unattended-run gating are documented in [`org-runtime.md`](org-runtime.md) ("Full access"),
  layered on top of the guardrails in §2 of this document.

## 4. Residual risks (accepted, not mitigated further by this issue)

These are known, accepted trade-offs of "full access by design" (§1) — listed explicitly so they
are never mistaken for oversights:

- **`WebFetch`/`WebSearch` under `--access full`**: a fetched page can contain instructions the
  model may act on with a real, unrestricted shell — identical to interactive Claude Code with
  `--dangerously-skip-permissions`. Mitigation is observability only: every native tool call
  (including the fetch itself and whatever the model does next) is a `tool_activity` event on the
  caller's stream and, being a native tool call, counts toward the full-access audit log's
  `toolCalls` field. There is no content-level filtering of fetched pages.
- **A repo's own `CLAUDE.md`/`AGENTS.md`/hooks, loaded by `--settings project`**: this is not
  passive text — `--settings project` (or `user`/`local`) makes the Claude Code SDK's own settings
  discovery load and **execute** that repo's `.claude/settings.json` hooks
  (`PreToolUse`/`PostToolUse`/etc.) as real, code-level hooks for the remainder of the turn
  (`orgrt/agent-runner-claude-settings.ts`'s doc comment: "the user's own `PreToolUse` hooks …
  **will** run on coder-mode turns," carried over verbatim from #356). A malicious repo's hook
  runs with the same unrestricted access the turn already has. `--settings none` (the default)
  never discovers or runs anything from the target directory — this risk exists only when a
  caller explicitly opts into `--settings project`/`user`/`local` on top of `--access full`.
- **Ambient environment inheritance** (§2.3): an already-authenticated shell's `ANTHROPIC_API_KEY`
  (or other exported secrets not stripped by `omitAnthropicManagedKeys`, since `agent exec` opts
  out of that helper) is available to the full-access child exactly as it would be to any command
  the invoking human could already run directly in that shell. Not a new exposure created by
  coder mode — the same shell session could always do this — but worth naming since `agent exec`'s
  env-authoritative opt-out is easy to miss when reasoning about this feature in isolation.
- **`Task` subagents**: a coder-mode turn's own subagent calls run with the same `--access full`
  permissions (there is no narrower policy to hand a subagent in this mode) and are only visible
  as `tool_activity` events with `parent_tool_use_id` set — there is no separate approval or
  scoping layer between a top-level turn and its own subagents.
- **No mid-turn kill of a wedged process tree** — tracked separately as #359 (out of this issue's
  scope): `--timeout`/cancel/budget terminate the immediate child and race a grace window, but a
  full-access turn that spawned its own long-lived background processes (e.g. `nohup`'d a server)
  is #359's problem to solve, not #360's.

## 5. Security review of this diff (#360 acceptance criterion)

The full Coder-mode diff (`git diff main...HEAD` at the time of this issue: `--access full`
(#355), `--settings` (#356), `tool_activity` (#357), headless `init` (#358)) was reviewed with a
security lens for injection, escalation, path handling, and env leaks:

- **Scoped-mode Bash allowlist (`agent-exec-shell-syntax.ts`'s `hasUnsafeShellSyntax`)** — unaffected
  by this epic (`--access full` explicitly *rejects* `--allow-bash-prefix` rather than reusing this
  scanner), but reviewed since it sits in the same file family: correctly tracks single/double-quote
  state and backslash-escaping before checking for `;`/`&`/`|`/backtick/`$(`/`<`/`>`, including the
  documented `\'; touch /tmp/PWNED` backslash-escape bypass class. No issue found.
- **`--cwd`/`--project` path handling** (`agent-exec-access.ts`'s `checkFullAccessGuards`,
  `init-action.ts`'s `--project` resolution): both resolve the caller-supplied path with
  `path.resolve`/`statSync` against the existing filesystem and reject a missing/non-directory
  target; neither does any shell interpolation with the path. No path-traversal-into-execution
  issue — a caller directing monomind at an arbitrary absolute directory is the feature (§1: "scope
  is anywhere on disk"), not a bug.
- **The scoped/default path stays byte-identical**: `access` undefined/`'scoped'`,
  `settingSources` empty, and the tool_activity tracker's behavior with no native tool signal are
  all proven by existing snapshot/regression tests (`agent-exec-access-flags.test.ts`,
  `agent-runner-claude-settings-sdk.test.ts`, `tool-activity.test.ts`) — re-verified as part of
  this review by re-running the full CLI suite.
- **No new escalation path was found** beyond the ones already named and closed structurally in
  §2.1 — see that section's table for exactly what was checked and how.
- **Nothing required a code fix** during this review; the residual risks in §4 are by-design
  trade-offs of "full access," not defects.
