// packages/@monomind/cli/src/orgrt/planted-paths.ts
/**
 * #502 review round 3: paths that don't exist yet can't be denied by an OS
 * sandbox (deny lists drop missing paths), so a role can PLANT one that the
 * operator's own processes then obey:
 *   - `~/.claude/.config.json`: Claude Code prefers this legacy global
 *     config over `~/.claude.json` whenever it exists, `mcpServers` included;
 *     `.claude*.json` variants beside either;
 *   - a missing `<worktree>/.mcp.json` or `<root>/.claude/`: the repo's
 *     tracked `.claude/settings.json` approves the `monomind` MCP server by
 *     name, so a planted `.mcp.json` server of that name starts unprompted;
 *   - every other operator-protected path that was dropped for not existing.
 *
 * Creating a placeholder is no answer (an empty `~/.claude/.config.json`
 * alone switches the operator's config, an empty `.mcp.json` is an invalid
 * config), so instead: each role session records which of these paths are
 * missing when it starts, and they are checked again when it ends, on every
 * `org serve` tick and when the next session starts. Anything that appeared
 * is moved — never deleted — to `.monomind/orgs/<org>/quarantine/<ts>/`,
 * with an audit event and a question in the operator's inbox saying how to
 * put it back (a file the operator created meanwhile looks the same).
 *
 * The SDK sandbox's own 0-byte mount-point stubs (sandbox-stubs.ts) — and a
 * directory holding only such stubs — are not a plant and are left alone.
 */

import {
  cpSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { HOME_DENY_WRITE } from './file-roots.js';
import {
  CLAUDE_HOME_EXEC,
  ensureOperatorProtectedPaths,
  operatorProtectedPaths,
} from './operator-protected-paths.js';

/** Global-config name variants Claude Code reads beside `~/.claude.json`. */
const HOME_CONFIG_VARIANT = /^\.claude.*\.json$/;
const CLAUDE_DIR_CONFIG_VARIANT = /^\.(claude.*|config)\.json$/;

export interface WatchCtx {
  home: string;
  env: NodeJS.ProcessEnv;
  orgRoot?: string;
  cwd: string;
  allowWrite?: string[];
}

/** A 0-byte file, or a directory holding only such files: a sandbox stub. */
function isStubOnly(p: string): boolean {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(p);
  } catch {
    return true;
  }
  if (st.isFile()) return st.size === 0;
  if (!st.isDirectory()) return false;
  try {
    return readdirSync(p).every((e) => isStubOnly(join(p, e)));
  } catch {
    return false;
  }
}

const exists = (p: string): boolean => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

function listNames(dir: string, re: RegExp): string[] {
  try {
    return readdirSync(dir).filter((n) => re.test(n));
  } catch {
    return [];
  }
}

/** Every path a role must not be able to plant, for this role's context. */
export function plantCandidates(ctx: WatchCtx): string[] {
  const roots = [...new Set([ctx.orgRoot, ctx.cwd].filter((r): r is string => !!r))];
  return [
    ...new Set([
      ...roots.flatMap((r) => [join(r, '.mcp.json'), join(r, '.claude')]),
      join(ctx.home, '.claude', '.config.json'),
      join(ctx.home, '.claude.json'),
      join(ctx.home, '.mcp.json'),
      ...CLAUDE_HOME_EXEC.map((p) => join(ctx.home, '.claude', p)),
      // ~/.claude itself is Claude Code's own state dir, not a plant.
      ...HOME_DENY_WRITE.filter((p) => p !== '.claude').map((p) => join(ctx.home, p)),
      ...operatorProtectedPaths(ctx),
    ]),
  ];
}

export interface PlantFinding {
  path: string;
  quarantined?: string;
  error?: string;
}

/** One org run's watch: the protected paths that were missing, and the
 *  config-variant names that already existed, as its sessions started. */
export class PlantWatch {
  private missing = new Set<string>();
  private variantDirs = new Map<string, { re: RegExp; known: Set<string> }>();

  constructor(
    private orgRoot: string,
    private org: string,
    private notify: (findings: PlantFinding[]) => void | Promise<void>,
  ) {}

  /** Record what is missing now for this role's context (check first). */
  add(ctx: WatchCtx): void {
    for (const p of plantCandidates(ctx)) if (!exists(p)) this.missing.add(p);
    for (const [dir, re] of [
      [ctx.home, HOME_CONFIG_VARIANT],
      [join(ctx.home, '.claude'), CLAUDE_DIR_CONFIG_VARIANT],
    ] as const) {
      const entry = this.variantDirs.get(dir) ?? { re, known: new Set<string>() };
      for (const n of listNames(dir, re)) if (!this.missing.has(join(dir, n))) entry.known.add(n);
      this.variantDirs.set(dir, entry);
    }
  }

