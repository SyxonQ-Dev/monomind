// packages/@monomind/cli/src/orgrt/planted-paths.ts
/**
 * #502 review rounds 3–4: paths that don't exist yet can't be denied by an
 * OS sandbox (deny lists drop missing paths), so a role can PLANT one that
 * the operator's own processes then obey.
 *
 * Two checks, each quarantining — moving, never deleting — what it finds to
 * `<operator dir>/quarantine/<project id>/<ts>/` (roles can neither read nor
 * write the operator dir, so they can't move a plant back or edit the
 * manifest), with an audit event and a question in the operator's inbox that
 * spells out the exact `mv` to undo it:
 *
 * 1. INDEPENDENT OF ANY RUN: `~/.claude/.config.json` (Claude Code
 *    prefers this legacy global config over `~/.claude.json` whenever it
 *    exists) and every other `.claude*.json` beside `~/.claude.json` or in
 *    `~/.claude` that was not there at monomind's first look (recorded once
 *    in the operator dir: some machines' Claude Code still writes a live
 *    legacy config, which must not be moved); and an untracked `.mcp.json` in an org
 *    work tree (`.monomind/orgs/<org>/work*`, `worktree*`) or a role cwd that
 *    is a git work tree. Runs at every org start, every `org run` / `org
 *    serve` tick, every session start and end, and every `doctor` run. An
 *    operator who really uses a legacy config file allows it once by
 *    creating `<operator dir>/allow-claude-legacy-config`.
 * 2. BASELINE: every other operator-protected path that was missing when a
 *    role session started (`plantCandidates`). The baseline is stored in the
 *    operator dir, so a crash or kill of `org run` does not make a plant look
 *    pre-existing on the next start; it is never reset by a fresh start, only
 *    by the operator: `monomind org sign` drops the paths that exist at that
 *    point (the operator approving them).
 *
 * The SDK sandbox's own 0-byte mount-point stubs (sandbox-stubs.ts) — and a
 * directory holding only such stubs — are not a plant and are left alone.
 */

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { defaultOperatorDir } from './broker.js';
import { HOME_DENY_WRITE } from './file-roots.js';
import {
  CLAUDE_HOME_EXEC,
  ensureOperatorProtectedPaths,
  operatorProtectedPaths,
} from './operator-protected-paths.js';
import { orgProjectId } from './org-signature.js';

/** Global-config name variants Claude Code reads beside `~/.claude.json`. */
const HOME_CONFIG_VARIANT = /^\.claude.*\.json$/;
const CLAUDE_DIR_CONFIG_VARIANT = /^\.(claude.*|config)\.json$/;
export const ALLOW_LEGACY_CONFIG = 'allow-claude-legacy-config';

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
      join(ctx.home, '.mcp.json'),
      ...CLAUDE_HOME_EXEC.map((p) => join(ctx.home, '.claude', p)),
      // ~/.claude and ~/.claude.json are Claude Code's own state, which it
      // creates itself (the operator's session and claude roles alike).
      ...HOME_DENY_WRITE.filter((p) => p !== '.claude' && p !== '.claude.json').map((p) =>
        join(ctx.home, p),
      ),
      ...operatorProtectedPaths(ctx),
    ]),
  ];
}

/** Existing, non-stub global-config candidates other than the current one. */
function claudeConfigCandidates(home: string, env: NodeJS.ProcessEnv): string[] {
  const current = env.CLAUDE_CONFIG_DIR
    ? join(resolve(env.CLAUDE_CONFIG_DIR), '.claude.json')
    : join(home, '.claude.json');
  const claudeDir = join(home, '.claude');
  const found = [
    join(claudeDir, '.config.json'),
    ...listNames(home, HOME_CONFIG_VARIANT).map((n) => join(home, n)),
    ...listNames(claudeDir, CLAUDE_DIR_CONFIG_VARIANT).map((n) => join(claudeDir, n)),
  ];
  return [...new Set(found)].filter((p) => p !== current && exists(p) && !isStubOnly(p));
}

const configRecordPath = (operatorDir: string) => join(operatorDir, 'claude-config-baseline.json');

function readConfigRecord(operatorDir: string): Record<string, string[]> | undefined {
  try {
    return JSON.parse(readFileSync(configRecordPath(operatorDir), 'utf8')) as Record<
      string,
      string[]
    >;
  } catch {
    return undefined;
  }
}

function writeConfigRecord(operatorDir: string, rec: Record<string, string[]>): void {
  mkdirSync(operatorDir, { recursive: true, mode: 0o700 });
  const path = configRecordPath(operatorDir);
  writeFileSync(`${path}.${process.pid}.tmp`, `${JSON.stringify(rec, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${path}.${process.pid}.tmp`, path);
}

