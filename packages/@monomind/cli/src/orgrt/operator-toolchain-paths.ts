// packages/@monomind/cli/src/orgrt/operator-toolchain-paths.ts
/**
 * #527: the toolchains the operator's own processes run, when a role could
 * write them. node, npm and monomind installed under $HOME (mise, nvm,
 * volta, fnm, asdf, bun, pnpm, …) sit inside the SDK sandbox's allowWrite
 * and the bubblewrap mask's writable $HOME: a role that replaced one would
 * run as the operator, outside every sandbox, the next time the daemon or an
 * operator shell starts it. operator-protected-paths.ts adds these paths to
 * its list, which feeds the file-tool deny, the SDK sandbox's denyWrite, the
 * mask's read-only binds and the planted-path watch.
 *
 * Covered, as real paths:
 *   - `process.execPath` and its install root (`…/installs/node/<ver>`);
 *   - the running CLI's package root, and the npm prefix or `node_modules`
 *     it was installed into;
 *   - `node`, `npm`, `npx` and `claude` as found on the daemon's PATH, each
 *     with its install root (a PATH hit that is a symlink: its directory);
 *   - the version-manager roots (VERSION_MANAGERS) that exist, that an
 *     environment variable names, or that a PATH entry lies in.
 * Only what a role could write matters: a path whose nearest existing
 * ancestor is not writable (`/usr/bin/node`) is left out. A directory that
 * holds $HOME, the temp dir or a role's work tree is never protected.
 *
 * Roles still read and run all of it. A role that installs a global tool
 * gets EROFS; `npm_config_prefix=$TMPDIR/npm-global` installs it in the
 * role's own temp dir instead.
 */
import { accessSync, constants, existsSync, lstatSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realPath } from './policy-paths.js';

/** The environment variables toolchainPaths reads. */
export const TOOLCHAIN_ENV = [
  'PATH',
  'MISE_DATA_DIR',
  'MISE_CONFIG_DIR',
  'NVM_DIR',
  'VOLTA_HOME',
  'FNM_DIR',
  'ASDF_DATA_DIR',
  'BUN_INSTALL',
  'PNPM_HOME',
  'CARGO_HOME',
  'PYENV_ROOT',
  'RBENV_ROOT',
  'GOPATH',
  'GOBIN',
] as const;

/** Binaries looked up on PATH. */
export const TOOLCHAIN_BINARIES = ['node', 'npm', 'npx', 'claude'];

/** A manager path: `path` (under $HOME unless an env var overrides it), and
 *  the root whose use makes it relevant even before it exists. */
interface ManagerPath {
  path: string;
  /** Set when an environment variable chose this location. */
  named: boolean;
  /** In use when this exists, is env-named, or holds a PATH entry. */
  anchor: string;
}

/** The known version-manager and global-install locations. pnpm and bun
 *  keep a package cache beside their global installs (`store`,
 *  `install/cache`), which a role's own `pnpm install`/`bun install`
 *  writes: only the global parts are protected there. */
export function versionManagerPaths(home: string, env: NodeJS.ProcessEnv): ManagerPath[] {
  const out: ManagerPath[] = [];
  const envDir = (k: string): string | undefined => {
    const v = env[k];
    return v && isAbsolute(v) ? resolve(v) : undefined;
  };
  const add = (paths: string[], root: string, named: boolean) => {
    for (const path of paths) out.push({ path, named, anchor: root });
  };
  const one = (k: string, fallback: string[]) => {
    const named = envDir(k);
    if (named) add([named], named, true);
    else for (const f of fallback) add([join(home, f)], join(home, f), false);
  };
  one('MISE_DATA_DIR', ['.local/share/mise']);
  one('MISE_CONFIG_DIR', ['.config/mise']);
  one('NVM_DIR', ['.nvm']);
  one('VOLTA_HOME', ['.volta']);
  one('FNM_DIR', ['.fnm', '.local/share/fnm']);
  one('ASDF_DATA_DIR', ['.asdf']);
  one('PYENV_ROOT', ['.pyenv']);
  one('RBENV_ROOT', ['.rbenv']);
  const cargo = envDir('CARGO_HOME');
  const cargoBin = join(cargo ?? join(home, '.cargo'), 'bin');
  add([cargoBin], cargoBin, !!cargo);
  const gobin = envDir('GOBIN') ?? (env.GOPATH ? envDirFirst(env.GOPATH, 'bin') : undefined);
  add([gobin ?? join(home, 'go', 'bin')], gobin ?? join(home, 'go', 'bin'), !!gobin);
  const bun = envDir('BUN_INSTALL');
  const bunRoot = bun ?? join(home, '.bun');
  add([join(bunRoot, 'bin'), join(bunRoot, 'install', 'global')], bunRoot, !!bun);
  const pnpm = envDir('PNPM_HOME');
  const pnpmRoot = pnpm ?? join(home, '.local', 'share', 'pnpm');
  let entries: string[] = [];
  try {
    entries = readdirSync(pnpmRoot).filter((e) => e !== 'store');
  } catch {
    /* no pnpm home */
  }
  add(
    [...new Set([...entries, 'global', '.tools'])].map((e) => join(pnpmRoot, e)),
    pnpmRoot,
    !!pnpm,
  );
  return out;
}

