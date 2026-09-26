/**
 * Vitest globalSetup: run every test worker against a throwaway HOME (#347).
 *
 * Memory and init code write per-project data to ~/.monomind/projects and
 * register projects in ~/.monomind-projects.json; test runs used to leave
 * thousands of folders in the developer's home. This runs in the main vitest
 * process before any worker starts, so the change is in the real process
 * environment: forked workers and child processes inherit it, and in the
 * `threads` pool os.homedir() (which reads the process environment, not a
 * worker's copy of process.env) sees it as well.
 *
 * The real home stays available as MONOMIND_TEST_REAL_HOME for suites that
 * need credentials from it (live, env-gated suites); the npm cache keeps
 * pointing at the real one so spawned npm/npx do not re-download packages.
 * A nested run (a test that starts a child vitest) keeps the outer run's
 * MONOMIND_TEST_REAL_HOME, unless the parent removes it on purpose.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const KEYS = [
  'HOME',
  'USERPROFILE',
  'MONOMIND_GLOBAL_BRAIN_DIR',
  'MONOMIND_TEST_REAL_HOME',
  'npm_config_cache',
] as const;

/** Points HOME and the global brain at `home`. Shared with the per-file setup. */
export function useTestHome(home: string): void {
  process.env.HOME = home;
  if (process.platform === 'win32') process.env.USERPROFILE = home;
  process.env.MONOMIND_GLOBAL_BRAIN_DIR = join(home, '.monomind', 'global-brain');
}

export default function setup(): () => void {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  const realHome =
    process.env.MONOMIND_TEST_REAL_HOME ??
    (process.platform === 'win32' ? process.env.USERPROFILE : process.env.HOME);
  if (realHome) {
    process.env.MONOMIND_TEST_REAL_HOME = realHome;
    // Windows keeps the npm cache under LOCALAPPDATA, which HOME does not move.
    if (process.platform !== 'win32') process.env.npm_config_cache ??= join(realHome, '.npm');
  }
  const home = mkdtempSync(join(tmpdir(), 'mm-test-run-home-'));
  useTestHome(home);
  return () => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(home, { recursive: true, force: true });
  };
}
