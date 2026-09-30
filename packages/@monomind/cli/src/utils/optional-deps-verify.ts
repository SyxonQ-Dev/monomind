/**
 * #526: checks on code monomind loads from an optional dependency, beyond
 * assertTrustedTree (optional-deps.ts), which cannot tell a tree planted by
 * this same user from monomind's own install.
 *
 *   - verifyPinnedCode(): the entry file about to be imported and, for the
 *     Claude Agent SDK, the Claude binary it will spawn must match the
 *     SHA-256 pinned in optional-deps-locks.ts. Hashed once per process per
 *     file (again if the file changes); the binary is then passed to every
 *     query() and checked by one stat before each spawn
 *     (assertStillVerified, orgrt/claude-sdk-pin.ts).
 *   - assertNoSymlinkAncestor(): no directory above the deps root is a
 *     symlink in a directory this user can write. The sandboxes make the
 *     real directories above a custom MONOMIND_HOME mount points so they
 *     cannot be renamed aside (role-sandbox-restrictions.ts,
 *     authority-mask.ts), but a symlink can still be replaced, and the
 *     daemons would follow the new one.
 */
import { createHash } from 'node:crypto';
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, parse, resolve, sep } from 'node:path';
import type { CodePins, PinnedFile } from './optional-deps-locks.js';

/** The machine the SDK picks a Claude binary for. */
export interface PinHost {
  platform: NodeJS.Platform;
  arch: string;
  /** Linux libc; detected like the SDK does when omitted. */
  musl?: boolean;
}

const verified = new Map<string, string>();

const realOrSelf = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

/** SHA-256 of `file`, read in 4 MB chunks. Synchronous, as before this
 *  hashing existed the load had no long I/O step: hashing the Claude binary
 *  (about 300 MB) blocks for a few hundred milliseconds once per process.
 *  An asynchronous hash was tried and let timers in the session code and its
 *  tests run in the middle of the first SDK load. */
