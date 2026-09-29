/**
 * CLI Cleanup Command
 * Removes project artifacts created by monomind/monomind
 *
 * github.com/monoes/monomind
 */

// Static imports: this package is ESM ("type": "module"), so a bare require()
// here throws "require is not defined" in the built output even though it
// typechecks and passes tests. Guarded by no-cjs-require-in-esm.test.ts.
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { output } from '../output.js';
import type { Command, CommandContext, CommandResult } from '../types.js';
import {
  findOrphanedProjectData,
  findStaleRegistryEntries,
  pruneRegistryEntries,
} from './cleanup-data.js';
import {
  applyCleanupEntry,
  buildCleanupPlan,
  type CleanupPlanEntry,
  isMonomindSourceRepo,
} from './cleanup-plan.js';
import { findStaleScratch, formatSize, removeOrReport } from './cleanup-scratch.js';

export { findOrphanedProjectData, findStaleRegistryEntries } from './cleanup-data.js';
export { findStaleScratch } from './cleanup-scratch.js';

/**
 * Cleanup command definition
 */
export const cleanupCommand: Command = {
  name: 'cleanup',
  description: 'Remove project artifacts created by monomind/monomind',
  aliases: ['clean'],
  options: [
    {
      name: 'dry-run',
      short: 'n',
      description: 'Show what would be removed without deleting (default behavior)',
      type: 'boolean',
      default: true,
    },
    {
      name: 'force',
      short: 'f',
      description:
        'Apply the preview: delete only provably monomind-owned, untracked paths (never git-tracked files or user data)',
      type: 'boolean',
      default: false,
    },
    {
      name: 'keep-config',
      short: 'k',
      description:
        'Preserve monomind.config.json (.claude/settings.json is kept; only hooks and statusLine that run removed helpers are dropped)',
      type: 'boolean',
      default: false,
    },
    {
      name: 'purge-data',
      description:
        'With --force: also delete user data (memory stores, .monomind/org-memory, knowledge index, monograph and other *.db, org configs)',
      type: 'boolean',
      default: false,
    },
    {
      name: 'scratch',
      short: 's',
      description:
        'Prune only stale mastermind scratch (.monomind/taskdev, abandoned .monomind/loops state)',
      type: 'boolean',
      default: false,
    },
    {
      name: 'data',
      short: 'd',
      description:
        'Prune orphaned per-project data in ~/.monomind/projects (gone projects, dead lancedb stores) and gone projects in ~/.monomind-projects.json',
      type: 'boolean',
      default: false,
    },
    {
      name: 'aggressive',
      description:
        'With --data: also prune dirs that cannot prove their origin (pre-2.3.1, no origin marker)',
      type: 'boolean',
      default: false,
    },
  ],
  examples: [
    {
      command: 'cleanup',
      description: 'Show what would be removed (dry run)',
    },
    {
      command: 'cleanup --force',
      description: 'Remove monomind-owned artifacts; keep tracked files and user data',
    },
    {
      command: 'cleanup --force --purge-data',
      description: 'Also delete memory stores, org memory, knowledge index and databases',
    },
    {
      command: 'cleanup --force --keep-config',
      description: 'Remove artifacts but keep configuration files',
    },
    {
      command: 'cleanup --scratch --force',
      description: 'Delete stale taskdev scratch and abandoned loop state',
    },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const force = ctx.flags.force === true;
    const keepConfig = ctx.flags['keep-config'] === true;
    const purgeData = ctx.flags['purge-data'] === true;
    const cwd = ctx.cwd;

    const dryRun = !force;

    if (ctx.flags.data === true) {
      const { homedir } = await import('node:os');
      const baseDir = join(homedir(), '.monomind', 'projects');
      output.writeln();
      output.writeln(
        output.bold(
          dryRun ? 'Monomind Project-Data Cleanup (dry run)' : 'Monomind Project-Data Cleanup',
        ),
      );
      output.writeln();
      const orphans = findOrphanedProjectData(baseDir, Date.now(), ctx.flags.aggressive === true);
      const registryPath = join(homedir(), '.monomind-projects.json');
      const staleRegistryEntries = findStaleRegistryEntries(registryPath);
      if (orphans.length === 0 && staleRegistryEntries.length === 0) {
        output.writeln(output.info('No orphaned project data found.'));
        return { success: true, message: 'Nothing to clean' };
      }
      let removed = 0;
      for (const o of orphans) {
        output.writeln(`  ${dryRun ? 'would remove' : 'removing'}: ${o.path}  (${o.description})`);
        if (!dryRun) {
          try {
            rmSync(o.path, { recursive: true, force: true });
            removed++;
          } catch {
            /* skip unremovable */
          }
        }
      }
      for (const p of staleRegistryEntries) {
        output.writeln(
          `  ${dryRun ? 'would unregister' : 'unregistering'}: ${p}  (project gone, in ${registryPath})`,
        );
      }
      let registryRemoved = 0;
      if (!dryRun && staleRegistryEntries.length > 0) {
        try {
          registryRemoved = pruneRegistryEntries(registryPath, staleRegistryEntries);
        } catch {
          /* registry unreadable/unwritable — leave it */
        }
      }
      const total = orphans.length + staleRegistryEntries.length;
      output.writeln();
      if (dryRun) {
        output.writeln(
          output.dim(
            `  ${total} item(s): ${orphans.length} project-data item(s), ${staleRegistryEntries.length} registry entry(ies). This was a dry run. Use --force to delete.`,
          ),
        );
        return {
          success: true,
          message: `Dry run: ${total} orphaned item(s) found`,
          data: { found: orphans, staleRegistryEntries, dryRun },
        };
      }
      output.writeln(
        `  Removed ${removed} project-data item(s), pruned ${registryRemoved} registry entry(ies)`,
      );
      return {
        success: true,
        message: `Removed ${removed + registryRemoved} orphaned item(s)`,
        data: {
          found: orphans,
          removedCount: removed,
          staleRegistryEntries,
          registryRemovedCount: registryRemoved,
          dryRun,
        },
      };
    }

    if (ctx.flags.scratch === true) {
      const now = Date.now();
      output.writeln();
      output.writeln(
        output.bold(dryRun ? 'Monomind Scratch Cleanup (dry run)' : 'Monomind Scratch Cleanup'),
      );
      output.writeln();
      const stale = findStaleScratch(cwd, now);
      if (stale.length === 0) {
        output.writeln(output.info('No stale scratch found.'));
        return { success: true, message: 'Nothing to clean' };
      }
      const { removed, removedSize } = removeOrReport(
        cwd,
        stale.map((item) => ({ ...item, type: 'file' as const })),
        dryRun,
      );
      output.writeln();
      if (dryRun) {
        output.writeln(
          output.dim(`  ${stale.length} stale file(s). This was a dry run. Use --force to delete.`),
        );
        output.writeln();
        return {
          success: true,
          message: `Dry run: ${stale.length} stale scratch file(s) found`,
          data: { found: stale, dryRun },
        };
      }
      output.writeln(`  Removed ${removed} file(s) totaling ${formatSize(removedSize)}`);
      output.writeln();
      return {
        success: true,
        message: `Removed ${removed} stale scratch file(s)`,
        data: { found: stale, removedCount: removed, removedSize, dryRun },
      };
    }

    // Refuse to --force inside monomind's own source checkout: its tracked
    // AGENTS.md/.agents/.gemini are the product's sources and its untracked
    // .monomind/ holds the developer's live memory (incident 2026-09-22).
    if (force && isMonomindSourceRepo(cwd)) {
      output.writeln(
        output.error(
          'Refusing to run cleanup --force in the monomind source repository itself. ' +
            'Run it in a project that monomind was initialised into.',
        ),
      );
      return { success: false, exitCode: 1, message: 'refused: monomind source repository' };
    }

    // One plan drives both the preview and --force, so the preview is exactly
    // what --force deletes. Built before any process is stopped below.
    const planned = buildCleanupPlan(cwd, {
      keepConfig,
      purgeData,
      memoryPath: process.env.MONOMIND_MEMORY_PATH,
    });
    if (!planned.ok) {
      output.writeln(output.error(`  ${planned.error}`));
      return { success: false, exitCode: 1, message: planned.error };
    }
    const plan = planned.entries;

    // Kill background processes before removing their state files
    if (force) {
      // Guard against a stale PID file outliving its process and the OS
      // recycling that PID for an unrelated process — verify the live
      // process actually looks like ours before signaling it.
      const looksLikeOurProcess = (pid: number): boolean => {
        try {
          const cmd = execSync(`ps -p ${pid} -o command=`, {
            timeout: 2000,
            encoding: 'utf-8',
          }).trim();
          // Covers direct `node ...` spawns as well as the npx fallback in
          // control-start.cjs's findCliPath(), which shows up in `ps` as
          // "npm exec ..." / "npx ..." with no literal "node".
          const looksLikeNode =
            cmd.includes('node') || cmd.includes('npx') || cmd.includes('npm exec');
          return looksLikeNode && (cmd.includes('monomind') || cmd.includes(cwd));
        } catch {
          return false;
        }
      };
      const controlPath = join(cwd, '.monomind', 'control.json');
      try {
        if (existsSync(controlPath) && statSync(controlPath).size <= 4096) {
          const status = JSON.parse(readFileSync(controlPath, 'utf-8'));
          if (
            status?.pid &&
            Number.isInteger(status.pid) &&
            status.pid > 0 &&
            looksLikeOurProcess(status.pid)
          ) {
            process.kill(status.pid, 'SIGTERM');
            output.writeln(output.info(`  Stopped dashboard server (pid ${status.pid})`));
          }
          try {
            unlinkSync(controlPath);
          } catch {}
        }
      } catch {
        /* already gone */
      }
      for (const pidName of ['monograph.watch.pid', 'monograph-watch.pid']) {
        try {
          const pp = join(cwd, '.monomind', pidName);
          if (!existsSync(pp) || statSync(pp).size > 32) continue;
          const pid = parseInt(readFileSync(pp, 'utf-8').trim(), 10);
          if (Number.isInteger(pid) && pid > 0 && looksLikeOurProcess(pid)) {
            process.kill(pid, 'SIGTERM');
            output.writeln(output.info(`  Stopped monograph watcher (pid ${pid})`));
          }
          try {
            unlinkSync(pp);
          } catch {}
        } catch {
          /* already gone */
        }
      }
      // Kill stale MCP server processes
      const mcpPidPaths = [
        join(homedir(), '.monomind', 'mcp.pid'),
        join(cwd, '.monomind', 'mcp-server.pid'),
      ];
      for (const pp of mcpPidPaths) {
        try {
          if (!existsSync(pp) || statSync(pp).size > 32) continue;
          const pid = parseInt(readFileSync(pp, 'utf-8').trim(), 10);
          if (Number.isInteger(pid) && pid > 0 && looksLikeOurProcess(pid)) {
            process.kill(pid, 'SIGTERM');
            output.writeln(output.info(`  Stopped MCP server (pid ${pid})`));
          }
          try {
            unlinkSync(pp);
          } catch {}
        } catch {
          /* already gone */
        }
      }
      // Reap orphaned claude-agent-sdk processes from crashed orgs
      try {
        const { reapOrphanedSdkProcesses } = await import('../utils/resource-governor.js');
        const reaped = reapOrphanedSdkProcesses(new Set());
        if (reaped > 0)
          output.writeln(output.info(`  Reaped ${reaped} orphaned SDK agent process(es)`));
      } catch {
        /* resource-governor not available */
      }
    }

    output.writeln();
    output.writeln(output.bold(dryRun ? 'Monomind Cleanup (dry run)' : 'Monomind Cleanup'));
    output.writeln();

    if (plan.length === 0) {
      output.writeln(output.info('No monomind artifacts found in the current directory.'));
      return { success: true, message: 'Nothing to clean', data: { plan, dryRun } };
    }

    let removedCount = 0;
    let removedSize = 0;
    let failed = 0;
    for (const e of plan.filter((x) => x.action !== 'skip')) {
      const typeLabel = e.kind === 'dir' ? 'dir ' : 'file';
      const verb = e.action === 'remove' ? 'remove' : 'edit';
      const line = `${typeLabel}  ${e.path}  (${formatSize(e.size)}) - ${e.reason}`;
      if (dryRun) {
        output.writeln(output.warning(`  [would ${verb}] ${line}`));
        continue;
      }
      try {
        applyCleanupEntry(cwd, e);
        output.writeln(output.success(`  [${verb === 'remove' ? 'removed' : 'edited'}] ${line}`));
        removedCount++;
        if (e.action === 'remove') removedSize += e.size;
      } catch (err) {
        failed++;
        const msg = err instanceof Error ? err.message : String(err);
        output.writeln(output.error(`  [failed] ${typeLabel}  ${e.path}  - ${msg}`));
      }
    }
    printKept(
      plan.filter((x) => x.action === 'skip'),
      ctx.flags.verbose === true,
    );
    for (const e of plan.filter((x) => x.notice)) {
      output.writeln();
      output.writeln(output.warning(`  ${e.notice}`));
    }

    output.writeln();
    output.writeln(output.bold('Summary:'));
    const acting = plan.filter((x) => x.action !== 'skip');
    const kept = plan.length - acting.length;
    if (dryRun) {
      output.writeln(`  Would remove or edit ${acting.length} item(s); keep ${kept}`);
      output.writeln();
      output.writeln(
        output.dim('  This was a dry run. Use --force to apply exactly the lines above.'),
      );
      if (plan.some((x) => x.data && x.action === 'skip' && x.reason.includes('--purge-data'))) {
        output.writeln(output.dim('  User data is kept; add --purge-data to remove it as well.'));
      }
    } else {
      output.writeln(
        `  Removed or edited ${removedCount} item(s) totaling ${formatSize(removedSize)}; kept ${kept}`,
      );
    }
    output.writeln();

    return {
      success: failed === 0,
      message: dryRun
        ? `Dry run: ${acting.length} item(s) would be removed or edited`
        : `Removed or edited ${removedCount} item(s)`,
      data: { plan, removedCount, removedSize, dryRun },
    };
  },
};

/** Kept paths: data is always listed in full; other reasons are summarized unless --verbose. */
function printKept(kept: CleanupPlanEntry[], verbose: boolean): void {
  if (kept.length === 0) return;
  output.writeln();
  output.writeln(output.bold('Kept (not provably monomind-owned, tracked, or user data):'));
  const byReason = new Map<string, CleanupPlanEntry[]>();
  for (const e of kept) byReason.set(e.reason, [...(byReason.get(e.reason) ?? []), e]);
  for (const [reason, items] of byReason) {
    const limit = verbose || items.some((i) => i.data) ? items.length : 5;
    for (const i of items.slice(0, limit)) {
      output.writeln(
        output.dim(`  [keep] ${i.kind === 'dir' ? 'dir ' : 'file'}  ${i.path} - ${reason}`),
      );
    }
    if (items.length > limit) {
      output.writeln(
        output.dim(
          `  [keep] ... and ${items.length - limit} more - ${reason} (--verbose lists all)`,
        ),
      );
    }
  }
}

export default cleanupCommand;
