/**
 * Heavy dependencies installed on first use (#428).
 *
 * `npm install monomind` used to pull a 232 MB native Claude binary (through
 * @anthropic-ai/claude-agent-sdk) and 657 MB of Chrome (through puppeteer's
 * postinstall) whether or not the user ever ran a Claude org role or a
 * browser command. They are no longer dependencies of the published packages.
 * The feature that needs one calls `ensureOptionalDependency()`, which:
 *
 *   1. imports the package if monomind's own node_modules has it (a source
 *      checkout keeps it as a devDependency);
 *   2. otherwise imports it from `~/.monomind/deps/<name>@<version>/`
 *      (`$MONOMIND_HOME/deps` when that is set);
 *   3. otherwise installs it there, once, with a notice on stderr, unless
 *      MONOMIND_NO_AUTO_INSTALL is set, in which case it throws with the exact
 *      command that does the same install by hand.
 *
 * Safety:
 *   - Only the packages in OPTIONAL_DEPENDENCIES can be installed, each at
 *     the exact version pinned there; nothing from input reaches npm.
 *   - npm runs in a staging directory under the deps root, with an explicit
 *     `--prefix` and `--global=false`, never in the user's project, so no
 *     package.json or lockfile of theirs is read or written. It verifies each
 *     tarball against the registry's integrity hash as usual, and runs with
 *     `--ignore-scripts` (none of these packages needs an install script).
 *   - The staging directory is renamed into place only once complete, so a
 *     crashed or concurrent install never leaves a half-populated directory
 *     where a later run would find it. A lock directory next to it keeps two
 *     processes from downloading the same thing at once; correctness does not
 *     depend on it, since the rename is atomic.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { npmCommand } from './npm-command.js';

interface OptionalDependencySpec {
  /** Exact version; keep in step with the CLI's devDependencies. */
  version: string;
  /** Rough installed size, for the notice. */
  size: string;
  /** What needs it, for the notice and errors. */
  feature: string;
}

export const OPTIONAL_DEPENDENCIES = {
  '@anthropic-ai/claude-agent-sdk': {
    version: '0.3.226',
    size: 'about 300 MB, nearly all of it the native Claude binary',
    feature: 'The Claude runtime (Claude org roles, `agent exec --runtime claude`)',
  },
  '@puppeteer/browsers': {
    version: '3.0.6',
    size: 'about 2 MB',
    feature: 'The Chrome download for `monomind browse`',
  },
  'monofence-ai': {
    version: '1.0.7',
    size: 'under 1 MB',
    feature: 'The monofence_* MCP security tools',
  },
} as const satisfies Record<string, OptionalDependencySpec>;

export type OptionalDependencyName = keyof typeof OPTIONAL_DEPENDENCIES;

export const NO_AUTO_INSTALL_ENV = 'MONOMIND_NO_AUTO_INSTALL';

/** A missing dependency that was not (or could not be) installed. */
export class OptionalDependencyError extends Error {
  override name = 'OptionalDependencyError';
}

type Env = NodeJS.ProcessEnv;
type Log = (line: string) => void;
export type NpmRunner = (args: string[], cwd: string, env: Env) => Promise<void>;

export interface EnsureOptions {
  env?: Env;
  /** Imports from monomind's own module graph. Tests replace it. */
  importOwn?: (name: string) => Promise<unknown>;
  runNpm?: NpmRunner;
  log?: Log;
}

const NPM_INSTALL_FLAGS = [
  '--global=false',
  '--ignore-scripts',
  '--legacy-peer-deps',
  '--no-audit',
  '--no-fund',
  '--save-exact',
];
const LOADER = 'monomind-load.mjs';
const LOCK_STALE_MS = 60 * 60 * 1000;
const LOCK_POLL_MS = 500;

const defaultLog: Log = (line) => process.stderr.write(`[monomind] ${line}\n`);

export function autoInstallDisabled(env: Env = process.env): boolean {
  const v = env[NO_AUTO_INSTALL_ENV]?.trim().toLowerCase();
  return !!v && v !== '0' && v !== 'false';
}

export function depsRoot(env: Env = process.env): string {
  return join(env.MONOMIND_HOME || join(homedir(), '.monomind'), 'deps');
}

export function dependencyDir(name: OptionalDependencyName, env: Env = process.env): string {
  return join(depsRoot(env), `${name.replace('/', '+')}@${OPTIONAL_DEPENDENCIES[name].version}`);
}

/** The command that performs the same install by hand. */
export function manualInstallCommand(name: OptionalDependencyName, env: Env = process.env): string {
  const { version } = OPTIONAL_DEPENDENCIES[name];
  return `npm install --prefix "${dependencyDir(name, env)}" ${NPM_INSTALL_FLAGS.join(' ')} ${name}@${version}`;
}

function isInstalled(name: OptionalDependencyName, dir: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'node_modules', name, 'package.json'), 'utf8'));
    return pkg.version === OPTIONAL_DEPENDENCIES[name].version;
  } catch {
    return false;
  }
}

/** Imports `name` as resolved from `dir`, through a one-line module placed
 *  there, so ESM resolution and export conditions apply exactly as for a
 *  normal import. */
async function importFrom(name: OptionalDependencyName, dir: string): Promise<unknown> {
  const loader = join(dir, LOADER);
  if (!existsSync(loader)) {
    writeFileSync(loader, `export default () => import(${JSON.stringify(name)});\n`);
  }
  const mod = (await import(pathToFileURL(loader).href)) as { default: () => Promise<unknown> };
  return mod.default();
}