/** 1a. Claude Code global-config files other than the operator's current
 *  `~/.claude.json` — `~/.claude/.config.json` above all — that were not
 *  there when monomind first looked. That first look is recorded once in
 *  the operator dir (a live legacy config the operator already had is
 *  trusted; Claude Code 2.1 still writes one on some machines) and never
 *  reset by an org start; anything appearing after it is a plant. */
export function strayClaudeConfigs(
  home: string,
  env: NodeJS.ProcessEnv,
  operatorDir = defaultOperatorDir(),
  opts: { readOnly?: boolean } = {},
): string[] {
  if (exists(join(operatorDir, ALLOW_LEGACY_CONFIG))) return [];
  const found = claudeConfigCandidates(home, env);
  const rec = readConfigRecord(operatorDir) ?? {};
  if (!rec[home]) {
    // Read-only (doctor --read-only/--json): no first look to compare with.
    if (!opts.readOnly) writeConfigRecord(operatorDir, { ...rec, [home]: found });
    return [];
  }
  const trusted = new Set(rec[home]);
  return found.filter((p) => !trusted.has(p));
}

/** `org sign`: the operator trusts the global-config files that exist now. */
function approveClaudeConfigs(home: string, env: NodeJS.ProcessEnv, operatorDir: string): void {
  const rec = readConfigRecord(operatorDir) ?? {};
  writeConfigRecord(operatorDir, {
    ...rec,
    [home]: [...new Set([...(rec[home] ?? []), ...claudeConfigCandidates(home, env)])],
  });
}

/** 1b. An untracked `.mcp.json` in an org work tree or a role cwd that is a
 *  git work tree (the operator's session there would load it). */
export function untrackedWorktreeMcp(orgRoot: string | undefined, cwds: string[] = []): string[] {
  const dirs = new Set(cwds);
  if (orgRoot) {
    const orgs = join(orgRoot, '.monomind', 'orgs');
    for (const org of listNames(orgs, /./)) {
      for (const w of listNames(join(orgs, org), /^(work|worktree)/)) {
        const top = join(orgs, org, w);
        dirs.add(top);
        for (const sub of listNames(top, /./)) dirs.add(join(top, sub));
      }
    }
  }
  const out: string[] = [];
  for (const d of dirs) {
    const mcp = join(d, '.mcp.json');
    if (!exists(join(d, '.git')) || !exists(mcp) || isStubOnly(mcp)) continue;
    const tracked = spawnSync('git', ['-C', d, 'ls-files', '--error-unmatch', '.mcp.json'], {
      stdio: 'ignore',
      timeout: 5000,
    });
    if (tracked.status !== 0) out.push(mcp);
  }
  return out;
}

export interface PlantFinding {
  path: string;
  quarantined?: string;
  error?: string;
}

/** Move each path into the operator dir's quarantine, never deleting it:
 *  rename, or copy then remove across filesystems, plus a manifest. */
export function quarantine(
  paths: string[],
  root: string,
  operatorDir = defaultOperatorDir(),
  now = new Date(),
): PlantFinding[] {
  const base = join(operatorDir, 'quarantine', orgProjectId(root));
  const target = join(base, `${now.toISOString().replace(/[:.]/g, '-')}-${process.pid}`);
  mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const d of [join(operatorDir, 'quarantine'), base, target]) chmodSync(d, 0o700);
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
  writeFileSync(join(target, 'manifest.json'), `${JSON.stringify(findings, null, 2)}\n`, {
    mode: 0o600,
  });
  return findings;
}

