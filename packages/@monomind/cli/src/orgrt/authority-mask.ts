// packages/@monomind/cli/src/orgrt/authority-mask.ts
/**
 * Human authority, kept out of every role — whatever its `policy.git` level
 * and whatever runtime runs it.
 *
 * Three things let a process act as the human who supervises an org:
 *   - the org daemons' operator credentials (`~/.monomind/orgrt-operator/`,
 *     broker.ts), which unlock approve / resolve-gate / answer on a daemon,
 *     and the inbox signing key kept beside them (inbox.ts);
 *   - the dashboard's human-auth secret (`~/.monomind/dashboard-auth/`), from
 *     which its login link and browser session cookie derive;
 *   - the authority files under `.monomind/orgs/` (isAuthorityFile): the org
 *     definitions, which hold every role's own `policy`, and the state that
 *     records a human's decisions or that a daemon or the next run reads
 *     back — gates, approvals, questions, the inbox, runtime.json, the run
 *     event logs, the git guards (#498).
 *
 * Roles below `push` on the Claude runtime already run in the SDK's OS
 * sandbox, and role-sandbox.ts feeds it these paths. Everything else — a
 * `push` role, a role whose sandbox is off or unavailable, and every
 * non-Claude CLI runtime — is launched inside a minimal bubblewrap layer from
 * `authorityMaskArgs()`: the whole filesystem as it is, except that the two
 * directories above are replaced by empty tmpfs mounts (so files created
 * there later are hidden too), the dashboard token files read as empty, and
 * the authority files are read-only. No git, network or write restriction
 * beyond that, so a role behaves exactly as before.
 *
 * File tools are refused every authority file (policy.ts). For Bash they are
 * defence in depth, not the barrier: only files that exist when the role
 * starts can be made read-only, and a process that can write a file's
 * directory can rename the directory away and plant a new one. The barriers
 * are the daemon holding a running org's gates in memory (decisions.ts's
 * gatesFor) and signed inbox entries (inbox.ts).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { dashboardCredentialPaths, operatorDirOverride } from './file-roots.js';

/** Under $HOME: the dashboard's human-auth secret (ui/server.mjs). */
export const DASHBOARD_AUTH_DIR = join('.monomind', 'dashboard-auth');
/** Under $HOME: the org daemons' operator credentials (broker.ts). */
export const OPERATOR_DIR = join('.monomind', 'orgrt-operator');

/** Files in `<root>/.monomind/orgs/<org>/` that record a human's decisions. */
export const DECISION_FILES = ['gates.json', 'approvals.json', 'questions.json', 'inbox.jsonl'];
/** The other files the daemon keeps in an org dir: the resume checkpoint,
 *  the decision trace, run history and the idle deadline. */
export const ORG_STATE_FILES = [
  'runtime.json',
  'decisions.jsonl',
  'history.jsonl',
  'idle-watchdog.json',
];
/** Files in a run dir (`<org>/<run>/`): the run's event log, which records
 *  every approval and gate decision and which checkpoint replay reads, and
 *  its session ledger. */
export const RUN_STATE_FILES = ['bus.jsonl', 'sessions.json'];
/** The dir in an org dir holding each role's git guard (role-sandbox.ts):
 *  the hooks and config that enforce `policy.git`. */
export const GIT_GUARD_DIR = 'git-guard';
/** `.monomind/orgs/<org>-memory/` is the org's PARA memory (the
 *  mastermind-memory skill), written by roles — not an org dir. */
const MEMORY_DIR = /-memory$/;

/**
 * #498: whether `p` is a file no role may write with a file tool, whatever
 * its scope, roots or allowWrite. Under any `.monomind/orgs/`:
 *   - every file directly in it: the org definitions (`<org>.json`/`.yaml`),
 *     which hold each role's own `policy`, and the org artifacts beside them
 *     (`<org>-state.json`, `-secrets`, `-runstate`, remote-hosts.json, ...);
 *   - every file directly in an org dir: the decision files, runtime.json,
 *     decisions.jsonl, history.jsonl, idle-watchdog.json and whatever else
 *     the daemon keeps there;
 *   - a run dir's bus.jsonl and sessions.json, and anything in git-guard/.
 * The subdirectories roles work in (reports/, work/, workspace/, worktree/,
 * .mail/) and the org memory dir stay writable. Pass a real path: the caller
 * resolves symlinks first.
 */
