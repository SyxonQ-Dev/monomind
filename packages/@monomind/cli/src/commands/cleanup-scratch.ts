/**
 * Cleanup — scratch pruning (--scratch): stale taskdev handoff files and
 * abandoned loop state, plus the shared remove/report and size helpers.
 * Extracted from cleanup.ts.
 */

import { existsSync, lstatSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { output } from '../output.js';

/** Scratch pruning (--scratch): taskdev handoff files and loop state. */
// monolean: manual flag only — upgrade path: invoke from the `cache` background worker so crashed-run scratch is pruned without anyone remembering the flag
const SCRATCH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // taskdev scratch older than this is stale
const LOOP_STALE_GRACE_MS = 24 * 60 * 60 * 1000; // a live loop reschedules every <=1h; overdue by a day = abandoned

/** A single stale-scratch candidate returned by {@link findStaleScratch}. */
export interface StaleScratchItem {
  path: string;
  description: string;
  size: number;
}

/**
 * Find stale mastermind scratch under `.monomind/taskdev/` and `.monomind/loops/`.
 * Exported for tests. Never returns `progress.md` (the taskdev recovery ledger),
 * directories, or loop JSON it cannot parse — deleting the unclassifiable loses data.
 *
 * A loop JSON is only ever classified as abandoned when it has a real, positive,
 * numeric `nextRunAt` timestamp that is more than a day in the past. Live producers
 * write `nextRunAt: 0` (real /do loops) or `nextRunAt: null` (dashboard) — those,
 * along with missing/non-numeric values, are never eligible for deletion regardless
 * of `status`, since a crashed daemon can leave a stale `status: 'running'` behind.
 */
export function findStaleScratch(cwd: string, now: number): StaleScratchItem[] {
  const out: StaleScratchItem[] = [];
  const taskdevDir = join(cwd, '.monomind', 'taskdev');
  if (existsSync(taskdevDir)) {
    for (const f of readdirSync(taskdevDir)) {
      if (f === 'progress.md') continue; // the ledger is the recovery map — never auto-prune
      try {
        const st = lstatSync(join(taskdevDir, f));
        if (st.isFile() && now - st.mtimeMs > SCRATCH_MAX_AGE_MS) {
          out.push({
            path: join('.monomind', 'taskdev', f),
            description: 'stale taskdev scratch',
            size: st.size,
          });
        }
      } catch {
        /* raced away or unreadable — leave it */
      }
    }
  }
  const loopsDir = join(cwd, '.monomind', 'loops');
  if (existsSync(loopsDir)) {
    const entries = readdirSync(loopsDir);
    const jsonStems = new Set(
      entries.filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')),
    );
    for (const f of entries) {
      try {
        const st = lstatSync(join(loopsDir, f));
        if (!st.isFile()) continue;
        if (f.endsWith('.json')) {
          const parsed = JSON.parse(readFileSync(join(loopsDir, f), 'utf8')) as {
            nextRunAt?: unknown;
            status?: unknown;
          };
          const { nextRunAt } = parsed;
          const isStale =
            typeof nextRunAt === 'number' &&
            Number.isFinite(nextRunAt) &&
            nextRunAt > 0 &&
            now - nextRunAt > LOOP_STALE_GRACE_MS;
          if (isStale) {
            out.push({
              path: join('.monomind', 'loops', f),
              description: 'abandoned loop state',
              size: st.size,
            });
          }
        } else if (f.endsWith('.stop') && !jsonStems.has(f.replace(/\.stop$/, ''))) {
          out.push({
            path: join('.monomind', 'loops', f),
            description: 'orphaned loop stopfile',
            size: st.size,
          });
        }
      } catch {
        /* unparseable or unreadable — never delete what we cannot classify */
      }
    }
  }
  return out;
}

/**
 * Report (dry run) or delete a batch of file/dir items, printing the same
 * `[would remove]` / `[removed]` / `[failed]` lines used across cleanup modes.
 * Shared by the scratch branch; the main artifact loop keeps its own copy
 * because of the `--keep-config` `.claude/settings.json` preservation special case.
 */
export function removeOrReport(
  cwd: string,
  items: { path: string; description: string; size: number; type: 'dir' | 'file' }[],
  dryRun: boolean,
): { removed: number; removedSize: number } {
  let removed = 0;
  let removedSize = 0;
  for (const item of items) {
    const sizeStr = formatSize(item.size);
    const typeLabel = item.type === 'dir' ? 'dir ' : 'file';
    if (dryRun) {
      output.writeln(
        output.warning(
          `  [would remove] ${typeLabel}  ${item.path}  (${sizeStr}) - ${item.description}`,
        ),
      );
    } else {
      try {
        rmSync(join(cwd, item.path), { recursive: item.type === 'dir', force: true });
        output.writeln(
          output.success(
            `  [removed] ${typeLabel}  ${item.path}  (${sizeStr}) - ${item.description}`,
          ),
        );
        removed++;
        removedSize += item.size;
      } catch (err) {
        output.writeln(
          output.error(
            `  [failed] ${typeLabel}  ${item.path}  - ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      }
    }
  }
  return { removed, removedSize };
}

/**
 * Format bytes into a human-readable string
 */
export function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** i;
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