function isModuleNotFound(err: unknown, name: string): boolean {
  const e = err as { code?: string; message?: string };
  return (
    (e?.code === 'ERR_MODULE_NOT_FOUND' || e?.code === 'MODULE_NOT_FOUND') &&
    String(e.message).includes(name)
  );
}

/**
 * Loads one of OPTIONAL_DEPENDENCIES, installing it into monomind's deps
 * directory first if needed (see the file header).
 */
export async function ensureOptionalDependency<T = unknown>(
  name: OptionalDependencyName,
  opts: EnsureOptions = {},
): Promise<T> {
  if (!Object.hasOwn(OPTIONAL_DEPENDENCIES, name)) {
    throw new OptionalDependencyError(`${String(name)} is not a dependency monomind installs`);
  }
  const env = opts.env ?? process.env;
  const log = opts.log ?? defaultLog;
  const spec: OptionalDependencySpec = OPTIONAL_DEPENDENCIES[name];

  try {
    return (await (opts.importOwn ?? ((n: string) => import(n)))(name)) as T;
  } catch (err) {
    if (!isModuleNotFound(err, name)) throw err;
  }

  const dir = dependencyDir(name, env);
  if (isInstalled(name, dir)) return (await importFrom(name, dir)) as T;

  if (autoInstallDisabled(env)) {
    throw new OptionalDependencyError(
      `${spec.feature} needs ${name}@${spec.version} (${spec.size}), which is not installed, ` +
        `and ${NO_AUTO_INSTALL_ENV} is set, so monomind will not install it. Install it with:\n` +
        `  ${manualInstallCommand(name, env)}`,
    );
  }

  log(
    `${spec.feature} needs ${name}@${spec.version} (${spec.size}). Installing it once into ${dir} ` +
      `(set ${NO_AUTO_INSTALL_ENV}=1 to install by hand instead)...`,
  );
  const runNpm = opts.runNpm ?? defaultRunNpm;
  try {
    await installOnce(
      dir,
      (d) => isInstalled(name, d),
      async (staging) => {
        writeFileSync(
          join(staging, 'package.json'),
          `${JSON.stringify({ name: 'monomind-optional-dependency', private: true }, null, 2)}\n`,
        );
        await runNpm(
          ['install', `--prefix=${staging}`, ...NPM_INSTALL_FLAGS, `${name}@${spec.version}`],
          staging,
          env,
        );
        if (!isInstalled(name, staging)) {
          throw new Error(`npm finished but ${name}@${spec.version} is not in ${staging}`);
        }
      },
      log,
    );
  } catch (err) {
    throw new OptionalDependencyError(
      `Could not install ${name}@${spec.version}: ${(err as Error).message}\n` +
        `Install it by hand with:\n  ${manualInstallCommand(name, env)}`,
    );
  }
  log(`Installed ${name}@${spec.version}.`);
  return (await importFrom(name, dir)) as T;
}

/**
 * Populates `finalDir` exactly once across processes: `populate` fills a
 * fresh staging directory beside it, which is then renamed into place. A
 * `finalDir` that exists but fails `isDone` (an interrupted manual install)
 * is replaced.
 */
export async function installOnce(
  finalDir: string,
  isDone: (dir: string) => boolean,
  populate: (stagingDir: string) => Promise<void>,
  log: Log = defaultLog,
): Promise<void> {
  const parent = dirname(finalDir);
  mkdirSync(parent, { recursive: true });
  await withLock(`${finalDir}.lock`, log, async () => {
    if (isDone(finalDir)) return; // another process finished while we waited
    const staging = join(
      parent,
      `.staging-${basename(finalDir)}-${process.pid}-${randomUUID().slice(0, 8)}`,
    );
    mkdirSync(staging);
    try {
      await populate(staging);
      if (existsSync(finalDir)) rmSync(finalDir, { recursive: true, force: true });
      renameSync(staging, finalDir);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  });
}

function lockIsStale(lockDir: string): boolean {
  try {
    const age = Date.now() - statSync(lockDir).mtimeMs;
    if (age > LOCK_STALE_MS) return true;
    const pid = Number(readFileSync(join(lockDir, 'pid'), 'utf8'));
    if (!Number.isInteger(pid) || pid <= 0) return age > 10_000;
    try {
      process.kill(pid, 0);
      return false;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'ESRCH';
    }
  } catch {
    // Lock vanished (released), or its pid file is not written yet.
    return false;
  }
}

async function withLock<T>(lockDir: string, log: Log, fn: () => Promise<T>): Promise<T> {
  let announced = false;
  for (;;) {
    try {
      mkdirSync(lockDir);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    if (lockIsStale(lockDir)) {
      rmSync(lockDir, { recursive: true, force: true });
      continue;
    }
    if (!announced) {
      log(
        `Waiting for another monomind process to finish installing into ${lockDir.slice(0, -5)}...`,
      );
      announced = true;
    }
    await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
  }
  try {
    writeFileSync(join(lockDir, 'pid'), String(process.pid));
    return await fn();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

/** Runs npm with its output on stderr (stdout may be an MCP stdio channel). */
const defaultRunNpm: NpmRunner = (args, cwd, env) =>
  new Promise((resolve, reject) => {
    const child = spawn(npmCommand(), args, {
      cwd,
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let tail = '';
    const forward = (chunk: Buffer) => {
      process.stderr.write(chunk);
      tail = (tail + chunk.toString()).slice(-2000);
    };
    child.stdout?.on('data', forward);
    child.stderr?.on('data', forward);
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`npm exited ${code}: ${tail.trim()}`)),
    );
  });
