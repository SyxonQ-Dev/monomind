/**
 * CLI startup helpers: update check, config loading, subsystem init, error handling
 *
 * Split out of index.ts (file-size sweep). Pure move: the method bodies are
 * unchanged; the output formatter previously reached via `this.output` is now
 * passed in explicitly by the caller.
 */

import type { OutputFormatter } from './output.js';
import type { CLIError, MonomindConfig } from './types.js';
import { runStartupUpdateCheck } from './update/index.js';

/**
 * Check for updates on startup (non-blocking)
 * Shows notification if updates are available
 */
export async function checkForUpdatesOnStartup(
  name: string,
  output: OutputFormatter,
): Promise<void> {
  try {
    const result = await runStartupUpdateCheck({
      autoUpdate: true,
    });

    if (!result.checked) return;

    // Notify-only: never auto-install (GitHub issue #83).
    const available = result.updatesAvailable.filter((u) => u.updateType !== 'none');
    if (available.length > 0) {
      // stderr, not stdout: `--json` commands (agent scan, doctor, org
      // observe) promise stdout holds only their JSON (protocol §3.2), and
      // this notice fires on the first run of any command after a release.
      output.writeErrorln(
        output.dim(
          `  ↑ ${available.map((u) => `${u.package} v${u.latestVersion}`).join(', ')} available  →  run: npm install -g ${name}@latest`,
        ),
      );
    }
  } catch {
    // Silently fail - don't interrupt CLI usage
  }
}

/**
 * Load configuration file
 */
export async function loadCliConfig(
  configPath: string | undefined,
  output: OutputFormatter,
): Promise<MonomindConfig | undefined> {
  const { configManager } = await import('./services/config-file-manager.js');

  // An explicit --config/-c path names an EXACT file — load it directly
  // instead of directory-searching from its dirname (which previously
  // discarded the filename the user gave and either loaded an unrelated
  // monomind.config.json from that directory or found nothing). Failure
  // to find/parse an explicitly-named config file is a loud error, not a
  // silent fallback to defaults.
  if (configPath) {
    const raw = configManager.loadExact(configPath);
    return raw as unknown as MonomindConfig;
  }

  try {
    const raw = configManager.load(process.cwd());
    if (!raw) return undefined;
    return raw as unknown as MonomindConfig;
  } catch (error) {
    // Config loading is optional - don't fail if it doesn't exist
    if (process.env.DEBUG) {
      output.writeln(output.dim(`Config loading failed: ${(error as Error).message}`));
    }
    return undefined;
  }
}

/**
 * Initialize optional subsystems at startup (non-blocking, all failures are silent).
 * Starts the @monoes/hooks WorkerManager, wires MonoswarmCheckpointer, and builds
 * the unified agent registry so that packages/@monomind/* actually contribute
 * to the live runtime.
 */
export async function initCliSubsystems(): Promise<void> {
  // NOTE: the @monoes/hooks WorkerManager is intentionally NOT started
  // here. Workers run from the session-restore hook (6h staleness gate) and
  // on demand via `monomind hooks worker run <name>`. Starting it on every
  // CLI invocation scheduled staggered 1-10s timers that usually died with
  // the process — but long-lived commands (browse: Chrome launch + CDP work)
  // outlived the stagger, so the consolidate worker fired mid-command,
  // loaded the onnxruntime embedding model, and its thread pool crashed the
  // process at exit ("mutex lock failed: Invalid argument" from libc++).

  // GAP-007: MonoswarmCheckpointer — write checkpoint files so crashed monoswarms can resume
  try {
    const { MonoswarmCheckpointer } = await import('@monoes/memory' as string);
    const _swarmCheckpointer = new MonoswarmCheckpointer({
      dbPath: '.monomind/checkpoints/monoswarm.jsonl',
      monoswarmId: 'default',
      sessionId: `session-${Date.now()}`,
    });
    void _swarmCheckpointer;
  } catch (e) {
    // optional — monomind/memory may not be installed
    if (process.env.DEBUG || process.env.MONOMIND_DEBUG)
      console.error('[index] MonoswarmCheckpointer init failed:', e);
  }

  // Task 30: Keep the project's agent registry fresh. The project root is
  // found by walking up from cwd (a CLI run from a directory without agent
  // files must not overwrite the registry with an empty one), and the build
  // only runs when registry.json is older than an agent definition. Readers
  // that need it (`monomind pick`) call ensureRegistry themselves, so this
  // unawaited refresh never has to win a race.
  try {
    const { findProjectRoot, ensureRegistry } = await import('./agents/registry-freshness.js');
    const root = findProjectRoot(process.cwd());
    if (root) ensureRegistry(root);
  } catch (e) {
    // optional — registry build failures must never block startup
    if (process.env.DEBUG || process.env.MONOMIND_DEBUG)
      console.error('[index] agent registry build failed:', e);
  }

  // Task 04: CapabilityMetadata validation moved to `monomind doctor -c registry`
  // (see doctor-routing-checks.ts:checkAgentRegistry). Printing this from a
  // fire-and-forget startup task raced process exit — short-lived commands
  // could skip the warning even when the underlying issue was present. Doctor
  // runs it synchronously within its own check pass instead, so it's always
  // visible and itemized when you actually look for it.

  // NOTE: Semantic routing (@monoes/routing) is constructed on-demand by
  // its consumers — `monomind route semantic` (commands/route.ts) and the
  // `hooks_route_semantic` MCP tool (mcp-tools/hooks-route.ts), both via
  // routing/route-layer-factory.ts. `monomind agent` has no --task flag —
  // that routing point does not exist yet. It is intentionally NOT eagerly
  // initialized here: building all route centroids and probing for the
  // `claude` CLI on every CLI startup would regress the <500ms startup
  // budget for zero benefit (nothing reads a process-global route layer).
}

/**
 * Handle errors
 */
export function handleCliError(error: Error, output: OutputFormatter): void {
  if ('code' in error) {
    // CLIError
    const cliError = error as CLIError;
    output.printError(cliError.message);

    if (cliError.details) {
      output.writeln(output.dim(JSON.stringify(cliError.details, null, 2)));
    }

    process.exit(cliError.exitCode);
  } else {
    // Generic error
    output.printError(error.message);

    if (process.env.DEBUG) {
      output.writeln();
      output.writeln(output.dim(error.stack || ''));
    }

    process.exit(1);
  }
}
