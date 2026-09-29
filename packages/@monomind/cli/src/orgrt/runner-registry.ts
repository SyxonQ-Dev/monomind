// packages/@monomind/cli/src/orgrt/runner-registry.ts
/**
 * Runner registry — static metadata for every AgentRunner runtime id:
 * binary name, env-var override, install hint. Shared by `agent exec`
 * (error taxonomy: no-runner vs missing-binary, §3.4) and `agent scan`
 * (installed detection + version probe, §6) of doc/agent-exec-protocol.md.
 *
 * Binary names and env overrides MUST mirror the `<X>_CLI_BIN` lookups in
 * each orgrt/*-runner.ts — a mismatch here means scan reports a runner as
 * installed when its runner would spawn a different binary (or vice versa).
 */

import * as fs from 'node:fs';
import { delimiter, join } from 'node:path';
import type { AgentRunner } from './agent-runner.js';
import { type RuntimeKind, resolveRunner } from './daemon.js';
import { RUNNER_FEATURES, type RunnerFeatures } from './runner-features.js';
import { detectVersion, type VersionSource } from './version-probe.js';

export interface RunnerSpec extends RunnerFeatures {
  /** Runtime id accepted by `agent exec --runtime` and org role `runtime`. */
  id: RuntimeKind;
  /** Binary probed on PATH (null for in-process runtimes like vercel). */
  binary: string | null;
  /** Env var that overrides the binary path (mirrors each runner's lookup). */
  binEnv?: string;
  /** One-line install hint, shown by scan and the missing-binary error. */
  installHint: string;
  /** Login/auth command appended to auth-class errors (§3.4 auth code). */
  loginHint?: string;
  /**
   * Whether this runner delivers real incremental (per-token/per-chunk)
   * `assistant` text as a turn streams, vs. only ever yielding a complete
   * message at a step/turn boundary. Callers (agent scan --json §6, the
   * `start` frame's `streams_incrementally` field §3.2) use this to set
   * the end user's expectations honestly instead of a live UI implying a
   * hang during a turn that was never going to show partial output.
   *
   * See doc/agent-exec-protocol.md's "Adding a new AgentRunner" section
   * for the checklist a new runner should follow to decide and wire this.
   */
  streamsIncrementally: boolean;
  /**
   * #355: whether `agent exec --access full` (unrestricted native tool
   * access, no approvals, no CLI sandbox) is implemented for this runtime.
   * Rev 13: every coding runtime (claude, codex, opencode, antigravity,
   * kimicode, grok, qwen, copilot, crush, pi); the rest (vercel — no native
   * tools; hermes, qwen-rpc, pi-rpc — no resume/tool events, duplicates of
   * their CLI sibling) reject `--access full` with `error
   * {code:"unsupported", fatal:true}` rather than silently running scoped.
   * Discoverable via `agent scan --json`'s `full_access` field.
   */
  supportsFullAccess: boolean;
  /**
   * #357: how faithfully this runner's AgentMessage stream can be turned
   * into `tool_activity` start/end pairs (doc §3.2/§9) — `"full"` (real
   * tool_use id, input, and a matched end from a real tool_result),
   * `"start-only"` (a lightweight `{type:'tool_use', text: toolName}`
   * liveness signal with no id to correlate an end with), or `"none"` (no
   * tool signal surfaces in this runner's AgentMessage stream at all today).
   */
  toolActivityFidelity: 'full' | 'start-only' | 'none';
}