  /** Paths that appeared since they were recorded missing (stubs excepted). */
  planted(): string[] {
    const found = [...this.missing].filter((p) => exists(p) && !isStubOnly(p));
    for (const [dir, { re, known }] of this.variantDirs)
      for (const n of listNames(dir, re)) {
        const p = join(dir, n);
        if (!known.has(n) && !found.includes(p) && !isStubOnly(p)) found.push(p);
      }
    return found;
  }

  /** Quarantine whatever appeared and tell the operator. */
  async check(): Promise<PlantFinding[]> {
    const paths = this.planted();
    if (!paths.length) return [];
    const findings = quarantine(
      paths,
      join(this.orgRoot, '.monomind', 'orgs', this.org, 'quarantine'),
    );
    await this.notify(findings);
    return findings;
  }
}

/** Move each path into `<dir>/<ts>/`, never deleting it: rename, or copy
 *  then remove across filesystems. A manifest records where each came from. */
export function quarantine(paths: string[], dir: string, now = new Date()): PlantFinding[] {
  const target = join(dir, now.toISOString().replace(/[:.]/g, '-'));
  mkdirSync(target, { recursive: true, mode: 0o700 });
  const findings: PlantFinding[] = paths.map((path, i) => {
    const dest = join(target, `${i}-${basename(path)}`);
    try {
      try {
        renameSync(path, dest);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
        cpSync(path, dest, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
        rmSync(path, { recursive: true, force: true });
      }
      return { path, quarantined: dest };
    } catch (err) {
      return { path, error: (err as Error).message };
    }
  });
  writeFileSync(join(target, 'manifest.json'), `${JSON.stringify(findings, null, 2)}\n`);
  return findings;
}

/** The operator-facing text for a quarantine. */
export function quarantineMessage(org: string, findings: PlantFinding[]): string {
  const moved = findings.filter((f) => f.quarantined);
  const failed = findings.filter((f) => f.error);
  return [
    `org ${org}: ${findings.length} path(s) that the operator's own sessions trust appeared while its roles ran. A role may have planted them, so they were moved aside, not deleted.`,
    ...moved.map((f) => `  ${f.path} -> ${f.quarantined}`),
    ...failed.map(
      (f) =>
        `  ${f.path}: could NOT be moved (${f.error}) — inspect it before opening a Claude Code session here`,
    ),
    moved.length
      ? `If you created one of them yourself, restore it with: mv '<quarantined path>' '<original path>' (the manifest.json beside them lists both).`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}

const watches = new Map<string, PlantWatch>();

/** The watch for one org (created on first use, reset at each fresh start). */
export function plantWatchFor(
  orgRoot: string,
  org: string,
  notify: (findings: PlantFinding[]) => void | Promise<void>,
): PlantWatch {
  const key = `${orgRoot}\0${org}`;
  let w = watches.get(key);
  if (!w) {
    w = new PlantWatch(orgRoot, org, notify);
    watches.set(key, w);
  }
  return w;
}

export function resetPlantWatch(orgRoot: string, org: string): void {
  watches.delete(`${orgRoot}\0${org}`);
}

/** `org serve`'s tick: check every org's watch. */
export async function sweepPlantWatches(): Promise<PlantFinding[]> {
  const all: PlantFinding[] = [];
  for (const w of watches.values()) all.push(...(await w.check()));
  return all;
}

/** Around one role session (session.ts): check, record, and return the
 *  check to run when it ends. */
export async function beginPlantWatch(opts: {
  org: string;
  orgRoot?: string;
  cwd: string;
  role: { policy?: { sandbox?: { allowWrite?: string[] } } };
  bus: { emit(e: Record<string, unknown>): void };
  askHuman?: (role: string, question: string, blocking?: boolean) => Promise<string>;
  def?: { roles: Array<{ id: string; reports_to?: string | null }> };
  home?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<() => Promise<void>> {
  const orgRoot = opts.orgRoot ?? opts.cwd;
  const home = opts.home ?? homedir();
  const env = opts.env ?? process.env;
  // Our own directories first, so they are not taken for plants.
  ensureOperatorProtectedPaths({ home, env, orgRoot });
  const coordinator = opts.def?.roles.find((r) => r.reports_to == null)?.id;
  const watch = plantWatchFor(orgRoot, opts.org, async (findings) => {
    const msg = quarantineMessage(opts.org, findings);
    opts.bus.emit({ type: 'audit', reason: 'planted-path-quarantined', msg, data: { findings } });
    console.warn(`[orgrt] ${msg}`);
    if (opts.askHuman && coordinator)
      await opts
        .askHuman(coordinator, `[for the operator, not the coordinator] ${msg}`, false)
        .catch(() => {});
  });
  const safeCheck = async () => {
    try {
      await watch.check();
    } catch (err) {
      console.warn(`[orgrt] org ${opts.org}: planted-path check failed: ${(err as Error).message}`);
    }
  };
  await safeCheck();
  watch.add({
    home,
    env,
    orgRoot,
    cwd: opts.cwd,
    allowWrite: opts.role.policy?.sandbox?.allowWrite,
  });
  return safeCheck;
}
