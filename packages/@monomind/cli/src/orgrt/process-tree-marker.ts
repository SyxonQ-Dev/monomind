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

export interface MarkerScan {
  /** Pids whose environment carries `EXEC_TREE_ENV=<token>`. */
  marked: number[];
  /** Pids that carry `EXEC_TREE_ENV` with any OTHER value (`''` included):
   *  setup daemons a session hook started (#366) or another turn's tree.
   *  They have left this turn's tree — never killed or reported by it. */
  foreign: Set<number>;
}

/** One pass over the process table for `token`, excluding this process.
 *  Best effort: unreadable entries are skipped, never fatal. */
export function scanMarkers(token: string, plat: NodeJS.Platform = process.platform): MarkerScan {
  const scan: MarkerScan = { marked: [], foreign: new Set() };
  if (plat === 'win32' || !token) return scan;
  const needle = `${EXEC_TREE_ENV}=${token}`;
  const classify = (pid: number, vars: string[]) => {
    const own = vars.find((v) => v.startsWith(`${EXEC_TREE_ENV}=`));
    if (own === undefined) return;
    if (own === needle) scan.marked.push(pid);
    else scan.foreign.add(pid);
  };
  if (plat === 'linux') {
    let entries: string[];
    try {
      entries = readdirSync('/proc');
    } catch {
      return scan;
    }
    for (const name of entries) {
      if (!/^\d+$/.test(name)) continue;
      const pid = Number(name);
      if (pid === process.pid) continue;
      try {
        classify(pid, readFileSync(`/proc/${pid}/environ`, 'latin1').split('\0'));
      } catch {
        /* other user's process, or exited mid-scan */
      }
    }
    return scan;
  }
  // macOS/BSD: `ps -E` appends each own process's environment to its command.
  try {
    const res = spawnSync('ps', ['-E', '-ww', '-axo', 'pid=,command='], { encoding: 'utf8' });
    if (res.status !== 0 || !res.stdout) return scan;
    for (const line of res.stdout.split('\n')) {
      if (!line.includes(`${EXEC_TREE_ENV}=`)) continue;
      const pid = Number(line.trim().split(/\s+/)[0]);
      if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) continue;
      classify(pid, line.split(/\s+/));
    }
  } catch {
    /* ps missing — nothing found */
  }
  return scan;
}

/** Pids whose environment carries `EXEC_TREE_ENV=<token>`, excluding this
 *  process. */
export function pidsWithMarker(token: string, plat: NodeJS.Platform = process.platform): number[] {
  return scanMarkers(token, plat).marked;
}
