// packages/@monomind/cli/src/orgrt/operator-toolchain-paths.ts
/**
 * #527: the toolchains the operator's own processes run, when a role could
 * write them. node, npm and monomind installed under $HOME (mise, nvm,
 * volta, fnm, asdf, bun, pnpm, …) sit inside the SDK sandbox's allowWrite
 * and the bubblewrap mask's writable $HOME: a role that replaced one, or
 * planted a file in a directory on PATH, would run as the operator, outside
 * every sandbox, the next time the daemon or an operator shell starts it.
 * operator-protected-paths.ts adds these paths to its list, which feeds the
 * file-tool deny, the SDK sandbox's denyWrite, the mask's read-only binds
 * and the planted-path watch.
 *
 * Covered, as real paths:
 *   - `process.execPath` and its install root (`…/installs/node/<ver>`);
 *   - the running CLI's package root, and the npm prefix or `node_modules`
 *     it was installed into;
 *   - every absolute directory on the daemon's PATH, and the directory
 *     holding a symlink on the way to one (fnm's `fnm_multishells`);
 *   - `node`, `npm`, `npx` and `claude` as found on PATH, each with its
 *     install root (a PATH hit that is a symlink: its directory);
 *   - the version-manager roots (versionManagerPaths) that exist, that an
 *     environment variable names, or that a PATH entry lies in; mise's trust
 *     store and direnv's allow list, which decide what an operator shell
 *     runs on `cd`.
 * Only what a role could write matters: a path whose nearest existing
 * ancestor is not writable (`/usr/bin/node`) is left out, and so is one
 * that does not exist outside $HOME. A directory that holds $HOME, an XDG
 * base directory, the temp dir or a role's work tree is never protected.
 *
 * Roles still read and run all of it. A role that installs a global tool
 * gets EROFS; `npm_config_prefix=$TMPDIR/npm-global` installs it in the
 * role's own temp dir instead. toolchainRoleEnv moves a role's pnpm store
 * out of the protected pnpm home.
 */
import { accessSync, constants, existsSync, lstatSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realPath } from './policy-paths.js';

/** The environment variables toolchainPaths reads (its memo key). */
export const TOOLCHAIN_ENV = [
  'PATH',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'XDG_CONFIG_HOME',
  'MISE_DATA_DIR',
  'MISE_CONFIG_DIR',
  'MISE_STATE_DIR',
  'NVM_DIR',
  'VOLTA_HOME',
  'FNM_DIR',
  'ASDF_DATA_DIR',
  'BUN_INSTALL',
  'PNPM_HOME',
  'CARGO_HOME',
  'RUSTUP_HOME',
  'PYENV_ROOT',
  'RBENV_ROOT',
  'GOPATH',
  'GOBIN',
] as const;

/** Binaries looked up on PATH. */
export const TOOLCHAIN_BINARIES = ['node', 'npm', 'npx', 'claude'];

const envDir = (env: NodeJS.ProcessEnv, k: string): string | undefined => {
  const v = env[k];
  return v && isAbsolute(v) ? resolve(v) : undefined;
};

/** The XDG base directories, with their $HOME defaults. */
export function xdgDirs(home: string, env: NodeJS.ProcessEnv) {
  return {
    data: envDir(env, 'XDG_DATA_HOME') ?? join(home, '.local', 'share'),
    state: envDir(env, 'XDG_STATE_HOME') ?? join(home, '.local', 'state'),
    config: envDir(env, 'XDG_CONFIG_HOME') ?? join(home, '.config'),
  };
}

const absPathDirs = (env: NodeJS.ProcessEnv): string[] =>
  (env.PATH ?? '')
    .split(delimiter)
    .filter((d) => isAbsolute(d))
    .map((d) => resolve(d));

/** A manager path, and the root whose use makes it relevant before it
 *  exists. `precreate`: created empty at org start when in use and absent,
 *  so it is bound read-only and never "appears" to the planted-path watch
 *  when the operator later installs into it. */
