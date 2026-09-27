// packages/@monomind/cli/src/orgrt/sandbox-stubs-paths.ts
// Split out of sandbox-stubs.ts (file-size sweep) — the lists of paths the
// SDK sandbox binds stubs for, and sandboxStubPaths() which enumerates them
// for a given role. See sandbox-stubs.ts's header for the full rationale.
import { basename, dirname, join, sep } from 'node:path';

/** Relative to the role's cwd and to each sandbox-writable directory above it. */
const PROJECT_STUBS = [
  '.mcp.json',
  '.claude/settings.json',
  '.claude/settings.local.json',
  '.claude/agents',
  '.claude/commands',
  '.claude/hooks',
  '.claude/skills',
  '.claude/workflows',
  '.claude/routines',
  '.claude/output-styles',
  '.claude/launch.json',
  '.claude/loop.md',
  '.claude/scheduled_tasks.json',
];

/** Relative to the role's cwd. Also what git-guard.ts hides from `git add`. */
export const CWD_STUBS = [
  '.bashrc',
  '.bash_profile',
  '.profile',
  '.zshrc',
  '.zprofile',
  '.gitconfig',
  '.gitmodules',
  '.ripgreprc',
  '.idea',
  '.vscode',
  ...PROJECT_STUBS,
];

/** Relative to the Claude config dir ($CLAUDE_CONFIG_DIR, else ~/.claude). */
export const CONFIG_DIR_STUBS = [
  'settings.json',
  'settings.local.json',
  'CLAUDE.md',
  'agents',
  'commands',
  'hooks',
  'skills',
  'rules',
  'workflows',
  'routines',
  'output-styles',
  'ide',
  'local',
  'jobs',
  'daemon',
  'daemon.json',
  'launch.json',
  'loop.md',
  'policy-limits.json',
  'scheduled_tasks.json',
];

/** Relative to where the global config file lives ($CLAUDE_CONFIG_DIR, else $HOME). */
export const GLOBAL_CONFIG_STUBS = [
  '.claude-custom-oauth.json',
  '.claude-local-oauth.json',
  '.claude-staging-oauth.json',
];

/** Relative to ~/.claude, only without CLAUDE_CONFIG_DIR: never the CLI's
 *  config there (sandbox-stubs-sdk.test.ts shows it reading and writing only
 *  ~/.claude/.config.json or $HOME/.claude.json). */
const HOME_CONFIG_DIR_STUBS = ['.claude.json', ...GLOBAL_CONFIG_STUBS];

const within = (root: string, p: string): boolean =>
  p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);

/** Every stub path the sandbox binds for a role with this cwd and HOME, where
 *  `writableRoots` is the sandbox's `filesystem.allowWrite`. A `.claude`
 *  directory comes before the files in it. */
export function sandboxStubPaths(ctx: {
  cwd: string;
  home: string;
  writableRoots: string[];
  env?: NodeJS.ProcessEnv;
}): string[] {
  const configDir = ctx.env?.CLAUDE_CONFIG_DIR;
  const above: string[] = [];
  for (let d = dirname(ctx.cwd); ; d = dirname(d)) {
    if (ctx.writableRoots.some((r) => within(r, d))) above.push(d);
    if (d === dirname(d)) break;
  }
  const project = (dir: string) => [
    join(dir, '.claude'),
    ...PROJECT_STUBS.map((p) => join(dir, p)),
  ];
  return [
    ...project(ctx.cwd),
    ...CWD_STUBS.filter((p) => !PROJECT_STUBS.includes(p)).map((p) => join(ctx.cwd, p)),
    join(ctx.cwd, '.git', 'config.worktree'),
    ...above.flatMap(project),
    ...CONFIG_DIR_STUBS.map((p) => join(configDir ?? join(ctx.home, '.claude'), p)),
    ...GLOBAL_CONFIG_STUBS.map((p) => join(configDir ?? ctx.home, p)),
    ...(configDir === undefined
      ? HOME_CONFIG_DIR_STUBS.map((p) => join(ctx.home, '.claude', p))
      : []),
    join(ctx.home, '.mcp.json'),
  ];
}

/** Every name a stub can have: a ledger entry naming anything else is not
 *  reclaimed, whatever it says (the ledger lives in a directory the roles'
 *  sandboxed shells can write). */
export const STUB_NAMES = new Set(
  [
    '.claude',
    'config.worktree',
    ...CWD_STUBS,
    ...CONFIG_DIR_STUBS,
    ...GLOBAL_CONFIG_STUBS,
    ...HOME_CONFIG_DIR_STUBS,
  ].map((p) => basename(p)),
);
