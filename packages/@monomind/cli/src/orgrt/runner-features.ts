// packages/@monomind/cli/src/orgrt/runner-features.ts
/**
 * Coder mode on every runtime: the per-runtime service flags `agent scan
 * --json` reports (doc/agent-exec-protocol.md §6, rev 13) so a caller can
 * say honestly what a runtime gives a coder turn. Kept out of
 * runner-registry.ts (near the 500-line limit) and merged into each
 * `RunnerSpec` there. `Record<RuntimeKind, …>` makes a new runtime a
 * compile error until it is listed here.
 *
 * Each flag states what the RUNNER implements today, not what the vendor
 * CLI could do:
 *   resume      — the runner honors `AgentRunArgs.resume` (agent exec
 *                 `--resume <session_id>`) and yields a session id to resume.
 *   effort      — the runner maps `AgentRunArgs.effort` (agent exec
 *                 `--effort`) onto the CLI; others ignore it with a status
 *                 notice.
 *   maxTurns    — the runner enforces `AgentRunArgs.maxTurns` on the
 *                 runtime's native agent loop.
 *   reportsCost — `result.cost_usd` is a real USD figure (a runner that
 *                 reports a constant 0 does not count), so a USD budget can
 *                 trip.
 *   initTarget  — the `monomind init --target` value that writes this
 *                 runtime's setup files, or null when init has none.
 */

import type { RuntimeKind } from './daemon.js';

export interface RunnerFeatures {
  resume: boolean;
  effort: boolean;
  maxTurns: boolean;
  reportsCost: boolean;
  initTarget: 'claude' | 'codex' | 'opencode' | 'kimicode' | 'antigravity' | null;
}

export const RUNNER_FEATURES: Record<RuntimeKind, RunnerFeatures> = {
  claude: { resume: true, effort: true, maxTurns: true, reportsCost: true, initTarget: 'claude' },
  // effort: `-c model_reasoning_effort=<level>` (codex-runner).
  codex: { resume: true, effort: true, maxTurns: false, reportsCost: false, initTarget: 'codex' },
  // cost: the served instance reports per-message USD (opencode-runner.ts).
  opencode: {
    resume: true,
    effort: false,
    maxTurns: false,
    reportsCost: true,
    initTarget: 'opencode',
  },
  vercel: { resume: true, effort: false, maxTurns: true, reportsCost: false, initTarget: null },
  antigravity: {
    resume: true,
    effort: false,
    maxTurns: false,
    reportsCost: false,
    initTarget: 'antigravity',
  },
  kimicode: {
    resume: true,
    effort: false,
    maxTurns: false,
    reportsCost: false,
    initTarget: 'kimicode',
  },
  grok: { resume: true, effort: false, maxTurns: false, reportsCost: false, initTarget: null },
  qwen: { resume: true, effort: false, maxTurns: false, reportsCost: false, initTarget: null },
  // Resume is per-process only (the rpc session lives as long as the child).
  'qwen-rpc': { resume: false, effort: false, maxTurns: false, reportsCost: false, initTarget: null },
  // crush resumes with --continue inside one run only; no id to hand back.
  crush: { resume: false, effort: false, maxTurns: false, reportsCost: false, initTarget: null },
  // copilot documents --resume=<id> but emits no session id to pass back.
  copilot: { resume: false, effort: false, maxTurns: false, reportsCost: false, initTarget: null },
  pi: { resume: false, effort: false, maxTurns: false, reportsCost: false, initTarget: null },
  'pi-rpc': { resume: false, effort: false, maxTurns: false, reportsCost: false, initTarget: null },
  // hermes reports cost_usd: 0 — not a real figure.
  hermes: { resume: false, effort: false, maxTurns: false, reportsCost: false, initTarget: null },
};
