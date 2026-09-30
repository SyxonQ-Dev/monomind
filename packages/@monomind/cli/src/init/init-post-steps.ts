/**
 * Post-init steps run by executeInit(): Monograph code-graph build and the
 * doctor --install auto-fix pass.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveMonographEntryUrl } from './shared.js';
import type { InitResult } from './types.js';

/**
 * Initialize the Monograph code graph — parsed code structure and dependencies.
 * This is not the memory knowledge graph or the Second Brain document index.
 * Spawns buildAsync as a detached child process to avoid SQLite lock contention.
 * Uses the same build.lock file as monograph-freshen.cjs — if a session-start
 * hook build is already running, we skip to avoid SQLITE_BUSY.
 */
export async function initKnowledgeGraph(targetDir: string, result: InitResult): Promise<void> {
  const outputDir = path.join(targetDir, '.monomind', 'graph');
  fs.mkdirSync(outputDir, { recursive: true });

  const lockPath = path.join(outputDir, 'build.lock');
  const now = Date.now();

  // If monograph-freshen.cjs (session-start hook) already holds a fresh lock, skip.
  try {
    const stat = fs.statSync(lockPath);
    if (now - stat.mtimeMs < 5 * 60 * 1000) {
      result.skipped.push(
        'Monograph code graph build: already in progress (session-start hook running)',
      );
      return;
    }
    fs.unlinkSync(lockPath);
  } catch {
    /* no lock — proceed */
  }

  // #420: resolve through the package's public entry, from the CLI's own
  // dependencies. Never install into the user's project — if monograph cannot
  // be loaded, say how to build the graph later and move on.
  const entryUrl = resolveMonographEntryUrl();
  if (!entryUrl) {
    (result.warnings ??= []).push(
      'Monograph code graph not built (@monoes/monograph could not be loaded) — build it later with `npx monomind monograph build`',
    );
    return;
  }

  // Acquire lock before spawning so monograph-freshen.cjs sees it and skips
  try {
    fs.writeFileSync(lockPath, String(process.pid));
  } catch {
    /* non-fatal */
  }

  const { spawn } = await import('node:child_process');
  const logPath = path.join(outputDir, 'build.log');
  let logFd: number | 'ignore' = 'ignore';
  try {
    logFd = fs.openSync(logPath, 'a');
  } catch {
    /* non-fatal */
  }

  const script = `
import { buildAsync } from ${JSON.stringify(entryUrl)};
import { unlinkSync } from 'fs';
try { await buildAsync(${JSON.stringify(targetDir)}); } finally {
  try { unlinkSync(${JSON.stringify(lockPath)}); } catch {}
}`;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', script], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    cwd: targetDir,
  });
  child.unref();
  // Close the parent's copy of the fd — the child has its own inherited copy
  if (typeof logFd === 'number') {
    try {
      fs.closeSync(logFd);
    } catch {
      /* non-fatal */
    }
  }

  result.created.files.push('.monomind/graph/ (Monograph code graph building in background)');
  // result.created.files only ever surfaces as a bare count in init's own
  // summary box (see commands/init.ts) — print this directly so the one
  // thing pointing at how to check on a background build that might have
  // already failed is actually visible in the foreground output.
  try {
    const { output } = await import('../output.js');
    output.printInfo(
      'Monograph code graph building in background — check `monomind doctor` in a minute, or .monomind/graph/build.log if it never shows up',
    );
  } catch {
    /* non-fatal */
  }
}

const CLAUDE_INSTALL = 'npm install -g @anthropic-ai/claude-code';

/**
 * Whether init may install the Claude Code CLI globally (#420): only when
 * Claude Code is a selected platform, it is missing, someone is at a
 * terminal, and they say yes. Anywhere else it prints the install command.
 */
async function mayInstallClaudeCode(claudeSelected: boolean): Promise<boolean> {
  if (!claudeSelected) return false;
  const { checkClaudeCode } = await import('../commands/doctor-env-checks.js');
  if ((await checkClaudeCode()).status === 'pass') return false;
  const { output } = await import('../output.js');
  const tty = process.stdin.isTTY === true && process.stdout.isTTY === true && !process.env.CI;
  if (!tty) {
    output.printInfo(`Claude Code CLI not found — install it with: ${CLAUDE_INSTALL}`);
    return false;
  }
  const { confirm } = await import('../prompt.js');
  const yes = await confirm({
    message: `Claude Code CLI not found. Install it now (${CLAUDE_INSTALL})?`,
    default: false,
  });
  if (!yes) output.printInfo(`Skipped — install it later with: ${CLAUDE_INSTALL}`);
  return yes;
}

/**
 * Run doctor's fixes after init. Non-fatal: best-effort health check.
 *
 * `install` allows the Claude Code CLI install (a real network fetch and
 * global write) — false for `monomind init --no-install`. Even then it runs
 * only as `mayInstallClaudeCode` decides: Claude Code selected, missing,
 * interactive, and confirmed (#132, #420).
 */
export async function runDoctorFix(
  targetDir: string,
  result: InitResult,
  allowInstall = true,
  claudeSelected = true,
): Promise<void> {
  try {
    const { doctorCommand } = await import('../commands/doctor.js');
    if (!doctorCommand.action) {
      result.skipped.push('doctor: auto-fix unavailable (run: monomind doctor --install)');
      return;
    }
    const install = allowInstall && (await mayInstallClaudeCode(claudeSelected));
    const res = await doctorCommand.action({
      args: [],
      // `fix: true` keeps the local, no-network fixes (monoes tool shims,
      // gitignore coverage) running even when `install` is false — only the
      // Claude Code CLI's global npm install is gated by `install`.
      // `problemsOnly` (#425): print just the post-fix warnings/failures.
      flags: { install, fix: true, problemsOnly: true },
      cwd: targetDir,
    } as never);
    const data = (res as { data?: { passed?: number; warnings?: number; failed?: number } })?.data;
    if (data) {
      const { output } = await import('../output.js');
      output.printInfo(
        `Health check: ${data.passed ?? 0} passed, ${data.warnings ?? 0} warning(s), ${data.failed ?? 0} failed` +
          ((data.warnings ?? 0) + (data.failed ?? 0) > 0
            ? ' — run `monomind doctor` for details'
            : ''),
      );
    }
    if (res && (res as { success?: boolean }).success === false) {
      result.skipped.push('doctor: reported issues (run: monomind doctor for details)');
    } else {
      // A health check that found nothing to fix never "created" a file —
      // report it as an update note, not a created one, so a run that
      // changes nothing else can honestly report an empty `created` list.
      result.updated.push(
        install
          ? 'doctor --install (health check + auto-fix)'
          : 'doctor --fix (health check, no network install)',
      );
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    result.skipped.push(`doctor: auto-fix failed (${detail}) — run: monomind doctor --install`);
  }
}
