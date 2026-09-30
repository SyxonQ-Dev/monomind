// packages/@monomind/cli/src/orgrt/role-deps.ts
/**
 * #559: the pinned deps a role may need, installed by the host before the
 * role starts.
 *
 * ~/.monomind/deps is read-only inside every org role (#527): it holds code
 * the unsandboxed daemons load, so a role must never write it. That also
 * means a role cannot do the first-use install of the Claude Agent SDK that
 * `agent exec --runtime claude` needs. The org runtime runs outside the
 * sandbox, so it installs the SDK here, through the same hash-pinned
 * installer (utils/optional-deps.ts), before it spawns the role.
 *
 * Which roles need it: a claude-runtime role always does. Any role with a
 * shell can run `agent exec --runtime claude`, which cannot be told from its
 * definition, so the SDK is also installed whenever the claude runtime is
 * available on this host. Inside a role nothing is installed; a missing SDK
 * fails there at once with the operator's command (`monomind deps install`).
 */
import { OPTIONAL_DEPENDENCIES, optionalDependencyPresent } from '../utils/optional-deps.js';
import { loadClaudeSdk } from './claude-sdk.js';
import { roleContextMarker } from './org-signature.js';
import { locateBinary } from './runner-registry.js';

const SDK = '@anthropic-ai/claude-agent-sdk';

export interface RoleDepsProbe {
  env: NodeJS.ProcessEnv;
  /** The pinned SDK loads without an install. */
  sdkPresent: () => boolean;
  /** A `claude` binary is on PATH, so the claude runtime is available. */
  claudeOnPath: () => boolean;
  /** Installs and verifies the pinned SDK. */
  install: () => Promise<unknown>;
}

export type RoleDepsResult =
  | { status: 'present' | 'installed' | 'not-needed' | 'in-role' }
  | { status: 'failed'; error: string };

export const defaultRoleDepsProbe = (env: NodeJS.ProcessEnv = process.env): RoleDepsProbe => ({
  env,
  sdkPresent: () => optionalDependencyPresent(SDK, { env }),
  claudeOnPath: () => locateBinary('claude', env) !== null,
  install: () => loadClaudeSdk(),
});

/** How long a failed install is reported without retrying: every session
 *  start would otherwise spawn npm again (offline, each waits out the fetch
 *  timeout), and a role can cause session starts. */
export const ROLE_DEPS_RETRY_MS = 10 * 60_000;
/** The longest a session start waits for an install; the install goes on in
 *  the background and the next session start finds it. */
export const ROLE_DEPS_WAIT_MS = 5 * 60_000;

/** Per-process install state. Tests pass a fresh one. */
export interface RoleDepsState {
  done?: RoleDepsResult;
  inFlight?: Promise<RoleDepsResult>;
  failed?: { at: number; result: RoleDepsResult };
  now: () => number;
}
export const newRoleDepsState = (now: () => number = Date.now): RoleDepsState => ({ now });
const processState = newRoleDepsState();

/** Makes sure the SDK a role running `runtime` may need is installed. Never
 *  throws: a failure is returned, and the role then fails with the
 *  operator's command. Synchronous when there is nothing to install, or once
 *  it is installed, so a session start does not yield for it. One install at
 *  a time per process; after a failure the same failure is returned for
 *  ROLE_DEPS_RETRY_MS. `probe` and `state` are for tests. */
export function ensureRoleDeps(
  runtime: string,
  probe: RoleDepsProbe = defaultRoleDepsProbe(),
  state: RoleDepsState = processState,
): RoleDepsResult | Promise<RoleDepsResult> {
  if (roleContextMarker(probe.env)) return { status: 'in-role' };
  if (runtime !== 'claude' && !probe.claudeOnPath()) return { status: 'not-needed' };
  if (state.done) return state.done;
  if (probe.sdkPresent()) return { status: 'present' };
  if (state.failed && state.now() - state.failed.at < ROLE_DEPS_RETRY_MS)
    return state.failed.result;
  state.inFlight ??= (async (): Promise<RoleDepsResult> => {
    let r: RoleDepsResult;
    try {
      await probe.install();
      r = { status: 'installed' };
      state.done = { status: 'present' };
      state.failed = undefined;
    } catch (err) {
      r = { status: 'failed', error: err instanceof Error ? err.message : String(err) };
      state.failed = { at: state.now(), result: r };
    }
    state.inFlight = undefined;
    return r;
  })();
  return state.inFlight;
}

/** Waits for `pending` until the session is aborted or `ms` pass; the
 *  install itself is not cancelled. */
export async function waitRoleDeps(
  pending: Promise<RoleDepsResult>,
  signal: AbortSignal,
  ms: number = ROLE_DEPS_WAIT_MS,
): Promise<RoleDepsResult> {
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const cut = new Promise<RoleDepsResult>((resolve) => {
    const stop = (why: string) => resolve({ status: 'failed', error: why });
    timer = setTimeout(() => stop(`still installing after ${ms / 1000}s`), ms);
    timer.unref?.();
    onAbort = () => stop('the session was stopped while installing');
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([pending, cut]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/** The audit line for an install the host just did. */
export const roleDepsInstalled = (): string =>
  `installed ${SDK}@${OPTIONAL_DEPENDENCIES[SDK].version} into the monomind deps dir before starting the role`;

/** The audit line for a failed install. */
export const roleDepsFailure = (error: string): string =>
  `could not install ${SDK}@${OPTIONAL_DEPENDENCIES[SDK].version} before starting the role, ` +
  `so \`agent exec --runtime claude\` will fail inside it until the operator runs ` +
  `\`monomind deps install\`: ${error}`;