export function isAuthorityFile(p: string): boolean {
  const parts = p.split(/[\\/]/);
  for (let i = 1; i < parts.length - 1; i++) {
    if (parts[i - 1] !== '.monomind' || parts[i] !== 'orgs') continue;
    const [org, second, third, ...rest] = parts.slice(i + 1);
    if (second === undefined) return true;
    if (third === undefined) {
      if (!MEMORY_DIR.test(org)) return true;
      if (DECISION_FILES.includes(second) || ORG_STATE_FILES.includes(second)) return true;
      continue;
    }
    if (second === GIT_GUARD_DIR) return true;
    if (rest.length === 0 && RUN_STATE_FILES.includes(third)) return true;
  }
  return false;
}

/** The directories no role may read. */
export function authorityDirs(home: string, env: NodeJS.ProcessEnv): string[] {
  return [
    ...new Set(
      [join(home, OPERATOR_DIR), operatorDirOverride(env), join(home, DASHBOARD_AUTH_DIR)].filter(
        (d): d is string => !!d,
      ),
    ),
  ];
}

/** Create the authority dirs (owner-only) so they can be masked before
 *  anything is written into them — a mask over a directory also hides files
 *  created after the role started. */
export function ensureAuthorityDirs(home: string, env: NodeJS.ProcessEnv): void {
  for (const d of authorityDirs(home, env)) {
    try {
      mkdirSync(d, { recursive: true, mode: 0o700 });
    } catch {
      /* unmaskable, but nothing can be written there either */
    }
  }
}

/** Existing authority files (isAuthorityFile) under `orgRoot`, with each
 *  org's git-guard dir in place of its contents: the concrete paths the OS
 *  sandbox and the mask make read-only. They cannot protect a pattern, so a
 *  file created after the role started is not covered for Bash. */
export function authorityFilePaths(orgRoot: string | undefined): string[] {
  if (!orgRoot) return [];
  const orgs = join(orgRoot, '.monomind', 'orgs');
  const out: string[] = [];
  const list = (dir: string) => {
    try {
      return readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
  };
  for (const e of list(orgs)) {
    const org = join(orgs, e.name);
    if (e.isFile()) out.push(org);
    if (!e.isDirectory()) continue;
    for (const c of list(org)) {
      const p = join(org, c.name);
      if (c.isFile() && isAuthorityFile(p)) out.push(p);
      else if (c.isDirectory() && c.name === GIT_GUARD_DIR) out.push(p);
      else if (c.isDirectory())
        for (const f of RUN_STATE_FILES) if (existsSync(join(p, f))) out.push(join(p, f));
    }
  }
  return out;
}

/** bubblewrap arguments (before `--`) for the mask; see the module doc. */
export function authorityMaskArgs(ctx: {
  home: string;
  env: NodeJS.ProcessEnv;
  roots: Array<string | undefined>;
  orgRoot?: string;
}): string[] {
  const args = ['--dev-bind', '/', '/'];
  for (const d of authorityDirs(ctx.home, ctx.env)) if (existsSync(d)) args.push('--tmpfs', d);
  for (const f of dashboardCredentialPaths(ctx.roots)) args.push('--ro-bind', '/dev/null', f);
  for (const f of authorityFilePaths(ctx.orgRoot)) args.push('--ro-bind', f, f);
  return args;
}

let probed: { available: boolean; reason?: string } | undefined;

/** Whether the mask can run here: Linux with a bwrap that actually starts
 *  (user namespaces can be disabled even when the binary is installed).
 *  Probed once per process. */
export function authorityMaskAvailability(platform: NodeJS.Platform = process.platform): {
  available: boolean;
  reason?: string;
} {
  if (platform !== 'linux') return { available: false, reason: `no bubblewrap on ${platform}` };
  if (probed) return probed;
  let r: ReturnType<typeof spawnSync>;
  try {
    r = spawnSync('bwrap', ['--dev-bind', '/', '/', '--', 'true'], {
      stdio: 'ignore',
      timeout: 5000,
    });
  } catch (err) {
    probed = { available: false, reason: `bwrap probe failed (${(err as Error).message})` };
    return probed;
  }
  probed =
    r.status === 0
      ? { available: true }
      : {
          available: false,
          reason: r.error
            ? `bwrap not found (${(r.error as NodeJS.ErrnoException).code ?? r.error.message})`
            : `bwrap failed to start (exit ${r.status})`,
        };
  return probed;
}

/** `[command, args]` to spawn: `bin` itself, or `bin` inside the mask. */
export function maskedCommand(
  mask: string[] | undefined,
  bin: string,
  args: string[],
): [string, string[]] {
  return mask?.length ? ['bwrap', [...mask, '--', bin, ...args]] : [bin, args];
}