const BASE_SPECS: Array<Omit<RunnerSpec, keyof RunnerFeatures>> = [
  {
    id: 'claude',
    binary: 'claude', // SDK locates its own CLI; PATH probe is best-effort
    installHint: 'npm install -g @anthropic-ai/claude-code',
    loginHint: 'claude login',
    // Real per-token streaming via the SDK's `includePartialMessages`,
    // opted into only for this protocol's own caller (agent-exec.ts) —
    // see agent-runner.ts's `streamPartials` for why it's opt-in rather
    // than always-on. Live-verified against the SDK: content_block_delta
    // events with text_delta arrive per-token, and the complete message
    // still follows with full content/usage.
    streamsIncrementally: true,
    supportsFullAccess: true, // #355
    // #357: real tool_use id/input via ClaudeAgentRunner's own richer
    // 'tool_use' AgentMessage, matched to a real tool_result end.
    toolActivityFidelity: 'full',
  },
  {
    id: 'codex',
    binary: 'codex',
    binEnv: 'CODEX_CLI_BIN',
    installHint: 'npm install -g @openai/codex',
    loginHint: 'codex login',
    // Hard protocol limitation, not a monomind gap: codex's own event set
    // has no delta field at all — confirmed via its documented event enum
    // (codex-runner.ts header) — only whole `item.completed` messages.
    // The runner already yields each one the instant it lands.
    streamsIncrementally: false,
    supportsFullAccess: true,
    // Rev 13: the runner yields id-carrying tool_use + matched tool_result
    // from the CLI's own tool start/complete events.
    toolActivityFidelity: 'full',
  },
  {
    id: 'kimicode',
    binary: 'kimi',
    binEnv: 'KIMI_CLI_BIN',
    installHint: 'install the Kimi Code CLI (kimi) from Moonshot and log in',
    loginHint: 'kimi (interactive first run)',
    // Whole messages only in the version this was verified against
    // (kimicode-runner.ts header, kimi 0.29.2) — moderate confidence, not
    // a live byte-verified spec like codex/qwen/pi below. A newer
    // installed binary hints at an internal "assistant.delta" event of
    // unconfirmed reach into `--output-format stream-json`; worth
    // re-checking before ruling this out permanently.
    streamsIncrementally: false,
    supportsFullAccess: true,
    // Rev 13: the runner yields id-carrying tool_use + matched tool_result
    // from the CLI's own tool start/complete events.
    toolActivityFidelity: 'full',
  },
  {
    id: 'opencode',
    binary: 'opencode',
    binEnv: 'OPENCODE_BIN',
    installHint: 'npm install -g opencode-ai',
    // Real per-token streaming, switched from a blocking session.prompt()
    // call to session.promptAsync() + client.event.subscribe(). Live-verified
    // against a real opencode server (v1.18.30): the actual per-token event
    // is `message.part.delta` — NOT in the installed SDK's own .d.ts at all
    // (only message.part.updated is, whose own `delta` field was observed
    // to always be undefined live). See opencode-runner.ts's header for the
    // full live-verified event shapes and a real bug this live testing
    // caught (the echoed user prompt leaking out as a fake assistant
    // message) before it could ship. Opt-in via
    // AgentRunArgs.extras.includePartialMessages (agent-exec.ts sets it,
    // session.ts does not) — same reasoning as every other subprocess
    // runner: session.ts wants one AgentMessage per text part regardless
    // of which runner backs the role.
    streamsIncrementally: true,
    supportsFullAccess: true,
    // Rev 13: the runner yields id-carrying tool_use + matched tool_result
    // from the CLI's own tool start/complete events.
    toolActivityFidelity: 'full',
  },
  {
    id: 'vercel',
    binary: null, // in-process via the npm `ai` package
    installHint: 'npm install ai (plus the vendor model package)',
    // Real per-token streaming: vercel-runner.ts consumes the `ai` SDK's
    // `result.fullStream` and yields each real `text-delta` part as it
    // arrives (verified against the installed `ai` package's own types).
    streamsIncrementally: true,
    supportsFullAccess: false,
    // #357: vercel-runner.ts never yields a 'tool_use' AgentMessage at all
    // today — no tool signal to map to tool_activity.
    toolActivityFidelity: 'none',
  },
  {
    id: 'antigravity',
    binary: 'agy',
    binEnv: 'ANTIGRAVITY_CLI_BIN',
    installHint: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
    loginHint: 'agy (interactive login)',
    // Real per-token streaming via `agy --output-format stream-json`'s
    // text_delta events, fence-safely buffered by computeSafeChunk/
    // emitVisible/flushText — the reference implementation for a runner
    // whose underlying protocol needs fence-boundary awareness. Live
    // end-to-end verified: multiple incremental NDJSON lines per turn.
    // Opt-in via AgentRunArgs.extras.includePartialMessages (agent-exec.ts
    // sets it; session.ts, the org runtime, does not) — same reasoning as
    // `claude` below: session.ts wants one complete AgentMessage per step
    // for its chat-bus/state-detector, regardless of which runner backs it.
    streamsIncrementally: true,
    supportsFullAccess: true,
    // Rev 13: the runner yields id-carrying tool_use + matched tool_result
    // from the CLI's own tool start/complete events.
    toolActivityFidelity: 'full',
  },
  {
    id: 'grok',
    binary: 'grok',
    binEnv: 'GROK_CLI_BIN',
    installHint: 'install the Grok Build CLI per https://docs.x.ai/build/cli',
    loginHint: 'grok login',
    // Whole messages only with the flag grok-runner.ts currently passes
    // (`--output-format json`) — confirmed via its own event-shape parser,
    // which has no delta field. Its header flags an untested
    // `streaming-messages-json` mode (Anthropic Messages wire format) as a
    // possible source of real deltas — unconfirmed, left `false` until
    // verified live.
    streamsIncrementally: false,
    supportsFullAccess: true,
    // #357: yields a lightweight {type:'tool_use', text: toolName} liveness
    // signal with no id — best-effort, start-only tool_activity mapping.
    toolActivityFidelity: 'start-only',
  },
  {
    id: 'qwen',
    binary: 'qwen',
    binEnv: 'QWEN_CLI_BIN',
    installHint: 'npm install -g @qwen-code/qwen-code',
    loginHint: 'qwen (interactive first run)',
    // Hard protocol limitation, confirmed live: qwen-runner.ts's own
    // header states directly "qwen's stream-json sends whole messages per
    // event, not per-token deltas — confirmed live, #182".
    streamsIncrementally: false,
    supportsFullAccess: true,
    // #357: yields a lightweight {type:'tool_use', text: toolName} liveness
    // signal with no id — best-effort, start-only tool_activity mapping.
    toolActivityFidelity: 'start-only',
  },
  {
    id: 'qwen-rpc',
    binary: 'qwen',
    binEnv: 'QWEN_CLI_BIN',
    installHint: 'npm install -g @qwen-code/qwen-code',
    loginHint: 'qwen (interactive first run)',
    // Still false — same whole-message-per-event wire vocabulary as
    // `qwen` above, no per-token/per-chunk delta field to surface. This
    // runner USED TO also buffer every message across the WHOLE round and
    // yield once at the end when `result` fired, instead of yielding per
    // event the way its qwen-runner.ts sibling always did — fixed (each
    // `assistant` event now streams the instant it lands, fence-safely,
    // reusing antigravity-runner.ts's computeSafeChunk). That was a real
    // latency bug (a multi-internal-tool-round turn could sit silent for
    // the WHOLE round instead of showing "working on it" as soon as it
    // arrived) but is orthogonal to this flag: promptness at the wire
    // format's own whole-message granularity isn't per-token streaming —
    // see doc/agent-exec-protocol.md §9 step 3. Like every other subprocess
    // runner, the fix is opt-in via extras.includePartialMessages
    // (agent-exec.ts sets it, session.ts does not) — session.ts wants one
    // AgentMessage per round regardless of which runner backs the role.
    streamsIncrementally: false,
    supportsFullAccess: false,
    // #357: qwen-rpc-runner.ts never yields a 'tool_use' AgentMessage at
    // all today — no tool signal to map to tool_activity.
    toolActivityFidelity: 'none',
  },
  {
    id: 'crush',
    binary: 'crush',
    binEnv: 'CRUSH_CLI_BIN',
    installHint: 'install Crush per https://github.com/charmbracelet/crush',
    // No structured protocol at all — crush's `run` subcommand has no
    // documented JSON event stream, just plain text (crush-runner.ts
    // header). The runner already streams each line the instant it
    // arrives; there is no finer granularity available to request.
    streamsIncrementally: false,
    supportsFullAccess: true,
    // #357: yields a lightweight {type:'tool_use', text: toolName} liveness
    // signal with no id — best-effort, start-only tool_activity mapping.
    toolActivityFidelity: 'start-only',
  },
  {
    id: 'copilot',
    binary: 'copilot',
    binEnv: 'COPILOT_CLI_BIN',
    installHint: 'npm install -g @github/copilot',
    loginHint: 'copilot (interactive first run)',
    // Whole-message NDJSON per copilot-runner.ts's own header — but that
    // header also notes the protocol is sourced from public docs, "NOT
    // byte-verified" against the real CLI, so this is lower-confidence
    // than qwen/pi's live-confirmed `false`s. Worth re-checking live
    // before assuming it can never stream.
    streamsIncrementally: false,
    supportsFullAccess: true,
    // #357: yields a lightweight {type:'tool_use', text: toolName} liveness
    // signal with no id — best-effort, start-only tool_activity mapping.
    toolActivityFidelity: 'start-only',
  },
  {
    id: 'pi',
    binary: 'pi',
    binEnv: 'PI_CLI_BIN',
    installHint: 'npm install -g @mariozechner/pi-coding-agent',
    // Hard protocol limitation, confirmed live: pi-runner.ts's own header
    // states "pi sends whole messages, not per-token deltas — no
    // accumulation needed, unlike agy", verified against a live 0.73.1
    // binary.
    streamsIncrementally: false,
    supportsFullAccess: true,
    // #357: yields a lightweight {type:'tool_use', text: toolName} liveness
    // signal with no id — best-effort, start-only tool_activity mapping.
    toolActivityFidelity: 'start-only',
  },
  {
    id: 'pi-rpc',
    binary: 'pi',
    binEnv: 'PI_CLI_BIN',
    installHint: 'npm install -g @mariozechner/pi-coding-agent',
    // Real per-token streaming via message_update's assistantMessageEvent
    // text_delta (contentIndex-keyed, fence-safely buffered by
    // computeSafeChunk — same decouple-and-diff shape as
    // antigravity-runner.ts). Verified against docs/rpc.md bundled with the
    // installed pi package at the SAME version (0.73.1) this file's header
    // was already resolved against for agent_end — including the
    // text_delta wire example itself ("Hello" then " world", word-by-word).
    // Not independently live-tested end-to-end: no funded model credential
    // was available in the verifying environment (pi's own auth.json had no
    // configured provider) — a real live check is still worth doing before
    // fully trusting this the way antigravity/claude/opencode were.
    // Opt-in via AgentRunArgs.extras.includePartialMessages, same as every
    // other subprocess runner: session.ts never sets it.
    streamsIncrementally: true,
    supportsFullAccess: false,
    // #357: pi-rpc-runner.ts never yields a 'tool_use' AgentMessage at all
    // today — no tool signal to map to tool_activity.
    toolActivityFidelity: 'none',
  },
  {
    id: 'hermes',
    binary: 'hermes',
    binEnv: 'HERMES_CLI_BIN',
    installHint: 'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash',
    loginHint: 'hermes setup',
    // Live-verified (2026-09-14) against a real installed binary configured
    // with a free OpenRouter model — see hermes-runner.ts's header for the
    // full account, including two real bugs an earlier docs-only design had
    // (an invalid --usage-file flag on `chat`, and a leaked warning line on
    // stdout despite -Q). `chat --oneshot` is one-shot, whole-text-only — no
    // per-token delta mechanism, and no session-resume flag reachable from
    // it either (confirmed: --resume/--continue/-c all resume by session ID,
    // which only exists once a session has been created). hermes serve's
    // JSON-RPC/WebSocket gateway (the desktop app's transport) is the
    // plausible path to real streaming but has no published protocol/schema
    // doc found — revisit if one surfaces. See doc/agent-exec-protocol.md §9.
    streamsIncrementally: false,
    supportsFullAccess: false,
    // #357: hermes-runner.ts's own 'tool_use' yield is a single fixed
    // "turn started" placeholder ping, not a per-call tool name — no real
    // tool signal to map to tool_activity.
    toolActivityFidelity: 'none',
  },
];

