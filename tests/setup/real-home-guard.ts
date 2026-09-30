/**
 * Tripwire for the developer's real home (#544).
 *
 * The global setup moves HOME and the XDG and toolchain variables into a temp
 * home, but a test can still reach the real one through a hard-coded path or
 * a spawned tool with its own idea of where home is. This takes a cheap
 * snapshot of the top level of the real ~, ~/.local/share, ~/.local/state,
 * ~/.config, ~/.cache and ~/.monomind before the run and compares it after:
 * an entry created, removed or replaced (a rename aside and back gives it a
 * new inode) is reported loudly, and fails the run when
 * MONOMIND_TEST_HOME_GUARD=strict. It only ever calls readdir and lstat.
 *
 * Other processes on a live desktop also write there, so a warning is a lead
 * to check, not proof that a test did it. Plain mtime changes inside an entry
 * are that kind of noise and are counted, not flagged.
 */
import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const WATCHED = ['', '.local/share', '.local/state', '.config', '.cache', '.monomind'];

interface Entry {
  ino: number;
  mtimeMs: number;
}
/** dir -> entry name -> identity; null when the dir did not exist. */
export type HomeSnapshot = Map<string, Map<string, Entry> | null>;

export interface HomeChange {
  kind: 'created' | 'removed' | 'replaced';
  path: string;
}

function readTop(dir: string): Map<string, Entry> | null {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  const out = new Map<string, Entry>();
  for (const name of names) {
    try {
      const st = lstatSync(join(dir, name));
      out.set(name, { ino: st.ino, mtimeMs: st.mtimeMs });
    } catch {
      // Gone between readdir and lstat: some other process; skip it.
    }
  }
  return out;
}

export function snapshotHome(realHome: string): HomeSnapshot {
  return new Map(WATCHED.map((rel) => [join(realHome, rel), readTop(join(realHome, rel))]));
}

export function diffHome(
  before: HomeSnapshot,
  after: HomeSnapshot,
): {
  changes: HomeChange[];
  modified: number;
} {
  const changes: HomeChange[] = [];
  let modified = 0;
  for (const [dir, was] of before) {
    const now = after.get(dir) ?? null;
    if (!was && !now) continue;
    if (!was || !now) {
      changes.push({ kind: was ? 'removed' : 'created', path: dir });
      continue;
    }
    for (const [name, e] of now) {
      const old = was.get(name);
      if (!old) changes.push({ kind: 'created', path: join(dir, name) });
      else if (old.ino !== e.ino) changes.push({ kind: 'replaced', path: join(dir, name) });
      else if (old.mtimeMs !== e.mtimeMs) modified++;
    }
    for (const name of was.keys()) {
      if (!now.has(name)) changes.push({ kind: 'removed', path: join(dir, name) });
    }
  }
  return { changes, modified };
}

/** Compares against `before` and reports; throws in strict mode on a change. */
export function checkHome(realHome: string, before: HomeSnapshot): void {
  const { changes, modified } = diffHome(before, snapshotHome(realHome));
  if (changes.length === 0) {
    process.stderr.write(
      `[real-home guard] ${realHome}: no entries created, removed or replaced (#544)\n`,
    );
    return;
  }
  const strict = process.env.MONOMIND_TEST_HOME_GUARD === 'strict';
  const bar = '!'.repeat(72);
  const lines = [
    '',
    bar,
    `!! REAL HOME CHANGED DURING THE TEST RUN (#544): ${realHome}`,
    ...changes.map((c) => `!!   ${c.kind.padEnd(8)} ${c.path}`),
    `!! (${modified} other entries only had their mtime change.)`,
    '!! Another process may have done this; if a test did, it escaped the temp HOME.',
    strict
      ? '!! MONOMIND_TEST_HOME_GUARD=strict: failing the run.'
      : '!! Set MONOMIND_TEST_HOME_GUARD=strict to fail the run on this.',
    bar,
    '',
  ];
  process.stderr.write(lines.join('\n'));
  if (strict)
    throw new Error(`test run changed the real home: ${changes.map((c) => c.path).join(', ')}`);
}
