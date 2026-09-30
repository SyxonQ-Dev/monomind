// packages/@monomind/cli/src/orgrt/operator-protected-paths.ts
/**
 * #502 review: paths no role may write because the OPERATOR's own processes
 * run or trust what is in them. A role that could write one could get code
 * run outside every role sandbox:
 *   - `<orgRoot>/.claude/` — the operator's Claude Code session in the
 *     project loads its settings, hooks and helpers;
 *   - `~/.monomind/` — the org skill library that decides the MCP tools the
 *     daemon grants, the terminal-execution opt-in gate, the broker
 *     registry, audit logs… — except the entries the CLI legitimately
 *     writes while a role uses it (ROLE_WRITABLE_MONOMIND);
 *   - `<project>/.monomind/org-skills/` (the project skill library);
 *   - `~/.npm/_npx` (what `npx -y monomind …` runs), `~/.npmrc`,
 *     `~/.local/bin`, and shell startup files beyond HOME_DENY_WRITE.
 *
 * Enforced three ways: the SDK sandbox's `denyWrite`, read-only binds in the
 * bubblewrap authority mask, and the file tools' deny pass (policy.ts). An
 * explicit, signed `policy.sandbox.allowWrite` entry at or inside one of
 * these paths is the opt-out for an org that really must write it.
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

/** `~/.monomind` entries a role's own `monomind` commands write: browser
 *  automation state, the embedding-model cache, per-project memory, update
 *  checks, runner session dirs, and the release locks. Nothing the
 *  operator's processes execute or treat as a grant. */
export const ROLE_WRITABLE_MONOMIND = new Set([
  'browser-sessions',
  'browser-reports',
  'browse.db',
  'browse.db-wal',
  'browse.db-shm',
  'browse-runs.json',
  'models',
  'cache',
  'neural',
  'projects',
  'sessions',
  'sessions.json',
  'statusline-cache.json',
  'update-state.json',
  'update-history.json',
  'crash-reports.json',
  'pending-reports',
  'release-locks',
  'mcp.log',
  'mcp.pid',
]);

/** The allowlisted entries that are directories: created before the mask
 *  is built, so the mask can bind them writable inside a read-only
 *  ~/.monomind. */
const ROLE_WRITABLE_MONOMIND_DIRS = [
  'browser-sessions',
  'browser-reports',
  'models',
  'cache',
  'neural',
  'projects',
  'sessions',
  'pending-reports',
  'release-locks',
];

/** #502 review round 2: the bubblewrap mask's layout for ~/.monomind (and
 *  $MONOMIND_HOME): the directory itself read-only, so no new top-level
 *  entry can be planted, and only the allowlisted entries bound writable
 *  again — the same pattern as the orgs dir. An allowlisted FILE that does
 *  not exist yet cannot be created inside the mask. */
export function monomindMaskLayout(
  home: string,
  env: NodeJS.ProcessEnv,
): { readOnly: string[]; writable: string[] } {
  const roots = [...new Set([join(home, '.monomind'), monomindHome(home, env)])].filter((d) =>
    existsSync(d),
  );
  const writable: string[] = [];
  for (const root of roots) {
    for (const d of ROLE_WRITABLE_MONOMIND_DIRS) {
      try {
        mkdirSync(join(root, d), { recursive: true });
      } catch {
        /* left read-only */
      }
    }
    for (const e of ROLE_WRITABLE_MONOMIND)
      if (existsSync(join(root, e))) writable.push(join(root, e));
  }
  return { readOnly: roots, writable };
}

/** Under $HOME, beyond file-roots.ts's HOME_DENY_WRITE. */
export const HOME_OPERATOR_EXEC = [
  '.npm/_npx',
  '.npmrc',
  '.local/bin',
  '.config/fish',
  '.bashrc.d',
  '.zshrc.d',
];

/** Inside ~/.claude, the entries Claude Code executes or obeys. Used by the
 *  bubblewrap mask, which also wraps Claude Code itself and so cannot make
 *  the whole of ~/.claude (sessions, todos, credentials) read-only. */
export const CLAUDE_HOME_EXEC = [
  // The legacy global config: Claude Code prefers it over ~/.claude.json
  // whenever it exists (#502 review round 3).
  '.config.json',
  'settings.json',
  'settings.local.json',
  'hooks',
  'commands',
  'skills',
  'agents',
  'plugins',
  'helpers',
  'output-styles',
  'CLAUDE.md',
];

export const monomindHome = (home: string, env: NodeJS.ProcessEnv): string =>
  env.MONOMIND_HOME ? resolve(env.MONOMIND_HOME) : join(home, '.monomind');

const within = (container: string, p: string): boolean =>
  p === container || p.startsWith(container.endsWith(sep) ? container : container + sep);

interface ProtectedCtx {
  home: string;
  env: NodeJS.ProcessEnv;
  orgRoot?: string;
  cwd?: string;
  allowWrite?: string[];
}