export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  const buf = Buffer.allocUnsafe(4 << 20);
  const fd = openSync(file, 'r');
  try {
    for (let n = readSync(fd, buf); n > 0; n = readSync(fd, buf)) hash.update(buf.subarray(0, n));
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

const statKey = (file: string): string => {
  const st = statSync(file);
  return `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
};

/** The SDK's own libc test (claude-agent-sdk 0.3.226, sdk.mjs). */
function detectMusl(): boolean {
  const report = process.report?.getReport?.() as
    | { header?: { glibcVersionRuntime?: string } }
    | undefined;
  return report != null && report.header?.glibcVersionRuntime === undefined;
}

/** `<package>/claude[.exe]` specifiers in the order the SDK tries them
 *  (claude-agent-sdk 0.3.226: the first that resolves and exists wins). */
export function claudeBinaryCandidates(host: PinHost): string[] {
  const base = '@anthropic-ai/claude-agent-sdk';
  const { platform, arch } = host;
  const musl = host.musl ?? (platform === 'linux' && detectMusl());
  const names =
    platform === 'android'
      ? [`${base}-linux-${arch}-android`]
      : platform === 'linux'
        ? musl
          ? [`${base}-linux-${arch}-musl`, `${base}-linux-${arch}`]
          : [`${base}-linux-${arch}`, `${base}-linux-${arch}-musl`]
        : [`${base}-${platform}-${arch}`];
  return names.map((n) => `${n}/claude${platform === 'win32' ? '.exe' : ''}`);
}

/** The Claude binary the SDK at `entry` would spawn, resolved the way it
 *  resolves it, with the platform package it came from. */
function resolveClaudeBinary(
  entry: string,
  host: PinHost,
): { pkg: string; path: string } | undefined {
  const req = createRequire(entry);
  for (const spec of claudeBinaryCandidates(host)) {
    try {
      const path = req.resolve(spec);
      if (existsSync(path)) return { pkg: spec.slice(0, spec.lastIndexOf('/')), path };
    } catch {
      /* not installed: the SDK tries the next one */
    }
  }
  return undefined;
}

async function assertHash(
  file: string,
  pin: PinnedFile,
  refuse: (why: string) => never,
): Promise<void> {
  const key = statKey(file);
  if (verified.get(file) === `${key}:${pin.sha256}`) return;
  const actual = await sha256File(file);
  if (actual !== pin.sha256)
    refuse(`${file} has SHA-256 ${actual}, but monomind pins ${pin.sha256} for it`);
  // Changed while it was being read: the next check hashes it again.
  if (statKey(file) === key) verified.set(file, `${key}:${pin.sha256}`);
  else refuse(`${file} changed while it was being verified`);
}

/** The Claude binary last verified for each package, for the SDK wrapper
 *  (orgrt/claude-sdk-pin.ts) to pass and check again before each spawn. */
const verifiedBinaries = new Map<string, { path: string; sha256: string }>();

export const verifiedBinary = (name: string): { path: string; sha256: string } | undefined =>
  verifiedBinaries.get(name);

/** Throws unless `file` is unchanged (same inode, size, mtime and ctime)
 *  since it was verified against `sha256`: one stat, no rehash. */
export function assertStillVerified(file: string, sha256: string): void {
  let key: string | undefined;
  try {
    key = statKey(file);
  } catch {
    /* gone */
  }
  if (!key || verified.get(file) !== `${key}:${sha256}`)
    throw new Error(
      `Refusing to run ${file}: it changed after monomind verified it against its pinned ` +
        'SHA-256. Something replaced the Claude binary; delete the Claude Agent SDK from ' +
        '~/.monomind/deps and run the command again.',
    );
}

/**
 * Throws unless the entry `entry` of `name` (installed in `pkgDir`) is the
 * pinned file with the pinned hash, and, when the pins list binaries and
 * `checkBinary` holds, the Claude binary the SDK would spawn from there is
 * one of them with its hash; that one is then recorded (verifiedBinary).
 * `remove` is what to delete to recover, for the message.
 *
 * The entry is imported by path after this returns, so a file swapped in
 * the few milliseconds between the hash and the import would run. Roles
 * cannot write the deps dir (the SDK sandbox's denyWrite, the mask's
 * read-only bind), so only an unsandboxed process could race it, and that
 * one could as well replace monomind itself.
 */
export async function verifyPinnedCode(
  name: string,
  pins: CodePins,
  where: { entry: string; pkgDir: string; remove: string; checkBinary?: boolean },
  host: PinHost,
  fail: (message: string) => never,
): Promise<void> {
  const { entry, pkgDir, remove } = where;
  const refuse: (why: string) => never = (why) =>
    fail(
      `Refusing to load ${name}@${pins.version}: ${why}. It is not what npm installs from the ` +
        `registry, so it was changed or planted. Delete ${remove} and run the command again; ` +
        'monomind reinstalls it from the lockfile it ships.',
    );
  const expected = join(pkgDir, pins.entry.file);
  // Node's resolver returns real paths; the deps root may be reached
  // through a symlink the operator set up (assertNoSymlinkAncestor).
  if (realOrSelf(entry) !== realOrSelf(expected))
    refuse(`its package.json points to ${entry}, not ${expected}`);
  await assertHash(expected, pins.entry, refuse);
  for (const m of pins.modules ?? []) await assertHash(join(pkgDir, m.file), m, refuse);
  if (!pins.binaries || where.checkBinary === false) return;
  const bin = resolveClaudeBinary(expected, host);
  if (!bin) refuse(`no Claude binary for ${host.platform}-${host.arch} resolves from ${pkgDir}`);
  const pin = pins.binaries[bin.pkg];
  if (!pin)
    refuse(`the Claude binary it would run, ${bin.path}, comes from ${bin.pkg}, which has no pin`);
  if (basename(bin.path) !== pin.file)
    refuse(`the Claude binary it would run is ${bin.path}, not ${pin.file}`);
  const real = realOrSelf(bin.path);
  await assertHash(real, pin, refuse);
  verifiedBinaries.set(name, { path: real, sha256: pin.sha256 });
}

/** Fails (via `refuse`, with the reason) when a directory above `root` is a
 *  symlink in a directory this user can write: see the module doc. */
export function assertNoSymlinkAncestor(root: string, refuse: (why: string) => never): void {
  const abs = resolve(root);
  const top = parse(abs).root;
  let cur = top;
  for (const part of abs.slice(top.length).split(sep).filter(Boolean).slice(0, -1)) {
    cur = join(cur, part);
    let link = false;
    try {
      link = lstatSync(cur).isSymbolicLink();
    } catch {
      return; // missing: nothing below it to load
    }
    if (!link) continue;
    try {
      accessSync(dirname(cur), constants.W_OK);
    } catch {
      continue; // only root (or another user) can replace it
    }
    let real = abs;
    try {
      real = realpathSync(abs);
    } catch {
      /* keep the path as given */
    }
    refuse(
      `${cur}, above it, is a symlink in a directory this user can write, so an org role ` +
        `could point it elsewhere; set MONOMIND_HOME to a path without it (${dirname(real)})`,
    );
  }
}

/** Forgets what was verified (tests). */
export function resetPinnedCodeCache(): void {
  verified.clear();
  verifiedBinaries.clear();
}
