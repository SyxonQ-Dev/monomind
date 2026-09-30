/**
 * Headless, machine-readable `monomind init --json` (issue #358, capability
 * `init-json`). Coder workspaces (mono-agent) call this to turn an arbitrary
 * folder into a ready-to-use monomind/Claude Code workspace without a human
 * at the terminal: one JSON document on stdout, human output suppressed.
 *
 * Contract: doc/agent-exec-protocol.md §11.
 *
 * @module @monomind/cli/commands/init-workspace
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { executeInit } from '../init/index.js';
import { resolveInitOptions } from '../init/resolve-options.js';
import type { CommandContext, CommandResult } from '../types.js';
import { isInitialized } from './init-action.js';

/**
 * The directory name the Claude Code CLI/Agent SDK uses under
 * `~/.claude/projects/` for a given absolute project path: every path
 * separator becomes `-` (e.g. `/home/user/app` -> `-home-user-app`).
 * Verified empirically (see doc/agent-exec-protocol.md §11) — the CLI itself
 * is a closed-source binary, so this is an observed convention, not a
 * documented API; it covers POSIX paths, which is monomind's primary target.
 */
export function claudeProjectSlug(targetDir: string): string {
  return targetDir.split(path.sep).join('-');
}

/** Absolute path to this project's Claude Code session-history directory. */
export function claudeProjectDir(targetDir: string, home = os.homedir()): string {
  return path.join(home, '.claude', 'projects', claudeProjectSlug(targetDir));
}

/**
 * Whether `~/.claude/projects/<slug>/` exists for `targetDir` — the same
 * directory a real Claude Code turn (interactive `claude`, or the Agent
 * SDK's `query()`, which spawns the same CLI binary) creates as a side
 * effect of running in that directory. This is what mono-agent's dashboard
 * listing checks for; it is NOT the same as the CLI's own
 * `~/.claude.json` `projects[path].hasTrustDialogAccepted` flag, which our
 * own probing (§11) found is written only by the interactive CLI's
 * onboarding/trust-dialog flow, never by a headless SDK turn.
 */
function isClaudeProjectRegistered(targetDir: string): boolean {
  try {
    return fs.existsSync(claudeProjectDir(targetDir));
  } catch {
    return false;
  }
}

function printAndReturn(payload: Record<string, unknown>, success: boolean): CommandResult {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  return success ? { success: true, data: payload } : { success: false, exitCode: 1 };
}

/**
 * `monomind init --json` (and `--project`/`--if-missing`/`--no-graph`/
 * `--register-claude-project`, all of which also work without `--json`).
 * No spinner, no boxes, no prompts — a single JSON document on stdout.
 */
export async function runInitWorkspace(ctx: CommandContext, cwd: string): Promise<CommandResult> {
  const start = Date.now();
  const force = ctx.flags.force as boolean;
  const yes = (ctx.flags.yes as boolean) || process.env.CI === 'true';
  const ifMissing = ctx.flags['if-missing'] === true || ctx.flags.ifMissing === true;

  const initialized = isInitialized(cwd);
  const hasExisting = initialized.claude || initialized.monomind;
  // `--if-missing` is itself consent to run against an already-initialized
  // directory (that is the point of it) — unlike the interactive path, a
  // JSON caller never gets a confirm() prompt, so `--force`/`--yes`/
  // `--if-missing` are the only three ways past this gate.
  if (hasExisting && !force && !yes && !ifMissing) {
    return printAndReturn(
      {
        success: false,
        error: 'Already initialized. Use --force, --yes, or --if-missing to reinitialize.',
        duration_ms: Date.now() - start,
      },
      false,
    );
  }

  const resolved = resolveInitOptions(ctx, cwd);
  if (!resolved.ok) {
    return printAndReturn(
      { success: false, error: resolved.message, duration_ms: Date.now() - start },
      false,
    );
  }
  const options = resolved.options;
  // Headless: never stop to ask about installing the Claude Code CLI (#420).
  options.installClaudeCode = false;

  // executeInit's deeper writers (capability scan, doctor auto-fix — which
  // runs the `doctor` command's own action, spinner included, …) print
  // directly to stdout: bare console.log, the shared `output` formatter
  // (defaults to process.stdout), and the Spinner class (hardcoded to
  // process.stdout, not configurable via output.setOutputStream). Stdout is
  // reserved exclusively for the one JSON document below, so patch
  // process.stdout.write itself for the duration of the call — the one
  // chokepoint all three go through — and move everything to stderr rather
  // than dropping it.
  const realStdoutWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
    return process.stderr.write(chunk as never, ...(rest as []));
  }) as typeof process.stdout.write;
  const restore = () => {
    process.stdout.write = realStdoutWrite;
  };

  let result: Awaited<ReturnType<typeof executeInit>>;
  try {
    result = await executeInit(options);
  } catch (error) {
    restore();
    return printAndReturn(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        duration_ms: Date.now() - start,
      },
      false,
    );
  }
  restore();

  if (!result.success) {
    return printAndReturn(
      {
        success: false,
        error: result.errors.join('; ') || 'init failed',
        duration_ms: Date.now() - start,
      },
      false,
    );
  }

  // `--register-claude-project`: model-free registration (see doc comment on
  // isClaudeProjectRegistered). Only creates the directory when it does not
  // already exist — never touches an existing one's session transcripts.
  if (
    (ctx.flags['register-claude-project'] === true || ctx.flags.registerClaudeProject === true) &&
    !isClaudeProjectRegistered(options.targetDir)
  ) {
    try {
      fs.mkdirSync(claudeProjectDir(options.targetDir), { recursive: true });
    } catch {
      /* best-effort — claude_project_registered below reports the true state */
    }
  }

  const payload = {
    root: options.targetDir,
    created: [...result.created.directories, ...result.created.files],
    skipped: result.skipped,
    claude_project_registered: isClaudeProjectRegistered(options.targetDir),
    // #420: which platforms were written and why.
    platforms: {
      source: resolved.platforms.source,
      selected: resolved.platforms.platforms,
      detected: resolved.platforms.detected,
    },
    duration_ms: Date.now() - start,
  };
  return printAndReturn(payload, true);
}
