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
 *   - the authority files under `.monomind/orgs/` (org-authority-files.ts):
 *     the org definitions, which hold every role's own `policy`, and the
 *     files that record a human's decisions, the daemon's state and its
 *     control files (#498).
 *
 * Roles below `push` on the Claude runtime already run in the SDK's OS
 * sandbox, and role-sandbox.ts feeds it these paths. Everything else — a
 * `push` role, a role whose sandbox is off or unavailable, and every
 * non-Claude CLI runtime — is launched inside a minimal bubblewrap layer from
 * `authorityMaskArgs()`: the whole filesystem as it is, except that the two
 * directories above are replaced by empty tmpfs mounts (so files created
 * there later are hidden too), the dashboard token files read as empty, and
 * the orgs dir is read-only apart from the subdirectories roles work in —
 * so no org definition, decision or control file can be written, created or
 * renamed, and the org root and `.monomind` cannot be renamed away. No git,
 * network or write restriction beyond that.
 *
 * The SDK sandbox cannot express that layout (its denyWrite binds come after
 * its allowWrite binds, so a writable subdirectory of a denied one stays
 * read-only): there the existing authority files are read-only and the
 * directories above them are mount points that cannot be renamed, but a NEW
 * file can still be created in the orgs dir or an org dir. File tools are
 * refused every authority file by policy.ts on the Claude runtime. The
 * barriers for a running org are the daemon holding its gates in memory
 * (decisions.ts's gatesFor) and signed inbox entries (inbox.ts).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { dashboardCredentialPaths, HOME_DENY_WRITE, operatorDirOverride } from './file-roots.js';
import {
  maskReadOnlyPaths,
  monomindMaskLayout,
  operatorMountPoints,
} from './operator-protected-paths.js';
import { ensureOrgWorkDirs, orgsMaskLayout } from './org-authority-files.js';
import { realPath } from './policy-paths.js';

/** Under $HOME: the dashboard's human-auth secret (ui/server.mjs). */
export const DASHBOARD_AUTH_DIR = join('.monomind', 'dashboard-auth');
/** Under $HOME: the org daemons' operator credentials (broker.ts). */
export const OPERATOR_DIR = join('.monomind', 'orgrt-operator');

export {
  authorityFilePaths,
  CONTROL_FILES,
  DECISION_FILES,
  GIT_GUARD_DIR,
  isAuthorityFile,
  ORG_STATE_FILES,
  RUN_STATE_FILES,
} from './org-authority-files.js';

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

/** bubblewrap arguments (before `--`) for the mask; see the module doc. */
export function authorityMaskArgs(ctx: {
  home: string;
  env: NodeJS.ProcessEnv;
  roots: Array<string | undefined>;
  orgRoot?: string;
  /** The role's cwd and `policy.fileWrite`, for the work dirs to create. */
  cwd?: string;
  fileWrite?: string[];
  /** The role's signed `policy.sandbox.allowWrite` (operator-protected-paths.ts). */
  allowWrite?: string[];
}): string[] {
  const args = ['--dev-bind', '/', '/'];
  // #527: the directories on the way to what the operator's processes run
  // (`~/.local`, `~/.local/share`, …) bound onto themselves, so none can be
  // renamed aside and a new toolchain planted in its place. First, so the
  // binds below nest inside these mount points instead of covering them.
  const anchors = [...new Set(operatorMountPoints(ctx).map(realPath))];
  for (const d of anchors) args.push('--bind', d, d);
  const afterAnchors = args.length;
  // #502 review: ~/.monomind read-only, only its role-writable entries bound
  // back — first, so a work tree below it (binds further down) still opens.
  const mm = monomindMaskLayout(ctx.home, ctx.env);
  for (const d of mm.readOnly.map(realPath)) args.push('--ro-bind', d, d);
  for (const d of mm.writable.map(realPath)) args.push('--bind', d, d);
  // #498: the mask binds only existing work dirs read-write, so create them
  // first (a `git worktree add … work/src` in a masked role needs `work/`).
  ensureOrgWorkDirs(ctx.orgRoot, ctx.fileWrite, ctx.cwd ?? ctx.orgRoot);
  // #498: the org root and its .monomind become mount points, so neither can
  // be renamed away and replaced by a tree with a forged org definition.
  if (ctx.orgRoot)
    for (const d of [ctx.orgRoot, join(ctx.orgRoot, '.monomind')].map(realPath))
      if (existsSync(d)) args.push('--bind', d, d);
  // The orgs dir read-only (no new org definition, runfile or decision file,
  // no rename), the dirs roles work in read-write again, then the authority
  // files those still hold read-only (org-authority-files.ts).
  const hidden = authorityDirs(ctx.home, ctx.env);
  const orgs = orgsMaskLayout(ctx.orgRoot, [ctx.home, ...hidden]);
  for (const d of orgs.readOnly) args.push('--ro-bind', d, d);
  for (const d of orgs.writable) args.push('--bind', d, d);
  for (const f of orgs.files) args.push('--ro-bind', f, f);
  // A writable bind above whose source holds one of those mount points hid
  // it again (bwrap binds the host's tree): repeat it.
  const covering = bindTargets(args.slice(afterAnchors), '--bind');
  for (const d of anchors)
    if (covering.some((t) => d !== t && d.startsWith(t.endsWith(sep) ? t : t + sep)))
      args.push('--bind', d, d);
  // #502 review: what the operator's own processes run or trust, and the
  // shell/git config that would undo the guard.
  for (const p of new Set(
    maskReadOnlyPaths({ ...ctx, homeDenyWrite: HOME_DENY_WRITE }).map(realPath),
  ))
    args.push('--ro-bind', p, p);
  // Last, so that no bind above can uncover them.
  for (const d of hidden) if (existsSync(d)) args.push('--tmpfs', d);
  for (const f of dashboardCredentialPaths(ctx.roots)) args.push('--ro-bind', '/dev/null', f);
  return args;
}

/** Destinations of the `flag` binds in bwrap `args`. */
function bindTargets(args: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) if (args[i] === flag) out.push(args[i + 2]);
  return out;
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