export const RUNNER_SPECS: RunnerSpec[] = BASE_SPECS.map((s) => ({
  ...s,
  ...RUNNER_FEATURES[s.id],
}));

const SPEC_BY_ID = new Map(RUNNER_SPECS.map((s) => [s.id, s]));

export function runnerSpec(id: string): RunnerSpec | undefined {
  return SPEC_BY_ID.get(id as RuntimeKind);
}

export function isKnownRuntime(id: string): boolean {
  return SPEC_BY_ID.has(id as RuntimeKind);
}

/**
 * Resolve a runner for `agent exec --runtime <id>`.
 *
 * Distinct from daemon.ts's resolveRunner: unknown ids are a protocol
 * `no-runner` error (the id has no implementation), while 'claude' — for
 * which resolveRunner returns undefined as the implicit default path —
 * resolves to the shared defaultClaudeRunner. Dynamic import keeps the
 * Claude Agent SDK out of this module's static graph (scan must stay light).
 */
export async function resolveExecRunner(id: string): Promise<AgentRunner | null> {
  if (!isKnownRuntime(id)) return null;
  if (id === 'claude') {
    const { defaultClaudeRunner } = await import('./agent-runner.js');
    return defaultClaudeRunner;
  }
  return resolveRunner(id as RuntimeKind) ?? null;
}

