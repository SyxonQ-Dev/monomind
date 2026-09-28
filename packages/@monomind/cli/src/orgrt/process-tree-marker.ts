// packages/@monomind/cli/src/orgrt/process-tree-marker.ts
/**
 * Coder mode (#359): find a full-access turn's processes by an inherited
 * environment marker instead of by timing.
 *
 * `agent-runner-claude-fullaccess.ts` puts `MONOMIND_EXEC_TREE=<random
 * uuid>` in the `claude` child's env. Every descendant inherits it —
 * including a `nohup cmd &` job that was reparented to init/a subreaper
 * after its launching Bash-tool shell exited (live-verified against the
 * installed Claude Code CLI) — so a scan at kill/report time finds it no
 * matter how briefly the shell lived. A process that clears or rewrites
 * its own environment (`env -i`, some daemons) escapes this scan; the
 * sampled process-group tracking in process-tree.ts still covers those
 * when a sample caught their launching shell.
 *
 * Only processes of the same user are readable (`/proc/<pid>/environ` is
 * owner-only; `ps -E` shows only one's own env), which is exactly the set
 * a full-access turn can start.
 */

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';

export const EXEC_TREE_ENV = 'MONOMIND_EXEC_TREE';

/** Pids whose environment carries `EXEC_TREE_ENV=<token>`, excluding this
 *  process. Best effort: unreadable entries are skipped, never fatal. */
export function pidsWithMarker(token: string, plat: NodeJS.Platform = process.platform): number[] {
  if (plat === 'win32' || !token) return [];
  const needle = `${EXEC_TREE_ENV}=${token}`;
  const pids: number[] = [];
  if (plat === 'linux') {
    let entries: string[];
    try {
      entries = readdirSync('/proc');
    } catch {
      return pids;
    }
    for (const name of entries) {
      if (!/^\d+$/.test(name)) continue;
      const pid = Number(name);
      if (pid === process.pid) continue;
      try {
        const env = readFileSync(`/proc/${pid}/environ`, 'latin1');
        if (env.split('\0').includes(needle)) pids.push(pid);
      } catch {
        /* other user's process, or exited mid-scan */
      }
    }
    return pids;
  }
  // macOS/BSD: `ps -E` appends each own process's environment to its command.
  try {
    const res = spawnSync('ps', ['-E', '-ww', '-axo', 'pid=,command='], { encoding: 'utf8' });
    if (res.status !== 0 || !res.stdout) return pids;
    for (const line of res.stdout.split('\n')) {
      if (!line.includes(needle)) continue;
      const pid = Number(line.trim().split(/\s+/)[0]);
      if (Number.isInteger(pid) && pid > 1 && pid !== process.pid) pids.push(pid);
    }
  } catch {
    /* ps missing — nothing found */
  }
  return pids;
}
