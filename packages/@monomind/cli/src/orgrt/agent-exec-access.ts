// packages/@monomind/cli/src/orgrt/agent-exec-access.ts
/**
 * `--access full` support for `agent exec` (#355 — the "Coder mode" epic
 * #364). Kept out of agent-exec.ts (a file shared with #356/#357, and
 * already near the 500-line project limit) so this stays a small, isolated
 * addition #365 can reuse later for org-role opt-in.
 *
 * #360's threat model requires these guards to live in monomind itself, not
 * only in whatever caller (e.g. mono-agent) already validated its flags —
 * `checkFullAccessGuards` is the single place `orgrt/agent-exec.ts` calls
 * before a full-access turn is allowed to start.
 */

import { statSync } from 'node:fs';
import { type RunnerSpec, runnerSpec } from './runner-registry.js';

export type AccessMode = 'scoped' | 'read' | 'full';

/**
 * `canUseTool` for `--access full`: every call is allowed. Subprocess
 * runners never consult it for native tools (their CLI runs its own yolo
 * mode); it is passed to ClaudeAgentRunner exactly like the scoped gate, so it still goes through
 * `coverEveryToolCall`'s PreToolUse hook — every call remains OBSERVED (the
 * hook still fires and could feed #357's tool_activity) even though none are
 * denied.
 */
export async function fullAccessCanUseTool(
  _toolName: string,
  input: Record<string, unknown>,
): Promise<{ behavior: 'allow'; updatedInput: Record<string, unknown> }> {
  return { behavior: 'allow', updatedInput: input };
}

export interface AccessGuardError {
  code: 'unsafe' | 'unsupported';
  message: string;
}

/**
 * Guards checked before a full-access turn starts, regardless of what a
 * caller already validated:
 *  - refuse root (uid 0) on every runtime — Claude Code itself refuses
 *    bypassPermissions as root, and no other CLI's yolo mode is safer there.
 *  - refuse a runtime whose RunnerSpec doesn't advertise supportsFullAccess
 *    (rev 19: every coding runtime does — see runner-registry.ts).
 *  - require an explicit, existing, directory `--cwd` — no silent inherit.
 */
export function checkFullAccessGuards(opts: {
  runtime: string;
  cwd: string | undefined;
  spec: RunnerSpec | undefined;
  getuid?: () => number;
}): AccessGuardError | null {
  const getuid = opts.getuid ?? process.getuid?.bind(process);
  if (getuid && getuid() === 0) {
    return {
      code: 'unsafe',
      message:
        '--access full refuses to run as root (uid 0) on any runtime — the same restriction Claude Code itself applies to bypassPermissions.',
    };
  }
  if (!opts.spec?.supportsFullAccess) {
    return {
      code: 'unsupported',
      message: `--access full is not supported by runtime "${opts.runtime}"`,
    };
  }
  if (!opts.cwd) {
    return {
      code: 'unsafe',
      message: '--access full requires --cwd (no inherited cwd allowed)',
    };
  }
  try {
    if (!statSync(opts.cwd).isDirectory()) {
      return { code: 'unsafe', message: `--cwd "${opts.cwd}" is not a directory` };
    }
  } catch {
    return { code: 'unsafe', message: `--cwd "${opts.cwd}" does not exist` };
  }
  return null;
}

/** #388: `--access read` needs a runtime with a real read-only mode
 *  (runner-access.ts); anywhere else it is refused, never run as scoped. */
export function checkReadAccess(
  runtime: string,
  spec: RunnerSpec | undefined,
): AccessGuardError | null {
  if (spec?.readAccess) return null;
  return {
    code: 'unsupported',
    message: `--access read is not supported by runtime "${runtime}" (no verified read-only mode — see agent scan --json access_modes)`,
  };
}

/**
 * Resolves `opts.access` (default `'scoped'`) and, for `'read'` (#388) and
 * `'full'`, runs every guard and emits the protocol `error`+`done` pair
 * itself on failure — kept
 * out of agent-exec.ts's own line budget (a file shared with #356/#357).
 * `abort: true` means the caller must stop and return exit code 2.
 */
export function resolveAccess(
  opts: { runtime: string; cwd?: string; access?: AccessMode },
  emit: (ev: Record<string, unknown>) => void,
): { access: AccessMode; abort: boolean } {
  const access = opts.access ?? 'scoped';
  if (access === 'scoped') return { access, abort: false };
  const spec = runnerSpec(opts.runtime);
  const err =
    access === 'read'
      ? checkReadAccess(opts.runtime, spec)
      : checkFullAccessGuards({ runtime: opts.runtime, cwd: opts.cwd, spec });
  if (!err) return { access, abort: false };
  emit({ v: 1, type: 'error', code: err.code, fatal: true, message: err.message });
  emit({ v: 1, type: 'done', exit_code: 2 });
  return { access, abort: true };
}
