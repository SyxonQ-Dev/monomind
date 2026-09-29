// packages/@monomind/cli/src/orgrt/runner-sandbox.ts
/**
 * `agent exec --sandbox` (#396, rev 23) and the truthful `native_sandbox` /
 * `approvals` report on the `start` event and in `agent scan --json`.
 *
 * Vocabulary (doc/agent-exec-protocol.md §3.2):
 *   native_sandbox
 *     read-only        the vendor CLI's own sandbox: no writes anywhere
 *     workspace-write  the vendor CLI's own sandbox: writes in the cwd (and
 *                      the CLI's temp/state dirs) only
 *     full             the runtime has a native sandbox and it is OFF this
 *                      turn (e.g. codex danger-full-access, grok `off`)
 *     none             the runtime has no native sandbox monomind drives;
 *                      the CLI runs with the user's own file-system rights
 *     monomind         claude only: no vendor sandbox, monomind enforces
 *                      the access mode itself (canUseTool + PreToolUse)
 *   approvals
 *     off   native tool calls run without asking (yolo/always-approve)
 *     on    the CLI's own approval rules apply; a call that would ask is
 *           refused, since a headless turn has nobody to answer
 *     n/a   no native approval step (claude: monomind decides each call;
 *           vercel: no native tools)
 *
 * `--sandbox full` is always accepted and means "today's default": monomind
 * adds no native sandbox. It never loosens a runtime whose own default is
 * tighter (dsh stays workspace-write). `read-only` / `workspace-write` are
 * listed only where the vendor CLI really has the mode and it was checked:
 *   codex — `--sandbox read-only|workspace-write` (codex-cli 0.156 --help;
 *           behaviour verified with `codex sandbox`, see cli-sandbox.ts).
 *   grok  — `--sandbox read-only|workspace` profiles (grok 1.0.13: both
 *           resolve and start the Landlock/bwrap sandbox, an unknown
 *           profile is rejected — see cli-sandbox.ts).
 *   dsh   — DSH_PERMISSION_MODE `read-only|workspace-write` (dsh-runner-
 *           stream.ts, captured live when the runner was built).
 * Not the others: antigravity's `--sandbox` is an unspecified boolean
 * "terminal restrictions" switch, qwen's is a container sandbox (not
 * installed here, unverified), copilot/opencode/crush/pi/kimicode/cline/
 * aider/hermes have no file-system sandbox flag at all.
 */

import { roleGitLevel } from './cli-sandbox.js';
import type { RuntimeKind } from './daemon.js';
import type { GitLevel } from './git-guard.js';

export type SandboxMode = 'read-only' | 'workspace-write' | 'full';
export const SANDBOX_MODES: readonly SandboxMode[] = ['read-only', 'workspace-write', 'full'];
export type NativeSandbox = SandboxMode | 'none' | 'monomind';
export type Approvals = 'off' | 'on' | 'n/a';
export interface SandboxReport {
  native_sandbox: NativeSandbox;
  approvals: Approvals;
}

const ALL: readonly SandboxMode[] = SANDBOX_MODES;
const FULL: readonly SandboxMode[] = ['full'];

/** The `--sandbox` values each runtime accepts (`agent scan --json` sandbox_modes). */
export const RUNNER_SANDBOX_MODES: Record<RuntimeKind, readonly SandboxMode[]> = {
  claude: FULL,
  codex: ALL,
  grok: ALL,
  dsh: ALL,
  opencode: FULL,
  vercel: FULL,
  antigravity: FULL,
  kimicode: FULL,
  qwen: FULL,
  'qwen-rpc': FULL,
  crush: FULL,
  copilot: FULL,
  pi: FULL,
  'pi-rpc': FULL,
  hermes: FULL,
  cline: FULL,
  aider: FULL,
};

export function sandboxModes(runtime: string): readonly SandboxMode[] {
  return RUNNER_SANDBOX_MODES[runtime as RuntimeKind] ?? FULL;
}

