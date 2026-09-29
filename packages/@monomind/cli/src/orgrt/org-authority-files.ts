// packages/@monomind/cli/src/orgrt/org-authority-files.ts
/**
 * #498: the files under `<orgRoot>/.monomind/orgs/` that no role may write —
 * the org definitions (each role's own `policy`), the files that record a
 * human's decisions, the daemon's state and its control files — and the
 * directories there that roles do write in.
 *
 * Every check is anchored to the org root: a path is classified by where it
 * lies below `<orgRoot>/.monomind/orgs`, both as written (lexical) and after
 * resolving symlinks, and against the real location of any entry there that
 * is itself a symlink. A `.monomind/orgs/` inside a checkout (`work/src/…`)
 * or a temp-dir fixture is someone else's tree and is not protected.
 * Segments compare as the filesystem does (policy-paths.ts's
 * normalizeSegment): case-insensitively on darwin and win32.
 */
import { existsSync, lstatSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeSegment, realPath, segmentsBelow } from './policy-paths.js';

/** Files in an org dir that record a human's decisions. */
export const DECISION_FILES = ['gates.json', 'approvals.json', 'questions.json', 'inbox.jsonl'];
/** The other files the daemon keeps in an org dir: the resume checkpoint,
 *  the decision trace, run history and the idle deadline. */
export const ORG_STATE_FILES = [
  'runtime.json',
  'decisions.jsonl',
  'history.jsonl',
  'idle-watchdog.json',
];
/** Files in an org dir that `org serve` acts on (org-poll.ts): `run` starts
 *  the org, the others stop, pause or reload it. */
export const CONTROL_FILES = ['run', 'stop', 'pause', 'reload'];
/** Files in a run dir: the run's event log, which records every approval and
 *  gate decision and which checkpoint replay reads, and its session ledger. */
export const RUN_STATE_FILES = ['bus.jsonl', 'sessions.json'];
/** The dir in an org dir holding each role's git guard (role-sandbox.ts). */
export const GIT_GUARD_DIR = 'git-guard';
/** Run dirs: `run-…` (org-start-steps.ts), `replay-…` (checkpoint-ops.ts),
 *  `scenario` (test-loop.ts). */
const RUN_DIR = /^(?:run-|replay-)|^scenario$/;
const MEMORY_DIR = /-memory$/;
const DEF_EXTS = ['.json', '.yaml', '.yml'];

export const orgsDir = (orgRoot: string): string => join(orgRoot, '.monomind', 'orgs');

/** `<x>-memory/` is the org memory of the mastermind-memory skill, which
 *  roles write — unless an org is really named `<x>-memory`. */
function isMemoryDir(orgs: string, name: string): boolean {
  return MEMORY_DIR.test(name) && !DEF_EXTS.some((x) => existsSync(join(orgs, name + x)));
}

/**
 * Whether a path, given as its normalized segments below `.monomind/orgs/`,
 * is an authority file:
 *   - any file directly in the orgs dir (org definitions and the org
 *     artifacts beside them: `-state`, `-secrets`, `-runstate`, …);
 *   - any file directly in an org dir (decision, state and control files);
 *     in an org memory dir only those named in the lists above;
 *   - a run dir's bus.jsonl and sessions.json, and anything in git-guard/.
 */
export function isAuthorityBelowOrgs(below: string[], isMemory: (org: string) => boolean): boolean {
  const [org, second, third, ...rest] = below;
  if (org === undefined || second === undefined) return true;
  const memory = isMemory(org);
  if (third === undefined)
    return !memory || [...DECISION_FILES, ...ORG_STATE_FILES, ...CONTROL_FILES].includes(second);
  if (memory) return false;
  if (second === GIT_GUARD_DIR) return true;
  return rest.length === 0 && RUN_DIR.test(second) && RUN_STATE_FILES.includes(third);
}

const list = (dir: string) => {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
};
const statOf = (p: string) => {
  try {
    return statSync(p);
  } catch {
    return undefined;
  }
};

/** Where a path below the orgs dir may really live: the orgs dir itself
 *  (lexical and real), plus the real target of every entry of it, or of an
 *  org dir, that is a symlink — with the segments that entry stands for. */
function anchors(orgRoot: string, platform: NodeJS.Platform) {
  const lexical = orgsDir(orgRoot);
  const real = realPath(lexical);
  const out: Array<{ base: string; prefix: string[] }> = [
    { base: real, prefix: [] },
    { base: lexical, prefix: [] },
  ];
  const linked = (dir: string, prefix: string[]) => {
    for (const e of list(dir)) {
      const p = join(dir, e.name);
      const at = [...prefix, normalizeSegment(e.name, platform)];
      if (e.isSymbolicLink()) out.push({ base: realPath(p), prefix: at });
      if (prefix.length === 0 && (e.isDirectory() || statOf(p)?.isDirectory())) linked(p, at);
    }
  };
  linked(real, []);
  return { real, anchors: out };
}