const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The operator-facing text, built from the in-memory findings. */
export function quarantineMessage(org: string | undefined, findings: PlantFinding[]): string {
  const moved = findings.filter((f) => f.quarantined);
  const failed = findings.filter((f) => f.error);
  return [
    `${org ? `org ${org}` : 'monomind'}: ${findings.length} path(s) that the operator's own sessions trust appeared, and a role may have planted them. They were moved aside, not deleted.`,
    ...moved.map((f) => `  ${f.path} -> ${f.quarantined}`),
    ...failed.map(
      (f) =>
        `  ${f.path}: could NOT be moved (${f.error}) — inspect it before opening a Claude Code session here`,
    ),
    moved.length ? 'If you created one yourself, restore it and approve it:' : '',
    ...moved.map((f) => `  mv ${sq(f.quarantined as string)} ${sq(f.path)}`),
    moved.length
      ? `  then run \`monomind org sign ${org ?? '<org>'}\` (a legacy Claude config also needs \`touch ~/.monomind/orgrt-operator/${ALLOW_LEGACY_CONFIG}\`).`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function baselinePath(root: string, operatorDir: string): string {
  return join(operatorDir, 'plant-baseline', `${orgProjectId(root)}.json`);
}

function readBaseline(root: string, operatorDir: string): Set<string> {
  try {
    const data = JSON.parse(readFileSync(baselinePath(root, operatorDir), 'utf8')) as {
      missing?: unknown;
    };
    return new Set(Array.isArray(data.missing) ? data.missing.map(String) : []);
  } catch {
    return new Set();
  }
}

function writeBaseline(root: string, operatorDir: string, missing: Set<string>): void {
  const path = baselinePath(root, operatorDir);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ missing: [...missing].sort() }, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(tmp, path);
}

/** `org sign`: the operator approves whatever protected path exists now. */
export function approveExistingPlantPaths(
  root: string,
  operatorDir = defaultOperatorDir(),
  home = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): void {
  approveClaudeConfigs(home, env, operatorDir);
  const missing = readBaseline(root, operatorDir);
  const kept = new Set([...missing].filter((p) => !exists(p)));
  if (kept.size !== missing.size) writeBaseline(root, operatorDir, kept);
}

/** One project's watch. The baseline lives in the operator dir; the watch
 *  also remembers the home and cwds its sessions used, for check 1. */
export class PlantWatch {
  private home = homedir();
  private env: NodeJS.ProcessEnv = process.env;
  private cwds = new Set<string>();

  constructor(
    private orgRoot: string,
    readonly org: string,
    public notify: (findings: PlantFinding[]) => void | Promise<void>,
    private operatorDir = defaultOperatorDir(),
  ) {}

  /** Record what is missing now for this role's context — merged into the
   *  persisted baseline, never replacing it. */
  add(ctx: WatchCtx): void {
    this.home = ctx.home;
    this.env = ctx.env;
    this.cwds.add(ctx.cwd);
    strayClaudeConfigs(ctx.home, ctx.env, this.operatorDir); // records the first look, once
    const missing = readBaseline(this.orgRoot, this.operatorDir);
    const before = missing.size;
    for (const p of plantCandidates(ctx)) if (!exists(p)) missing.add(p);
    if (missing.size !== before) writeBaseline(this.orgRoot, this.operatorDir, missing);
  }

  /** What to quarantine now: both checks. */
  planted(): string[] {
    const fromBaseline = [...readBaseline(this.orgRoot, this.operatorDir)].filter(
      (p) => exists(p) && !isStubOnly(p),
    );
    return [
      ...new Set([
        ...strayClaudeConfigs(this.home, this.env, this.operatorDir),
        ...untrackedWorktreeMcp(this.orgRoot, [...this.cwds]),
        ...fromBaseline,
      ]),
    ];
  }

  async check(): Promise<PlantFinding[]> {
    const paths = this.planted();
    if (!paths.length) return [];
    const findings = quarantine(paths, this.orgRoot, this.operatorDir);
    await this.notify(findings);
    return findings;
  }
}

const watches = new Map<string, PlantWatch>();

/** The watch for one org, created on first use and kept for the process;
 *  the latest caller's `notify` is the one used. */
export function plantWatchFor(
  orgRoot: string,
  org: string,
  notify: (findings: PlantFinding[]) => void | Promise<void>,
  operatorDir = defaultOperatorDir(),
): PlantWatch {
  const key = `${orgRoot}\0${org}\0${operatorDir}`;
  let w = watches.get(key);
  if (!w) {
    w = new PlantWatch(orgRoot, org, notify, operatorDir);
    watches.set(key, w);
  }
  w.notify = notify;
  return w;
}

/** The `org run` / `org serve` tick: check every watch. */
export async function sweepPlantWatches(): Promise<PlantFinding[]> {
  const all: PlantFinding[] = [];
  for (const w of watches.values()) {
    try {
      all.push(...(await w.check()));
    } catch (err) {
      console.warn(`[orgrt] planted-path sweep failed: ${(err as Error).message}`);
    }
  }
  return all;
}

type Notifier = {
  bus?: { emit(e: Record<string, unknown>): void };
  askHuman?: (role: string, question: string, blocking?: boolean) => Promise<string>;
  def?: { roles: Array<{ id: string; reports_to?: string | null }> };
};

/** An audit event, a warning and a (non-blocking) question in the inbox. */
export function plantNotifier(org: string, n: () => Notifier) {
  return async (findings: PlantFinding[]): Promise<void> => {
    const { bus, askHuman, def } = n();
    const msg = quarantineMessage(org, findings);
    bus?.emit({ type: 'audit', reason: 'planted-path-quarantined', msg, data: { findings } });
    console.warn(`[orgrt] ${msg}`);
    const coordinator = def?.roles.find((r) => r.reports_to == null)?.id;
    if (askHuman && coordinator)
      await askHuman(coordinator, `[for the operator, not the coordinator] ${msg}`, false).catch(
        () => {},
      );
  };
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
  const watch = plantWatchFor(
    orgRoot,
    opts.org,
    plantNotifier(opts.org, () => opts),
  );
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