const RANK: Record<SandboxMode, number> = { 'read-only': 0, 'workspace-write': 1, full: 2 };

/**
 * The mode a turn really runs in for `--sandbox <requested>`. An org role
 * below 'push' (MONOMIND_GIT_LEVEL in `--env` or in monomind's own env) runs
 * codex/grok in workspace-write (cli-sandbox.ts); the flag may tighten that
 * but never loosen it. Returns an error for a mode the runtime lacks.
 */
export function resolveSandbox(
  runtime: string,
  requested: SandboxMode | undefined,
  envs: Array<Record<string, string | undefined> | undefined>,
): { mode?: SandboxMode; error?: string } {
  if (requested === undefined) return {};
  const modes = sandboxModes(runtime);
  if (!modes.includes(requested)) {
    return {
      error: `--sandbox ${requested} is not supported by runtime "${runtime}" (agent scan --json sandbox_modes: ${modes.join(', ')})`,
    };
  }
  const restricted = envs.some(
    (e) => roleGitLevel(e as Record<string, string> | undefined) !== 'push',
  );
  const cap: SandboxMode | undefined =
    restricted && modes.includes('workspace-write') ? 'workspace-write' : undefined;
  return { mode: cap && RANK[cap] < RANK[requested] ? cap : requested };
}

/**
 * What the vendor CLI really runs with this turn. `sandbox` is the mode
 * handed to the runner (undefined = no `--sandbox`); `env` is the runner's
 * env (MONOMIND_GIT_LEVEL / DSH_PERMISSION_MODE are read from it, as the
 * runners do).
 */
export function sandboxReport(
  runtime: string,
  opts: {
    access: 'scoped' | 'read' | 'full';
    sandbox?: SandboxMode;
    env?: Record<string, string>;
  },
): SandboxReport {
  const { access, sandbox } = opts;
  const narrowed = sandbox && sandbox !== 'full' ? sandbox : undefined;
  const level: GitLevel = roleGitLevel(opts.env);
  switch (runtime) {
    case 'claude':
      return access === 'full'
        ? { native_sandbox: 'full', approvals: 'off' }
        : { native_sandbox: 'monomind', approvals: 'n/a' };
    case 'codex':
    case 'grok': {
      // codex exec never asks (approval "never"); grok runs --always-approve.
      if (runtime === 'codex' && access === 'read')
        return { native_sandbox: 'read-only', approvals: 'off' };
      if (narrowed) return { native_sandbox: narrowed, approvals: 'off' };
      if (access === 'full') return { native_sandbox: 'full', approvals: 'off' };
      return {
        native_sandbox: level === 'push' ? 'full' : 'workspace-write',
        approvals: 'off',
      };
    }
    case 'dsh': {
      // DSH_PERMISSION_MODE sets both dsh's sandbox and its approval policy:
      // danger-full-access = approval never; the others = ask (fails closed).
      if (narrowed) return { native_sandbox: narrowed, approvals: 'on' };
      if (access === 'full') return { native_sandbox: 'full', approvals: 'off' };
      return {
        native_sandbox:
          opts.env?.DSH_PERMISSION_MODE === 'read-only' ? 'read-only' : 'workspace-write',
        approvals: 'on',
      };
    }
    case 'opencode':
    case 'cline':
      // Scoped: the CLI's own permission rules, and what asks is refused.
      return { native_sandbox: 'none', approvals: access === 'full' ? 'off' : 'on' };
    case 'hermes':
      // No --yolo: hermes's dangerous-command approval stays on.
      return { native_sandbox: 'none', approvals: 'on' };
    case 'vercel':
      return { native_sandbox: 'none', approvals: 'n/a' };
    default:
      // copilot --allow-all-tools, qwen --yolo, antigravity
      // --dangerously-skip-permissions, kimicode/crush/pi (never ask),
      // aider --yes-always.
      return { native_sandbox: 'none', approvals: 'off' };
  }
}