// ─── scan (doc/agent-exec-protocol.md §6) ───────────────────────────────────

export interface ScanEntry {
  id: string;
  installed: boolean;
  binary: string | null;
  version: string | null;
  /** Where `version` came from; null when not installed (rev 11, #337). */
  version_source: VersionSource | null;
  install_hint: string;
  /** `install_hint` in a shape a caller can execute safely (rev 9). */
  install: InstallRecipe;
  /** The runtime's own sign-in command, when it has one (rev 9). */
  login_hint: string | null;
  /** Mirrors `RunnerSpec.streamsIncrementally` — see its doc comment. */
  streams_incrementally: boolean;
  /** #355. Mirrors `RunnerSpec.supportsFullAccess` — see its doc comment. */
  full_access: boolean;
  /** Mirrors `RunnerSpec.toolActivityFidelity` (#357) — see its doc comment. */
  tool_activity_fidelity: 'full' | 'start-only' | 'none';
  /** Rev 13 service flags — mirror `RunnerFeatures` (runner-features.ts). */
  resume: boolean;
  effort: boolean;
  max_turns: boolean;
  reports_cost: boolean;
  init_target: RunnerFeatures['initTarget'];
}

import { type InstallRecipe, installRecipe } from './runner-install-recipe.js';

export { type InstallRecipe, installRecipe };

