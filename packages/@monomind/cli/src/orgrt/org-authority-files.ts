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
 * normalizeSegment): case-insensitively on darwin and win32, and wherever
 * the caller's fold says the filesystem may fold case (#496).
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import {
  normalizeSegment,
  realPath,
  type SegmentFold,
  segmentsBelow,
  uniq,
} from './policy-paths.js';

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
const lstatOf = (p: string) => {
  try {
    return lstatSync(p);
  } catch {
    return undefined;
  }
};

/** Where a path below the orgs dir may really live: the orgs dir itself
 *  (lexical and real), plus the real target of every entry of it, or of an
 *  org dir, that is a symlink — with the segments that entry stands for. */
const anchorCache = new Map<string, { at: number; value: ReturnType<typeof listAnchors> }>();
/** How long a listing of the orgs tree is reused: a burst of file-tool calls
 *  reads it once, and a symlink planted since is seen a moment later. */
const ANCHOR_TTL_MS = 1000;

function anchors(orgRoot: string, platform: NodeJS.Platform, fold?: SegmentFold) {
  const key = `${platform}\0${fold}\0${orgRoot}`;
  const hit = anchorCache.get(key);
  if (hit && Date.now() - hit.at < ANCHOR_TTL_MS) return hit.value;
  const value = listAnchors(orgRoot, platform, fold);
  anchorCache.set(key, { at: Date.now(), value });
  return value;
}

