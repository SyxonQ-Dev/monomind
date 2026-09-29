// packages/@monomind/cli/src/orgrt/role-tmpdir.ts
/**
 * A private TMPDIR per role session (#480).
 *
 * Every role of an org run used to inherit the daemon's one TMPDIR (the
 * release org runs with `$HOME/mrg-tmp`). A bare `mktemp -d` put
 * `tmp.XXXXXXXXXX` straight into that shared root, and a role cleaning up its
 * own scratch with `rm -rf tmp.*` there deleted every other concurrently
 * running role's scratch too (13 directories matched on the 2.19.0 release run
 * where 3 were meant).
 *
 * So each role session — each task session under `session_scope: "task"` —
 * gets its own `<base>/<org>-<role>-<random>/` (mode 0700), exported as
 * TMPDIR, TMP, TEMP and CLAUDE_CODE_TMPDIR. `<base>` is the TMPDIR the role would otherwise have
 * had, so the OS sandbox's writable temp root and the file-tool roots (both
 * built from that base) already cover it.
 *
 * Cleanup is best-effort and exact: a directory is removed only by the path
 * this module created and recorded, after checking it still sits directly in
 * its base with this org's and role's prefix and is a real directory, never a
 * symlink. A sibling is never touched. On org start, sweepStaleRoleTmpdirs()
 * reclaims what a killed daemon left behind — only entries whose owner marker
 * names this org and project root and whose owning process is gone (or is
 * this process, for an earlier run). Anything it cannot attribute is left.
 */

import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

/** Owner record written inside every role tmpdir (a dotfile, so a role's
 *  `rm -rf "$TMPDIR"/*` leaves it). */
export const ROLE_TMPDIR_MARKER = '.monomind-role-tmpdir.json';

interface Owner {
  org: string;
  role: string;
  run: string;
  root: string;
  pid: number;
}

const safe = (s: string): string => s.replace(/[^A-Za-z0-9_.-]/g, '_');

/** `<org>-` — every role tmpdir of this org starts with it. */
export const orgTmpPrefix = (org: string): string => `${safe(org)}-`;
/** `<org>-<role>-` — every tmpdir of this role starts with it. */
export const roleTmpPrefix = (org: string, role: string): string => `${safe(org)}-${safe(role)}-`;

/** The TMPDIR a role gets without isolation: the daemon's own. */
export function roleTmpBase(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.TMPDIR || env.TMP || env.TEMP || tmpdir());
}

/** The env overlay pointing every temp-dir convention at `dir`.
 *  CLAUDE_CODE_TMPDIR (#503): Claude Code reads it before TMPDIR, and its
 *  Bash tool exports it to every command, so an org started from a Claude
 *  Code session inherits the outer session's temp dir. Left in place, a
 *  claude role's sandboxed Bash got that shared dir as TMPDIR, and any
 *  `claude` a role ran used it too. Claude Code adds `claude-<uid>/` under it. */
export function roleTmpEnv(dir: string | undefined): Record<string, string> {
  return dir ? { TMPDIR: dir, TMP: dir, TEMP: dir, CLAUDE_CODE_TMPDIR: dir } : {};
}

/** Creates `<base>/<org>-<role>-XXXXXX` (0700) with its owner marker and
 *  records it for the run's stop. Returns undefined when it cannot (base
 *  missing or unwritable): the role then keeps the shared base, as before. */
export function createRoleTmpdir(args: {
  org: string;
  role: string;
  run?: string;
  root: string;
  base?: string;
}): string | undefined {
  const base = args.base ?? roleTmpBase();
  let dir: string;
  try {
    dir = mkdtempSync(join(base, roleTmpPrefix(args.org, args.role)));
    chmodSync(dir, 0o700);
  } catch {
    return undefined;
  }
  const owner: Owner = {
    org: args.org,
    role: args.role,
    run: args.run ?? '',
    root: resolve(args.root),
    pid: process.pid,
  };
  try {
    writeFileSync(join(dir, ROLE_TMPDIR_MARKER), JSON.stringify(owner), { mode: 0o600 });
  } catch {
    /* no marker: the start sweep will never claim it; stop still removes it */
  }
  runKey(args.org, args.run, (set) => set.set(dir, { org: args.org, role: args.role, base }));
  return dir;
}

/** Removes one role tmpdir by its exact path, after checking it is what
 *  createRoleTmpdir made for this org and role. Returns whether it was removed. */
export function removeRoleTmpdir(
  dir: string,
  args: { org: string; role: string; base: string },
): boolean {
  const abs = resolve(dir);
  if (dirname(abs) !== resolve(args.base)) return false;
  const name = basename(abs);
  const prefix = roleTmpPrefix(args.org, args.role);
  if (!name.startsWith(prefix) || name.length === prefix.length) return false;
  try {
    const st = lstatSync(abs);
    if (!st.isDirectory() || st.isSymbolicLink()) return false;
    rmSync(abs, { recursive: true, force: true });
  } catch {
    return false;
  }
  forget(abs);
  return true;
}

/** Removes every role tmpdir recorded for this run (org stop). */
export function releaseRunTmpdirs(org: string, run: string | undefined): void {
  const set = registry.get(key(org, run));
  if (!set) return;
  for (const [dir, rec] of [...set]) removeRoleTmpdir(dir, rec);
  registry.delete(key(org, run));
}

/** On org start: removes this org's role tmpdirs under `base` that belong to
 *  a run no longer live. Returns the removed paths. */
export function sweepStaleRoleTmpdirs(args: {
  org: string;
  root: string;
  run?: string;
  base?: string;
  isAlive?: (pid: number) => boolean;
}): string[] {
  const base = args.base ?? roleTmpBase();
  const alive = args.isAlive ?? pidAlive;
  const prefix = orgTmpPrefix(args.org);
  const root = resolve(args.root);
  const uid = process.getuid?.();
  const removed: string[] = [];
  let names: string[];
  try {
    names = readdirSync(base);
  } catch {
    return removed;
  }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const dir = join(base, name);
    try {
      const st = lstatSync(dir);
      if (!st.isDirectory() || st.isSymbolicLink()) continue;
      if (uid !== undefined && st.uid !== uid) continue;
      const owner = JSON.parse(readFileSync(join(dir, ROLE_TMPDIR_MARKER), 'utf8')) as Owner;
      if (owner.org !== args.org || owner.root !== root) continue;
      if (typeof owner.role !== 'string' || !name.startsWith(roleTmpPrefix(owner.org, owner.role)))
        continue;
      const stale = owner.pid === process.pid ? owner.run !== (args.run ?? '') : !alive(owner.pid);
      if (!stale) continue;
      if (removeRoleTmpdir(dir, { org: owner.org, role: owner.role, base })) removed.push(dir);
    } catch {
      /* unreadable, no marker, or not ours — leave it */
    }
  }
  return removed;
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return true; // cannot tell — keep
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

type Rec = { org: string; role: string; base: string };
const registry = new Map<string, Map<string, Rec>>();
const key = (org: string, run: string | undefined): string => `${org}:${run ?? ''}`;
function runKey(org: string, run: string | undefined, f: (set: Map<string, Rec>) => void): void {
  const k = key(org, run);
  let set = registry.get(k);
  if (!set) registry.set(k, (set = new Map()));
  f(set);
}
function forget(dir: string): void {
  for (const set of registry.values()) set.delete(dir);
}