const envDirFirst = (list: string, sub: string): string | undefined => {
  const first = list.split(delimiter).find((d) => isAbsolute(d));
  return first ? join(resolve(first), sub) : undefined;
};

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

/** Directories under $HOME too general to make read-only as an "install
 *  root": an npm prefix of `~/.local` protects its bin and lib/node_modules
 *  instead. */
const GENERIC_HOME_DIRS = ['.local', '.local/share', '.local/state', '.config', '.cache'];

function isGeneric(dir: string, home: string): boolean {
  return (
    within(dir, home) ||
    within(dir, realPath(home)) ||
    GENERIC_HOME_DIRS.some((g) => dir === join(home, g) || dir === join(realPath(home), g))
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

export interface ToolchainProbe {
  home: string;
  env: NodeJS.ProcessEnv;
  /** Defaults to process.execPath. */
  execPath?: string;
  /** Defaults to the running CLI's package root; null for none. */
  packageRoot?: string | null;
  /** Defaults to os.tmpdir(). */
  tmp?: string;
}

/** Every toolchain path a role must not write; see the module doc. */
export function toolchainPaths(probe: ToolchainProbe): string[] {
  const { home, env } = probe;
  const tmp = probe.tmp ?? tmpdir();
  const pathDirs = (env.PATH ?? '')
    .split(delimiter)
    .filter((d) => isAbsolute(d))
    .map((d) => realPath(resolve(d)));
  const found: string[] = [...binaryPaths(probe.execPath ?? process.execPath, home)];
  for (const b of TOOLCHAIN_BINARIES) {
    const hit = onPath(b, env.PATH);
    if (hit) found.push(...binaryPaths(hit, home));
  }
  const pkg = probe.packageRoot === undefined ? defaultPackageRoot() : probe.packageRoot;
  if (pkg) found.push(...packagePaths(pkg, home));
  for (const m of versionManagerPaths(home, env)) {
    const anchor = realPath(m.anchor);
    const inUse =
      m.named || exists(m.path) || exists(m.anchor) || pathDirs.some((d) => within(anchor, d));
    if (inUse) found.push(realPath(m.path));
  }
  const keep = (p: string) =>
    !isGeneric(p, home) && !within(p, tmp) && !within(p, realPath(tmp)) && roleWritable(p);
  const kept = [...new Set(found)].filter(keep);
  // One entry for a tree: the mise root, not also each install inside it.
  return kept.filter((p) => !kept.some((q) => q !== p && within(q, p)));
}

const memo = new Map<string, string[]>();

/** toolchainPaths for this process, computed once per home and toolchain
 *  environment (the org start's): the file tools consult it on every write. */
export function operatorToolchainPaths(home: string, env: NodeJS.ProcessEnv): string[] {
  const key = JSON.stringify([home, ...TOOLCHAIN_ENV.map((k) => env[k] ?? null)]);
  let paths = memo.get(key);
  if (!paths) {
    paths = toolchainPaths({ home, env });
    memo.set(key, paths);
  }
  return paths;
}

/** For tests: forget the computed lists. */
export function resetToolchainMemo(): void {
  memo.clear();
}

/** The directories on the way to each protected path that a role could
 *  rename (their parent is writable), stopping at $HOME and the temp dir:
 *  bound onto themselves (a mount point cannot be renamed), so no role can
 *  move `~/.local/share` aside and plant a new `mise/…` in its place. Paths
 *  inside `roots` (the org root and cwd, whose binds already hold them) are
 *  skipped, and so are directories inside another protected path. */
export function mountPointAncestors(
  paths: string[],
  ctx: { home: string; roots: string[]; tmp?: string },
): string[] {
  const stops = new Set([ctx.home, ctx.tmp ?? tmpdir()].flatMap((d) => [resolve(d), realPath(d)]));
  const roots = ctx.roots.flatMap((r) => [resolve(r), realPath(r)]);
  const out = new Set<string>();
  const covered = paths.map(realPath);
  for (const p of covered) {
    if (roots.some((r) => within(r, p))) continue;
    for (let d = dirname(p); dirname(d) !== d && !stops.has(d); d = dirname(d)) {
      // Inside a protected (read-only) path: nothing there can be renamed.
      if (!exists(d) || covered.some((q) => within(q, d))) continue;
      if (!canWrite(dirname(d))) break;
      out.add(d);
    }
  }
  return [...out];
}