function listAnchors(orgRoot: string, platform: NodeJS.Platform, fold?: SegmentFold) {
  const lexical = orgsDir(orgRoot);
  const real = realPath(lexical);
  const out: Array<{ base: string; prefix: string[] }> = [
    { base: real, prefix: [] },
    { base: lexical, prefix: [] },
  ];
  const linked = (dir: string, prefix: string[]) => {
    for (const e of list(dir)) {
      const p = join(dir, e.name);
      const at = [...prefix, normalizeSegment(e.name, platform, fold)];
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
 * `fold` (#496): how segments compare — the policy passes the target's
 * `pathFolds().deny`; by default, case-folded on darwin and win32.
 */
export function isAuthorityFile(
  target: string | { real: string; lexical: string },
  orgRoots: string | string[],
  platform: NodeJS.Platform = process.platform,
  fold?: SegmentFold,
): boolean {
  const paths = typeof target === 'string' ? [target] : [target.real, target.lexical];
  const roots = typeof orgRoots === 'string' ? [orgRoots] : orgRoots;
  for (const orgRoot of roots) {
    const { real, anchors: bases } = anchors(orgRoot, platform, fold);
    const isMemory = (org: string) => isMemoryDir(real, org);
    for (const { base, prefix } of bases)
      for (const p of paths) {
        const below = segmentsBelow(base, p, platform, fold);
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
 * `.monomind`, the orgs dir, every dir directly in it and every dir directly
 * in an org dir, as real paths: the SDK sandbox binds each one writable onto
 * itself (it lies under the writable org root anyway), which makes it a
 * mount point that cannot be renamed — so no role can move the tree, or an
 * org's `reports/`, aside and plant a symlink or a forged copy in its place.
 */
export function orgsMountPoints(orgRoot: string | undefined): string[] {
  if (!orgRoot) return [];
  const orgs = realPath(orgsDir(orgRoot));
  if (!statOf(orgs)?.isDirectory()) return [];
  const out = [realPath(join(orgRoot, '.monomind')), orgs];
  for (const e of list(orgs)) {
    if (!e.isDirectory()) continue;
    const org = join(orgs, e.name);
    out.push(
      org,
      ...list(org)
        .filter((c) => c.isDirectory())
        .map((c) => join(org, c.name)),
    );
  }
  return out;
}

/** Every org's guard dir (real dirs only): the SDK sandbox denies each one
 *  whole, so no role rewrites another role's hooks. */
export function gitGuardDirs(orgRoot: string | undefined): string[] {
  if (!orgRoot) return [];
  const orgs = realPath(orgsDir(orgRoot));
  return list(orgs)
    .filter((e) => e.isDirectory())
    .map((e) => join(orgs, e.name, GIT_GUARD_DIR))
    .filter((d) => lstatOf(d)?.isDirectory());
}

/** The dirs in an org dir roles work in, created before a masked role
 *  starts: the mask binds only existing dirs read-write, and the orgs dir
 *  around them is read-only (a worktree added under `work/src` needs
 *  `work/` to exist). */
export const ORG_WORK_DIRS = ['work', 'reports', 'runs', 'scratch', 'workspace', '.mail'];

/**
 * `mkdir -p` each org's work dirs (ORG_WORK_DIRS), plus the `<dir>` of every
 * `fileWrite` glob of the form `.monomind/orgs/<org>/<dir>/…` (relative to
 * `cwd`, or absolute) — only for orgs that exist, never the guard dir or a
 * run dir.
 */
export function ensureOrgWorkDirs(
  orgRoot: string | undefined,
  fileWrite: string[] = [],
  cwd = orgRoot,
): void {
  if (!orgRoot || !cwd) return;
  const orgs = realPath(orgsDir(orgRoot));
  if (!statOf(orgs)?.isDirectory()) return;
  const isOrg = (name: string) =>
    lstatOf(join(orgs, name))?.isDirectory() === true &&
    DEF_EXTS.some((x) => existsSync(join(orgs, name + x)));
  const dirs: string[] = [];
  for (const e of list(orgs))
    if (isOrg(e.name)) dirs.push(...ORG_WORK_DIRS.map((d) => join(orgs, e.name, d)));
  const literal = (s: string | undefined): s is string =>
    !!s && !/[*?[\]{}]/.test(s) && s !== '.' && s !== '..';
  for (const g of fileWrite) {
    const abs = isAbsolute(g) ? g : resolve(cwd, g);
    const [org, dir, next] = segmentsBelow(orgs, abs) ?? segmentsBelow(orgsDir(orgRoot), abs) ?? [];
    if (next === undefined || !literal(org) || !literal(dir) || !isOrg(org)) continue;
    if (dir === GIT_GUARD_DIR || RUN_DIR.test(dir)) continue;
    dirs.push(join(orgs, org, dir));
  }
  for (const d of dirs) {
    try {
      mkdirSync(d, { recursive: true });
    } catch {
      /* stays read-only under the mask; the role's own write reports why */
    }
  }
}

/**
 * The layout the bubblewrap mask needs (authority-mask.ts): the orgs dir and
 * every symlinked org dir to bind read-only, then the dirs roles write in to
 * bind back read-write — each real subdirectory of an org dir except the
 * guard dir and the run dirs, and each org memory dir — then the authority
 * files inside those (a memory dir's decision, state and control files, and
 * symlink targets that live outside the read-only dirs) read-only again.
 * All real paths; empty when there is no orgs dir.
 *
 * A symlinked org or memory entry is skipped when its target is `/`, the org
 * root, `.monomind`, the orgs dir or one of `protectedDirs` ($HOME, the
 * authority dirs), or holds one of them, or lies inside the orgs tree: a
 * planted `ln -s .. orgs/foo` must not bind the tree read-write, nor
 * `ln -s $HOME orgs/foo` bind over the hidden credentials. No writable dir
 * may hold the orgs dir or a protected dir either.
 */
export function orgsMaskLayout(
  orgRoot: string | undefined,
  protectedDirs: string[] = [],
): {
  readOnly: string[];
  writable: string[];
  files: string[];
} {
  const layout = { readOnly: [] as string[], writable: [] as string[], files: [] as string[] };
  if (!orgRoot) return layout;
  const orgs = realPath(orgsDir(orgRoot));
  if (!statOf(orgs)?.isDirectory()) return layout;
  const hidden = protectedDirs.map(realPath);
  const critical = uniq([
    '/',
    realPath(orgRoot),
    realPath(join(orgRoot, '.monomind')),
    orgs,
    ...hidden,
  ]);
  const holds = (outer: string, inner: string) => segmentsBelow(outer, inner) !== null;
  const unsafeTarget = (t: string) => critical.some((c) => holds(t, c)) || holds(orgs, t);
  layout.readOnly.push(orgs);
  for (const e of list(orgs)) {
    const lp = join(orgs, e.name);
    const p = realPath(lp);
    if (!statOf(p)?.isDirectory()) continue;
    const linked = lstatOf(lp)?.isSymbolicLink() === true;
    if (linked && unsafeTarget(p)) continue;
    if (isMemoryDir(orgs, e.name)) {
      layout.writable.push(p);
      continue;
    }
    if (linked) layout.readOnly.push(p);
    for (const c of list(p))
      if (c.isDirectory() && c.name !== GIT_GUARD_DIR && !RUN_DIR.test(c.name))
        layout.writable.push(join(p, c.name));
  }
  layout.writable = layout.writable.filter(
    (w) => !holds(w, orgs) && !hidden.some((d) => holds(w, d)),
  );
  const within = (f: string) =>
    layout.readOnly.some((d) => {
      const below = segmentsBelow(d, f);
      return below !== null && !layout.writable.some((w) => segmentsBelow(w, f) !== null);
    });
  layout.files = authorityFilePaths(orgRoot).filter((f) => !within(f));
  return layout;
}
