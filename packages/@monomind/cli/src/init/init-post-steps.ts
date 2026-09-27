/**
 * Post-init steps run by executeInit(): Monograph code-graph build and the
 * doctor --install auto-fix pass.
 */

import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { InitResult } from './types.js';

/**
 * Initialize the Monograph code graph — parsed code structure and dependencies.
 * This is not the memory knowledge graph or the Second Brain document index.
 * Spawns buildAsync as a detached child process to avoid SQLite lock contention.
 * Uses the same build.lock file as monograph-freshen.cjs — if a session-start
 * hook build is already running, we skip to avoid SQLITE_BUSY.
 */
export async function initKnowledgeGraph(
  targetDir: string,
  result: InitResult,
  allowInstall: boolean,
): Promise<void> {
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

  // Resolve @monoes/monograph from the CLI package's own node_modules first
  // (correct for npm/npx installs), then fall back to user project node_modules.
  let entryPoint: string | null = null;
  try {
    const cliRequire = createRequire(import.meta.url);
    entryPoint = cliRequire.resolve('@monoes/monograph/dist/src/index.js');
  } catch {
    const fallback = path.join(
      targetDir,
      'node_modules',
      '@monoes',
      'monograph',
      'dist',
      'src',
      'index.js',
    );
    if (fs.existsSync(fallback)) entryPoint = fallback;
  }
  if (!entryPoint) {
    // P1-13: --no-install (options.installClaudeCode === false) must actually
    // gate this install, not just say it does — skip entirely when disallowed.
    if (!allowInstall) {
      result.skipped.push(
        'Monograph code graph: @monoes/monograph not found (auto-install skipped, --no-install)',
      );
      return;
    }
    // Auto-install @monoes/monograph and retry before giving up.
    // Disclose the install before running it (consistent with the
    // claude-code global install disclosure pattern from #131/#132).
    try {
      const { execSync } = await import('node:child_process');
      const { output } = await import('../output.js');
      output.printInfo(
        'Installing @monoes/monograph (code graph dependency) — pass --no-install to skip',
      );
      execSync('npm install @monoes/monograph', {
        cwd: targetDir,
        stdio: 'ignore',
        timeout: 60000,
      });
      try {
        const cliRequire2 = createRequire(import.meta.url);
        entryPoint = cliRequire2.resolve('@monoes/monograph/dist/src/index.js');
      } catch {
        const fallback2 = path.join(
          targetDir,
          'node_modules',
          '@monoes',
          'monograph',
          'dist',
          'src',
          'index.js',
        );
        if (fs.existsSync(fallback2)) entryPoint = fallback2;
      }
    } catch {
      /* install failed, fall through */
    }
    if (!entryPoint) {
      result.skipped.push(
        'Monograph code graph: @monoes/monograph not found (auto-install failed)',
      );
      return;
    }
    result.created.files.push('@monoes/monograph (auto-installed for the code graph)');
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
import { buildAsync } from ${JSON.stringify(pathToFileURL(entryPoint).href)};
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

/**
 * Run doctor --install to auto-fix any remaining issues.
 * Non-fatal: best-effort health check and auto-install.
 *
 * `install` gates the Claude Code CLI auto-install specifically (a real
 * network fetch + global write, `npm install -g @anthropic-ai/claude-code`)
 * — pass false (`monomind init --no-install`) to run only the local,
 * no-network doctor fixes. When it will run, disclose it up front rather
 * than letting it appear silently mid-summary (#132).
 */
export async function runDoctorFix(
  targetDir: string,
  result: InitResult,
  install = true,
): Promise<void> {
  try {
    const { doctorCommand } = await import('../commands/doctor.js');
    if (!doctorCommand.action) {
      result.skipped.push('doctor: auto-fix unavailable (run: monomind doctor --install)');
      return;
    }
    if (install) {
      const { checkClaudeCode } = await import('../commands/doctor-env-checks.js');
      const claudeCheck = await checkClaudeCode();
      if (claudeCheck.status !== 'pass') {
        const { output } = await import('../output.js');
        output.printInfo(
          'Installing Claude Code CLI globally (npm install -g @anthropic-ai/claude-code) — pass --no-install to skip',
        );
      }
    }
    const res = await doctorCommand.action({
      args: [],
      // `fix: true` keeps the local, no-network fixes (monoes tool shims,
      // gitignore coverage) running even when `install` is false — only the
      // Claude Code CLI's global npm install is gated by `install`.
      flags: { install, fix: true },
      cwd: targetDir,
    } as never);
    if (res && (res as { success?: boolean }).success === false) {
      result.skipped.push('doctor: reported issues (run: monomind doctor for details)');
    } else {
      result.created.files.push(
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