/** The signed `policy.sandbox.allowWrite` entries, absolute. */
export const optInPaths = (ctx: ProtectedCtx): string[] =>
  (ctx.allowWrite ?? []).map((p) => resolve(ctx.orgRoot ?? ctx.cwd ?? '.', p));

/** Is `p` protected: inside a protected path and not inside an opt-in? */
export function isOperatorProtected(
  p: string,
  ctx: ProtectedCtx,
  real: (x: string) => string,
): string | undefined {
  if (optInPaths(ctx).some((a) => within(real(a), p) || within(a, p))) return undefined;
  return protectedCandidates(ctx).find((d) => within(real(d), p) || within(d, p));
}

/** `p` with `optIn` carved out of it, for an OS layer that can only deny
 *  whole paths: `p` itself when nothing inside it is opted in, nothing when
 *  an opt-in covers it, else its children (recursively) less the branch that
 *  holds the opt-in. */
function carve(p: string, optIn: string[]): string[] {
  if (optIn.some((a) => within(a, p))) return [];
  const inside = optIn.filter((a) => within(p, a));
  if (!inside.length) return [p];
  let entries: string[];
  try {
    entries = readdirSync(p);
  } catch {
    return [p];
  }
  return entries.flatMap((e) => carve(join(p, e), inside));
}

/** Every protected path (existing or not) for a role with this org root and
 *  cwd, with what a signed `policy.sandbox.allowWrite` entry opts into
 *  carved out — the form the SDK sandbox and the bubblewrap mask take. */
export function operatorProtectedPaths(ctx: ProtectedCtx): string[] {
  const optIn = optInPaths(ctx);
  return protectedCandidates(ctx).flatMap((p) => carve(p, optIn));
}

function protectedCandidates(ctx: ProtectedCtx): string[] {
  const mmHome = monomindHome(ctx.home, ctx.env);
  const monomindEntries: string[] = [];
  try {
    for (const e of readdirSync(mmHome))
      if (!ROLE_WRITABLE_MONOMIND.has(e)) monomindEntries.push(join(mmHome, e));
  } catch {
    /* no ~/.monomind yet */
  }
  const roots = [...new Set([ctx.orgRoot, ctx.cwd].filter((r): r is string => !!r))];
  const paths = [
    ...roots.map((r) => join(r, '.claude')),
    // The project's MCP servers, which the operator's Claude Code starts.
    ...roots.map((r) => join(r, '.mcp.json')),
    ...roots.map((r) => join(r, '.monomind', 'org-skills')),
    join(mmHome, 'org-skills'),
    join(mmHome, 'enable-terminal.json'),
    ...monomindEntries,
    ...HOME_OPERATOR_EXEC.map((p) => join(ctx.home, p)),
  ];
  return [...new Set(paths)];
}

/** Paths the bubblewrap mask binds read-only: the protected paths plus the
 *  guard-undoing home files, with ~/.claude narrowed to CLAUDE_HOME_EXEC. */
export function maskReadOnlyPaths(ctx: {
  home: string;
  env: NodeJS.ProcessEnv;
  orgRoot?: string;
  cwd?: string;
  allowWrite?: string[];
  homeDenyWrite: string[];
}): string[] {
  // ~/.claude.json holds the operator's `mcpServers`: read-only too. Claude
  // Code itself runs inside the mask and writes that file on its own, and
  // copes with it being read-only (operator-paths-sdk.test.ts).
  const home = ctx.homeDenyWrite.filter((p) => p !== '.claude').map((p) => join(ctx.home, p));
  const claude = CLAUDE_HOME_EXEC.map((p) => join(ctx.home, '.claude', p));
  return [...new Set([...home, ...claude, ...operatorProtectedPaths(ctx)])].filter((p) =>
    existsSync(p),
  );
}

/** Create what must exist before a role starts for the denies to hold: an
 *  OS sandbox can only protect a path that exists, and a role creating one
 *  of these first would plant it. The skill libraries and the npx cache are
 *  empty directories; the terminal gate is written as disabled, which is
 *  what its absence already meant (terminal-tools-core.ts). */
export function ensureOperatorProtectedPaths(ctx: {
  home: string;
  env: NodeJS.ProcessEnv;
  orgRoot?: string;
}): void {
  const mmHome = monomindHome(ctx.home, ctx.env);
  const dirs = [join(mmHome, 'org-skills'), join(ctx.home, '.npm', '_npx')];
  if (ctx.orgRoot) dirs.push(join(ctx.orgRoot, '.monomind', 'org-skills'));
  for (const d of dirs) {
    try {
      mkdirSync(d, { recursive: true });
    } catch {
      /* unwritable: nothing can plant it either */
    }
  }
  const gate = join(mmHome, 'enable-terminal.json');
  try {
    writeFileSync(gate, '{ "enabled": false }\n', { flag: 'wx' });
  } catch {
    /* exists (the operator's own choice) or unwritable */
  }
}
