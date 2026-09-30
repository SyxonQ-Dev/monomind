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

let installed: Promise<RoleDepsResult> | undefined;

/** Makes sure the SDK a role running `runtime` may need is installed. Never
 *  throws: a failure is returned, and the role then fails with the
 *  operator's command. Synchronous when there is nothing to install, so a
 *  session start does not yield for it. `probe` is for tests. */
export function ensureRoleDeps(
  runtime: string,
  probe?: RoleDepsProbe,
): RoleDepsResult | Promise<RoleDepsResult> {
  const p = probe ?? defaultRoleDepsProbe();
  if (roleContextMarker(p.env)) return { status: 'in-role' };
  if (runtime !== 'claude' && !p.claudeOnPath()) return { status: 'not-needed' };
  if (p.sdkPresent()) return { status: 'present' };
  const attempt = async (): Promise<RoleDepsResult> => {
    try {
      await p.install();
      return { status: 'installed' };
    } catch (err) {
      return { status: 'failed', error: err instanceof Error ? err.message : String(err) };
    }
  };
  if (probe) return attempt();
  // One install per process; a failure is not kept, so a later spawn retries.
  installed ??= attempt().then((r) => {
    if (r.status === 'failed') installed = undefined;
    return r;
  });
  return installed;
}

/** The audit line for a failed install. */
export const roleDepsFailure = (error: string): string =>
  `could not install ${SDK}@${OPTIONAL_DEPENDENCIES[SDK].version} before starting the role, ` +
  `so \`agent exec --runtime claude\` will fail inside it until the operator runs ` +
  `\`monomind deps install\`: ${error}`;