export interface ManagerPath {
  path: string;
  /** An environment variable chose it, or its tool is in use. */
  named: boolean;
  anchor: string;
  precreate?: boolean;
}

/** The known version-manager and global-install locations. bun keeps its
 *  package cache beside its global installs: only those are protected.
 *  pnpm's home is protected whole (it is on PATH, where one new file
 *  shadows `git`); toolchainRoleEnv moves a role's store out of it. */
export function versionManagerPaths(home: string, env: NodeJS.ProcessEnv): ManagerPath[] {
  const x = xdgDirs(home, env);
  const pathDirs = absPathDirs(env);
  const out: ManagerPath[] = [];
  const add = (paths: string[], anchor: string, named: boolean, precreate = false) => {
    for (const path of paths) out.push({ path, named, anchor, precreate });
  };
  const one = (k: string, fallback: string[]) => {
    const named = envDir(env, k);
    if (named) add([named], named, true);
    else for (const f of fallback) add([f], f, false);
  };
  const miseData = envDir(env, 'MISE_DATA_DIR') ?? join(x.data, 'mise');
  one('MISE_DATA_DIR', [miseData]);
  one('NVM_DIR', [join(home, '.nvm')]);
  one('VOLTA_HOME', [join(home, '.volta')]);
  one('FNM_DIR', [join(home, '.fnm'), join(x.data, 'fnm')]);
  one('ASDF_DATA_DIR', [join(home, '.asdf')]);
  one('RUSTUP_HOME', [join(home, '.rustup')]);
  one('PYENV_ROOT', [join(home, '.pyenv')]);
  one('RBENV_ROOT', [join(home, '.rbenv')]);
  const cargo = envDir(env, 'CARGO_HOME');
  const cargoBin = join(cargo ?? join(home, '.cargo'), 'bin');
  add([cargoBin], cargoBin, !!cargo, true);
  const gopath = env.GOPATH?.split(delimiter).find((d) => isAbsolute(d));
  const gobin =
    envDir(env, 'GOBIN') ?? (gopath ? join(resolve(gopath), 'bin') : join(home, 'go', 'bin'));
  add([gobin], gobin, !!(env.GOBIN || gopath), true);
  const bunRoot = envDir(env, 'BUN_INSTALL') ?? join(home, '.bun');
  add([join(bunRoot, 'bin'), join(bunRoot, 'install', 'global')], bunRoot, !!env.BUN_INSTALL, true);
  const pnpm = pnpmHome(home, env);
  add([pnpm], pnpm, !!env.PNPM_HOME, true);
  // #527 review B2: mise's trust store and direnv's allow list decide what an
  // operator shell runs when it enters a directory (`[env] _.source`,
  // `.envrc`): a role that trusted its own planted config would run there.
  const onPath = (bin: string) => pathDirs.some((d) => existsSync(join(d, bin)));
  const miseUsed =
    exists(miseData) ||
    onPath('mise') ||
    TOOLCHAIN_ENV.some((k) => k.startsWith('MISE_') && env[k]);
  // #527 review round 2: mise trusts its global config dir, so a role that
  // created `config.toml` there with `[env] _.source` would run in every
  // mise-activated operator shell: covered (and created) whenever mise is.
  const miseConfig = envDir(env, 'MISE_CONFIG_DIR') ?? join(x.config, 'mise');
  add([miseConfig], miseConfig, miseUsed, true);
  const miseState = envDir(env, 'MISE_STATE_DIR') ?? join(x.state, 'mise');
  for (const d of ['trusted-configs', 'ignored-configs'])
    add([join(miseState, d)], join(miseState, d), miseUsed, true);
  add([join(home, '.mise.toml')], join(home, '.mise.toml'), miseUsed);
  add([join(home, '.tool-versions')], join(home, '.tool-versions'), false);
  // direnv: its allow list, and its global config dir (`direnvrc`,
  // `direnv.toml`), which every direnv-hooked operator shell loads.
  const direnvUsed = onPath('direnv') || exists(join(x.data, 'direnv'));
  for (const d of [join(x.data, 'direnv', 'allow'), join(x.config, 'direnv')])
    add([d], d, direnvUsed, true);
  return out;
}

