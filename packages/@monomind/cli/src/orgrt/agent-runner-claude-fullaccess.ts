// packages/@monomind/cli/src/orgrt/agent-runner-claude-fullaccess.ts
/**
 * Coder mode (#359, part of the Coder mode epic #364): the `spawnClaudeCodeProcess`
 * hook `agent-runner-claude.ts` installs for `args.access === 'full'`. Kept out of
 * that file (already near the 500-line project limit, and shared with #355/#356/
 * #357's flag-plumbing edits) so this stays a small, isolated addition.
 *
 * See process-tree.ts's module doc for why a process GROUP, not a PPID walk,
 * is the mechanism: a group survives an intermediate process exiting and its
 * orphan being reparented away, which a parent/child chain does not.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { maskedCommand } from './authority-mask.js';

interface ClaudeSpawnOptions {
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string | undefined>;
  signal?: AbortSignal;
}

/** Full-access spawn — same masked/plain command resolution as
 *  `maskedClaudeSpawn` (agent-runner-claude.ts), but the child becomes the
 *  leader of its OWN process group (`detached: true`; POSIX: pgid becomes
 *  its own pid) instead of joining monomind's, so a group-wide signal
 *  (process-tree.ts's `signalGroup`) reaches every descendant the Bash tool
 *  starts — grandchildren (`sh -c '...'`) and `&` background jobs included
 *  — with one call, not just this one process. `onSpawn` hands the pid to
 *  the caller so `agent-runner-claude.ts`'s `run()` can target the group on
 *  abort and `agent-exec.ts` can list background survivors on a normal
 *  end_turn (`AgentRunArgs.onProcessSpawned`).
 *
 *  Scoped mode never calls this — `agent-runner-claude.ts` only takes this
 *  branch when `args.access === 'full'`; `maskedClaudeSpawn`'s plain,
 *  non-detached spawn stays byte-identical for every other caller. */
export function fullAccessClaudeSpawn(
  mask: string[],
  onSpawn: (pid: number) => void,
): (o: ClaudeSpawnOptions) => ChildProcess {
  return (o) => {
    const [cmd, argv] = maskedCommand(mask, o.command, o.args);
    const child = spawn(cmd, argv, {
      cwd: o.cwd,
      env: o.env as NodeJS.ProcessEnv,
      // Deliberately NOT `signal: o.signal` here (unlike maskedClaudeSpawn):
      // that signal fires only after the SDK's own stdin-EOF + ~2s grace
      // window and would kill just THIS process — racing ahead of, and
      // duplicating, the group-wide kill ladder `run()` drives off
      // `args.signal`, which is this runner's sole termination path for
      // full access.
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stderr?.resume();
    if (typeof child.pid === 'number') onSpawn(child.pid);
    return child;
  };
}
