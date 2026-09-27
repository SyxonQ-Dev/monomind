// packages/@monomind/cli/src/orgrt/sandbox-stubs-ledger.ts
// Split out of sandbox-stubs.ts (file-size sweep) — the per-machine crash
// ledger (defaultStubLedger, LedgerEntry, readLedger/writeLedger) and the
// pid-namespace/boot identity a reclaim() needs to tell a dead runtime's
// entries apart from a live one's. See sandbox-stubs.ts's header.
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

/** The per-machine crash ledger: `MONOMIND_ORGRT_STUBS_DIR`, else
 *  ~/.monomind/orgrt-sandbox-stubs (next to orgrt-broker and orgrt-operator). */
export function defaultStubLedger(env: NodeJS.ProcessEnv = process.env): string {
  return join(
    env.MONOMIND_ORGRT_STUBS_DIR || join(homedir(), '.monomind', 'orgrt-sandbox-stubs'),
    'ledger.json',
  );
}

export interface LedgerEntry {
  path: string;
  ino: number;
  dev: number;
  kind: 'file' | 'dir';
  /** A file stub's ctime at creation: an inode number is reused as soon as a
   *  file is deleted, so dev+ino alone cannot tell our stub from an empty file
   *  someone recreated at the same path. Absent on older entries. */
  ctimeMs?: number;
  pid: number;
  /** This pid's namespace and boot, so a later reclaim() can tell a dead pid
   *  in our own namespace apart from a live one we simply cannot see from a
   *  different namespace. Absent on an entry written before this field
   *  existed (see isLegacy). */
  pidNamespace?: string;
  bootId?: string;
  runId: string;
  createdAt: string;
}

export function readLedger(file: string): LedgerEntry[] {
  try {
    const entries = (JSON.parse(readFileSync(file, 'utf8')) as { entries?: unknown }).entries;
    if (!Array.isArray(entries)) return [];
    return entries.filter(
      (e): e is LedgerEntry =>
        !!e &&
        typeof e.path === 'string' &&
        isAbsolute(e.path) &&
        typeof e.ino === 'number' &&
        typeof e.dev === 'number' &&
        (e.kind === 'file' || e.kind === 'dir') &&
        (e.ctimeMs === undefined || typeof e.ctimeMs === 'number') &&
        Number.isInteger(e.pid) &&
        (e.pidNamespace === undefined || typeof e.pidNamespace === 'string') &&
        (e.bootId === undefined || typeof e.bootId === 'string'),
    );
  } catch {
    return []; // missing or corrupt: nothing to reclaim
  }
}

/** Atomic (tmp + rename). Only a write that adds entries makes the dir: a
 *  removal has nothing to record where there is no ledger. */
export function writeLedger(file: string, entries: LedgerEntry[], create: boolean): void {
  try {
    if (create) mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ entries }, null, 2)}\n`);
    renameSync(tmp, file);
  } catch {
    /* best-effort: the stubs still work, only crash recovery is lost */
  }
}

export const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/** Reads what identifies THIS process's pid namespace and boot, so a ledger
 *  entry can later tell a dead pid in our own namespace (safe to reclaim)
 *  apart from a live daemon's pid that we simply cannot see (the Claude SDK
 *  sandbox runs every role with `bwrap --unshare-pid`: `process.kill(pid, 0)`
 *  on a pid outside our namespace always throws ESRCH, alive or not). */
export interface IdentitySource {
  /** `/proc/self/ns/pid`'s target, e.g. `pid:[4026531836]`; undefined if it
   *  cannot be read (older kernel, no /proc). */
  pidNamespace(): string | undefined;
  /** `/proc/sys/kernel/random/boot_id`, stable for one boot and never reused
   *  across a reboot — unlike a pid, which is. */
  bootId(): string | undefined;
  /** Is any process still in pid namespace `ns`? `false` only when that is
   *  provable — we are in the initial pid namespace, which sees every
   *  process, and none of our own readable processes is in `ns` (a namespace
   *  our roles' bwrap created holds only this user's processes). `undefined`
   *  when we cannot tell: inside a sandbox's own namespace, or no /proc. */
  namespaceLive?(ns: string): boolean | undefined;
}

/** The initial pid namespace's inode on Linux (PROC_PID_INIT_INO). */
const INIT_PID_NS = 'pid:[4026531836]';

export const defaultIdentity: IdentitySource = {
  pidNamespace(): string | undefined {
    try {
      return readlinkSync('/proc/self/ns/pid');
    } catch {
      return undefined;
    }
  },
  bootId(): string | undefined {
    try {
      return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    } catch {
      return undefined;
    }
  },
  namespaceLive(ns: string): boolean | undefined {
    try {
      if (readlinkSync('/proc/self/ns/pid') !== INIT_PID_NS) return undefined;
      for (const pid of readdirSync('/proc')) {
        if (!/^\d+$/.test(pid)) continue;
        try {
          if (readlinkSync(`/proc/${pid}/ns/pid`) === ns) return true;
        } catch {
          /* exited, or another user's process — never in our roles' namespaces */
        }
      }
      return false;
    } catch {
      return undefined;
    }
  },
};

/** An entry recorded before pid-namespace awareness (no `pidNamespace`/
 *  `bootId`), or one whose reader could not read them: falls back to the
 *  bare pid check (today's behavior, and correct outside any sandbox). */
export function isLegacy(e: LedgerEntry): boolean {
  return e.pidNamespace === undefined || e.bootId === undefined;
}