const pnpmHome = (home: string, env: NodeJS.ProcessEnv): string =>
  envDir(env, 'PNPM_HOME') ?? join(xdgDirs(home, env).data, 'pnpm');

const within = (container: string, p: string): boolean =>
  p === container || p.startsWith(container.endsWith(sep) ? container : container + sep);

const exists = (p: string): boolean => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

const canWrite = (p: string): boolean => {
  try {
    accessSync(p, constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

/** Could a process running as this user write, replace or create `p`? */
export function roleWritable(p: string): boolean {
  for (let a = p; ; a = dirname(a)) {
    if (exists(a)) {
      if (canWrite(a)) return true;
      if (a !== p) return false;
    }
    if (dirname(a) === a) return false;
  }
}

/** The first executable `name` on `pathVar`. */
export function onPath(name: string, pathVar: string | undefined): string | undefined {
  for (const dir of (pathVar ?? '').split(delimiter)) {
    if (!isAbsolute(dir)) continue;
    const f = join(dir, name);
    try {
      if (!statSync(f).isFile()) continue;
      accessSync(f, constants.X_OK);
      return f;
    } catch {
      /* not here */
    }
  }
  return undefined;
}

const NPM_PREFIX_MARK = `${sep}lib${sep}node_modules${sep}`;

/** Directories too general to make read-only: $HOME, what holds it, and
 *  the (XDG) base directories under it. An npm prefix of `~/.local`
 *  protects its bin and lib/node_modules instead. */
function isGeneric(dir: string, home: string, env: NodeJS.ProcessEnv = {}): boolean {
  const x = xdgDirs(home, env);
  const generic = [
    join(home, '.local'),
    join(home, '.local', 'share'),
    join(home, '.local', 'state'),
    join(home, '.config'),
    join(home, '.cache'),
    x.data,
    x.state,
    x.config,
  ];
  return (
    within(dir, home) ||
    within(dir, realPath(home)) ||
    generic.some((g) => dir === g || dir === realPath(g))
  );
}

/** The install root of a real file: the npm prefix of a file inside
 *  `<prefix>/lib/node_modules`, the prefix of a `<prefix>/bin/<file>`, and
 *  Claude Code's native data dir for `…/claude/versions/<ver>`. */
export function installRoots(file: string, home: string): string[] {
  const i = file.indexOf(NPM_PREFIX_MARK);
  let prefix: string;
  if (i > 0) prefix = file.slice(0, i);
  else if (basename(dirname(file)) === 'bin') prefix = dirname(dirname(file));
  else if (basename(dirname(file)) === 'versions') return [dirname(dirname(file))];
  else return [];
  return isGeneric(prefix, home)
    ? [join(prefix, 'bin'), join(prefix, 'lib', 'node_modules')]
    : [prefix];
}

/** The package root of the running CLI (the nearest package.json above
 *  this module). */
export function defaultPackageRoot(): string | undefined {
  let d = dirname(fileURLToPath(import.meta.url));
  for (; dirname(d) !== d; d = dirname(d)) if (existsSync(join(d, 'package.json'))) return d;
  return undefined;
}

/** A package root, and what it was installed into: the npm prefix for a
 *  global install, else the outermost `node_modules` holding it (npx). */
function packagePaths(pkg: string, home: string): string[] {
  const r = realPath(pkg);
  if (r.includes(NPM_PREFIX_MARK)) return [r, ...installRoots(r, home)];
  const nm = r.indexOf(`${sep}node_modules${sep}`);
  return nm > 0 ? [r, r.slice(0, nm + `${sep}node_modules`.length)] : [r];
}

/** A binary: its real path and install root, and where PATH found it (the
 *  directory when that is a symlink, which a read-only bind cannot pin). */
function binaryPaths(hit: string, home: string): string[] {
  let link = false;
  try {
    link = lstatSync(hit).isSymbolicLink();
  } catch {
    return [];
  }
  const r = realPath(hit);
  return [link ? realPath(dirname(hit)) : r, r, ...installRoots(r, home)];
}

const warned = new Set<string>();

/** A PATH directory, and the directory holding each symlink on the way to
 *  it: a role that could replace the link would redirect the whole entry.
 *  A symlink whose directory is too general to protect is only reported. */
function pathEntryPaths(dir: string, home: string, env: NodeJS.ProcessEnv, tmp: string): string[] {
  const out = [realPath(dir)];
  for (let p = dir; dirname(p) !== p; p = dirname(p)) {
    let link = false;
    try {
      link = lstatSync(p).isSymbolicLink();
    } catch {
      continue;
    }
    const parent = dirname(p);
    if (!link || !roleWritable(parent)) continue;
    if (isGeneric(parent, home, env) || within(parent, tmp)) {
      if (!warned.has(p)) {
        warned.add(p);
        console.warn(
          `monomind: PATH entry ${dir} goes through the symlink ${p}, in ${parent}, which org roles can write and which is too general to make read-only; move it to a dedicated directory.`,
        );
      }
      continue;
    }
    out.push(realPath(parent));
  }
  return out;
}

export interface ToolchainProbe {
  home: string;
  env: NodeJS.ProcessEnv;
  /** Defaults to process.execPath. */
  execPath?: string;
  /** Defaults to the running CLI's package root; null for none. */
  packageRoot?: string | null;
  /** Defaults to os.tmpdir(). */
  tmp?: string;
  /** Work trees: a PATH entry inside one (its node_modules/.bin) stays
   *  writable to the role that works there. */
  exclude?: string[];
}

const inUse = (m: ManagerPath, pathDirs: string[]): boolean => {
  const anchor = realPath(m.anchor);
  return m.named || exists(m.path) || exists(m.anchor) || pathDirs.some((d) => within(anchor, d));
};

/** Every toolchain path a role must not write; see the module doc. */
export function toolchainPaths(probe: ToolchainProbe): string[] {
  const { home, env } = probe;
  const tmp = probe.tmp ?? tmpdir();
  const pathDirs = absPathDirs(env);
  const realPathDirs = pathDirs.map(realPath);
  // A work tree that is $HOME (or holds it) excludes nothing: every PATH dir
  // under $HOME would count as the role's own (#527 review round 2).
  const holdsHome = (r: string) => within(r, home) || within(realPath(r), realPath(home));
  for (const r of probe.exclude ?? [])
    if (holdsHome(r) && !warned.has(`home-root:${r}`)) {
      warned.add(`home-root:${r}`);
      console.warn(
        `monomind: an org root or role cwd of ${r} holds $HOME: every role there can write the whole home directory except what is protected, and the directories on PATH stay protected.`,
      );
    }
  const exclude = (probe.exclude ?? [])
    .filter((r) => !holdsHome(r))
    .flatMap((r) => [resolve(r), realPath(r)]);
  const found: string[] = [...binaryPaths(probe.execPath ?? process.execPath, home)];
  for (const d of pathDirs)
    if (!exclude.some((r) => within(r, d) || within(r, realPath(d))))
      found.push(...pathEntryPaths(d, home, env, tmp));
  for (const b of TOOLCHAIN_BINARIES) {
    const hit = onPath(b, env.PATH);
    if (hit) found.push(...binaryPaths(hit, home));
  }
  const pkg = probe.packageRoot === undefined ? defaultPackageRoot() : probe.packageRoot;
  if (pkg) found.push(...packagePaths(pkg, home));
  for (const m of versionManagerPaths(home, env))
    if (inUse(m, realPathDirs)) found.push(realPath(m.path));
  const underHome = (p: string) => within(home, p) || within(realPath(home), p);
  const keep = (p: string) =>
    !isGeneric(p, home, env) &&
    !within(p, tmp) &&
    !within(p, realPath(tmp)) &&
    roleWritable(p) &&
    // Watching an absent path outside $HOME would reach another user's
    // tree (a test's fake HOME with the real XDG dirs).
    (exists(p) || underHome(p));
  const kept = [...new Set(found)].filter(keep);
  // One entry for a tree: the mise root, not also each install inside it.
  return kept.filter((p) => !kept.some((q) => q !== p && within(q, p)));
}

/** #527 review M2: create what toolchainPaths expects but is absent (pnpm's
 *  home, bun's global dirs, a cargo or Go bin dir in use, mise's trust
 *  store, direnv's allow list), so it is bound read-only from the start and
 *  the operator's own `pnpm add -g` never looks like a plant. Only under
 *  $HOME. */
export function ensureToolchainDirs(home: string, env: NodeJS.ProcessEnv): void {
  const pathDirs = absPathDirs(env).map(realPath);
  const underHome = (p: string) => within(home, p) || within(realPath(home), p);
  for (const m of versionManagerPaths(home, env)) {
    if (!m.precreate || exists(m.path) || !underHome(m.path) || !inUse(m, pathDirs)) continue;
    try {
      mkdirSync(m.path, { recursive: true });
    } catch {
      /* unwritable: nothing can plant it either */
    }
  }
}

/** Environment for a role's processes: its pnpm store outside the
 *  protected pnpm home (pnpm keeps the store inside it by default), and no
 *  pnpm self-install into `<pnpm home>/.tools`. An operator-set store is
 *  kept. */
export function toolchainRoleEnv(home: string, env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = { npm_config_manage_package_manager_versions: 'false' };
  if (!env.npm_config_store_dir && exists(pnpmHome(home, env)))
    out.npm_config_store_dir = join(xdgDirs(home, env).data, 'pnpm-store');
  return out;
}

const memo = new Map<string, string[]>();

/** toolchainPaths for this home, toolchain environment and set of work
 *  trees, cached until the next org or session start
 *  (ensureOperatorProtectedPaths resets it): the file tools consult it on
 *  every write. */
export function operatorToolchainPaths(
  home: string,
  env: NodeJS.ProcessEnv,
  exclude: string[] = [],
): string[] {
  const key = JSON.stringify([home, exclude, ...TOOLCHAIN_ENV.map((k) => env[k] ?? null)]);
  let paths = memo.get(key);
  if (!paths) {
    paths = toolchainPaths({ home, env, exclude });
    memo.set(key, paths);
  }
  return paths;
}

/** Forget the computed lists (every org and session start). */
export function resetToolchainMemo(): void {
  memo.clear();
}

/** The directories on the way to each protected path that a role could
 *  rename (their parent is writable), stopping at $HOME, the temp dir and
 *  the work tree holding the path: bound onto themselves (a mount point
 *  cannot be renamed), so no role can move `~/.local/share` aside and plant
 *  a new `mise/…` in its place. Directories inside another protected path
 *  are skipped: nothing there can be renamed. */
export function mountPointAncestors(
  paths: string[],
  ctx: { home: string; roots: string[]; tmp?: string },
): string[] {
  const stops = new Set([ctx.home, ctx.tmp ?? tmpdir()].flatMap((d) => [resolve(d), realPath(d)]));
  const roots = ctx.roots.flatMap((r) => [resolve(r), realPath(r)]);
  const out = new Set<string>();
  const covered = paths.map(realPath);
  for (const p of covered) {
    // #527 review M1: inside a work tree, up to that tree (its own binds
    // hold it), not skipped: a checkout the daemon runs can live there.
    const holders = roots.filter((r) => within(r, p) && r !== p);
    for (let d = dirname(p); dirname(d) !== d && !stops.has(d); d = dirname(d)) {
      if (holders.some((r) => within(d, r))) break;
      if (!exists(d) || covered.some((q) => within(q, d))) continue;
      if (!canWrite(dirname(d))) break;
      out.add(d);
    }
  }
  return [...out];
}