/**
 * #498: is `target` a file no role may write with a file tool, whatever its
 * scope, roots or allowWrite? Pass the resolved and the as-written absolute
 * path (a plain string is taken as both); both are classified, below each
 * of `orgRoots`. An existing file with more than one link is also compared
 * with the authority files by inode, so a hard link to one is refused.
 */
export function isAuthorityFile(
  target: string | { real: string; lexical: string },
  orgRoots: string | string[],
  platform: NodeJS.Platform = process.platform,
): boolean {
  const paths = typeof target === 'string' ? [target] : [target.real, target.lexical];
  const roots = typeof orgRoots === 'string' ? [orgRoots] : orgRoots;
  for (const orgRoot of roots) {
    const { real, anchors: bases } = anchors(orgRoot, platform);
    const isMemory = (org: string) => isMemoryDir(real, org);
    for (const { base, prefix } of bases)
      for (const p of paths) {
        const below = segmentsBelow(base, p, platform);
        if (below && isAuthorityBelowOrgs([...prefix, ...below], isMemory)) return true;
      }
  }
  const st = statOf(paths[0]);
  if (!st?.isFile() || st.nlink < 2) return false;
  return roots.some((r) =>
    authorityFilePaths(r).some((f) => {
      const a = statOf(f);
      return a?.ino === st.ino && a.dev === st.dev;
    }),
  );
}

/**
 * Existing authority files under `orgRoot`, as real paths (a symlinked entry
 * gives its target): what the SDK sandbox makes read-only with `denyWrite`.
 * Run-state files only of the current run (`current`); git-guard is left to
 * the role's own guard dir, which the caller denies already. A file created
 * after the role started is not in the list.
 */
export function authorityFilePaths(
  orgRoot: string | undefined,
  current?: { org: string; run?: string },
): string[] {
  if (!orgRoot) return [];
  const orgs = realPath(orgsDir(orgRoot));
  const out: string[] = [];
  for (const e of list(orgs)) {
    const p = realPath(join(orgs, e.name));
    const st = statOf(p);
    if (st?.isFile()) out.push(p);
    if (!st?.isDirectory()) continue;
    const memory = isMemoryDir(orgs, e.name);
    const names = [normalizeSegment(e.name)];
    for (const c of list(p)) {
      const q = realPath(join(p, c.name));
      const cst = statOf(q);
      if (cst?.isFile() && isAuthorityBelowOrgs([...names, normalizeSegment(c.name)], () => memory))
        out.push(q);
      else if (cst?.isDirectory() && e.name === current?.org && c.name === current.run)
        for (const f of RUN_STATE_FILES) if (existsSync(join(q, f))) out.push(join(q, f));
    }
  }
  return out;
}

/**
 * `.monomind`, the orgs dir and every dir directly in it, as real paths: the
 * SDK sandbox binds each one writable onto itself (it lies under the
 * writable org root anyway), which makes it a mount point that cannot be
 * renamed — so no role can move the tree aside and plant a forged one.
 */
export function orgsMountPoints(orgRoot: string | undefined): string[] {
  if (!orgRoot) return [];
  const orgs = realPath(orgsDir(orgRoot));
  if (!statOf(orgs)?.isDirectory()) return [];
  return [
    realPath(join(orgRoot, '.monomind')),
    orgs,
    ...list(orgs)
      .filter((e) => e.isDirectory())
      .map((e) => join(orgs, e.name)),
  ];
}

/**
 * The layout the bubblewrap mask needs (authority-mask.ts): the orgs dir and
 * every symlinked org dir to bind read-only, then the dirs roles write in to
 * bind back read-write — each real subdirectory of an org dir except
 * git-guard/ and the run dirs, and each org memory dir — then the authority
 * files inside those (a memory dir's decision, state and control files, and
 * symlink targets that live outside the read-only dirs) read-only again.
 * All real paths; empty when there is no orgs dir.
 */
export function orgsMaskLayout(orgRoot: string | undefined): {
  readOnly: string[];
  writable: string[];
  files: string[];
} {
  const layout = { readOnly: [] as string[], writable: [] as string[], files: [] as string[] };
  if (!orgRoot) return layout;
  const orgs = realPath(orgsDir(orgRoot));
  if (!statOf(orgs)?.isDirectory()) return layout;
  layout.readOnly.push(orgs);
  for (const e of list(orgs)) {
    const lp = join(orgs, e.name);
    const p = realPath(lp);
    const st = statOf(p);
    if (!st?.isDirectory()) continue;
    const linked = lstatSync(lp).isSymbolicLink();
    if (isMemoryDir(orgs, e.name)) {
      layout.writable.push(p);
      continue;
    }
    if (linked) layout.readOnly.push(p);
    for (const c of list(p))
      if (c.isDirectory() && c.name !== GIT_GUARD_DIR && !RUN_DIR.test(c.name))
        layout.writable.push(join(p, c.name));
  }
  const within = (f: string) =>
    layout.readOnly.some((d) => {
      const below = segmentsBelow(d, f);
      return below !== null && !layout.writable.some((w) => segmentsBelow(w, f) !== null);
    });
  layout.files = authorityFilePaths(orgRoot).filter((f) => !within(f));
  return layout;
}