/** Resolve a binary honoring the runner's `<X>_CLI_BIN` override. */
export function resolveBinary(spec: RunnerSpec, env: NodeJS.ProcessEnv): string | null {
  if (!spec.binary) return null;
  const overridden = spec.binEnv ? env[spec.binEnv] : undefined;
  return overridden?.trim() ? overridden : spec.binary;
}

/** Absolute binary path if findable on PATH (or the override if it exists). */
export function locateBinary(bin: string, env: NodeJS.ProcessEnv): string | null {
  if (bin.includes('/')) {
    // Explicit path (env override or absolute) — must exist and be executable.
    try {
      fs.accessSync(bin, fs.constants.X_OK);
      return bin;
    } catch {
      return null;
    }
  }
  const pathDirs = (env.PATH ?? '').split(delimiter);
  for (const dir of pathDirs) {
    if (!dir) continue;
    const full = join(dir, bin);
    try {
      fs.accessSync(full, fs.constants.X_OK);
      return full;
    } catch {
      /* keep scanning */
    }
  }
  return null;
}

export interface ScanOptions {
  /** Env used for PATH + `<X>_CLI_BIN` overrides (default process.env). */
  env?: NodeJS.ProcessEnv;
  /** Per-binary `--version` probe timeout (default 5s). */
  versionTimeoutMs?: number;
  /** Skip version detection (binary-presence scan only). */
  skipVersionProbe?: boolean;
  /**
   * Run `--version` (in a scratch HOME) for every installed runtime whose
   * install metadata has no version, not only the side-effect-free ones.
   */
  probe?: boolean;
}

/**
 * Detect every known runtime, in parallel. Exit-0-always by contract —
 * detection, not a test. Auth is deliberately NOT probed (§6): logins are
 * too heterogeneous; auth failures surface at exec time. Read-only unless
 * `probe` is set: see version-probe.ts for when a binary is run (#337).
 */
export async function scanInstalled(opts: ScanOptions = {}): Promise<{
  v: number;
  agents: ScanEntry[];
}> {
  const env = opts.env ?? process.env;
  const entries = await Promise.all(
    RUNNER_SPECS.map(async (spec): Promise<ScanEntry> => {
      const bin = resolveBinary(spec, env);
      const binPath = bin ? locateBinary(bin, env) : null;
      const detected =
        binPath === null
          ? null
          : opts.skipVersionProbe
            ? { version: null, source: 'not-probed' as const }
            : await detectVersion(spec.id, binPath, opts);
      return {
        id: spec.id,
        installed: binPath !== null,
        binary: binPath,
        version: detected?.version ?? null,
        version_source: detected?.source ?? null,
        install_hint: spec.installHint,
        install: installRecipe(spec.installHint),
        login_hint: spec.loginHint ?? null,
        streams_incrementally: spec.streamsIncrementally,
        full_access: spec.supportsFullAccess,
        tool_activity_fidelity: spec.toolActivityFidelity,
        resume: spec.resume,
        effort: spec.effort,
        max_turns: spec.maxTurns,
        reports_cost: spec.reportsCost,
        init_target: spec.initTarget,
      };
    }),
  );
  return { v: 1, agents: entries };
}
