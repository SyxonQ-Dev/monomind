// packages/@monomind/cli/src/orgrt/policy-scopes.ts
// #492: fileWrite/fileRead entries with no glob characters are directory
// grants — "this path and everything beneath it". Their real path is taken
// ONCE, when the PolicyEngine is built from the operator's config, so a role
// cannot widen a grant later by swapping the directory (or a missing entry)
// for a symlink from Bash.
import { existsSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, normalize, parse, resolve, sep } from 'node:path';
import { isWithin, pathSegments, realPath } from './policy-paths.js';

/** An entry containing none of these is a plain path; any other is a glob
 *  matched by globToRegExp. */
export function isGlobScope(entry: string): boolean {
  return /[*?[{]/.test(entry);
}

/** A scope entry as a deny message names it, saying how it matches so a role
 *  is not told it "may use" a directory it then cannot write inside. */
export function describeScope(entry: string): string {
  return isGlobScope(entry)
    ? `${entry} (glob)`
    : `${entry} (directory: this path and everything beneath it)`;
}

/** A directory grant as the operator configured it: `lexical` is the entry
 *  resolved against the org workdir's real path, `real` its real path at
 *  snapshot time. `refused` says why it grants nothing. */
export interface ScopeSnapshot {
  lexical: string;
  real: string;
  refused?: string;
}

/** Why `entry` cannot be a directory grant, or undefined when it can. */
function refusal(entry: string, lexical: string, real: string, home: string): string | undefined {
  if (real !== lexical && !onDiskSpelling(lexical, real))
    return `scope entry ${entry} resolves through a symlink (to ${real}) — name the real path instead`;
  const realHome = realPath(home);
  // Refusing a too-broad grant is a deny, so it folds (#496).
  if (parse(real).root === real || isWithin(real, realHome, 'deny')) {
    const glob = `${entry.replace(/[/\\]+$/, '')}/**`;
    return `scope entry ${entry} is the filesystem root, $HOME or an ancestor of $HOME — too broad for a directory grant; if you really mean it, write the explicit glob ${glob}`;
  }
  return undefined;
}

/**
 * #496: `real` differs from `lexical` only because realpathSync.native gave
 * the on-disk case (darwin/win32): no part of `lexical` is a symlink and the
 * two differ in case alone. Then `site` for a directory named `Site` is that
 * directory, not a symlink to it.
 */
export function onDiskSpelling(
  lexical: string,
  real: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== 'darwin' && platform !== 'win32') return false;
  // NFC first: HFS+ hands back NFD spellings.
  const a = pathSegments(lexical.normalize('NFC'), platform, 'case');
  const b = pathSegments(real.normalize('NFC'), platform, 'case');
  if (a.length !== b.length || a.some((s, i) => s !== b[i])) return false;
  for (let cur = lexical; dirname(cur) !== cur; cur = dirname(cur)) {
    try {
      if (lstatSync(cur).isSymbolicLink()) return false;
    } catch {
      /* not there yet — nothing to follow */
    }
  }
  return true;
}

/** Snapshot one non-glob entry. A missing entry snapshots its lexical path. */
export function snapshotScopeEntry(entry: string, cwd: string, home = homedir()): ScopeSnapshot {
  const lexical = resolve(realPath(cwd), entry);
  const real = realPath(lexical);
  return { lexical, real, refused: refusal(entry, lexical, real, home) };
}

/** Snapshots for every non-glob fileWrite/fileRead entry, keyed by entry. */
export function snapshotScopes(
  policy: { fileWrite?: string[]; fileRead?: string[] } | undefined,
  cwd: string,
): Map<string, ScopeSnapshot> {
  const out = new Map<string, ScopeSnapshot>();
  for (const e of [...(policy?.fileWrite ?? []), ...(policy?.fileRead ?? [])])
    if (!isGlobScope(e) && !out.has(e)) out.set(e, snapshotScopeEntry(e, cwd));
  return out;
}

/** A deny reason when a snapshotted entry no longer resolves to the path it
 *  had at startup (swapped for, or created as, a symlink), else undefined. */
export function scopeDrift(entry: string, snap: ScopeSnapshot): string | undefined {
  if (snap.refused) return undefined;
  const now = realPath(snap.lexical);
  if (now === snap.real) return undefined;
  return `scope entry ${entry} changed after the role started: it now resolves to ${now} instead of ${snap.real} (swapped for or created as a symlink) — file-tool calls under this scope are refused until the operator restores it`;
}

/** `org validate` findings for scope entries (placeholders already expanded):
 *  errors for a directory grant that would be refused at runtime, warnings for
 *  a missing absolute path (likely a typo) and a relative path leaving the
 *  role's workdir. Relative entries are otherwise checked at runtime, where the
 *  workdir is known. */
export function scopeEntryFindings(
  roles: { id: string; policy?: { fileWrite?: string[]; fileRead?: string[] } }[],
  home = homedir(),
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const role of roles)
    for (const field of ['fileWrite', 'fileRead'] as const)
      for (const entry of role.policy?.[field] ?? []) {
        if (isGlobScope(entry)) continue;
        const at = `role "${role.id}": policy.${field}`;
        if (!isAbsolute(entry)) {
          const n = normalize(entry);
          if (n === '..' || n.startsWith(`..${sep}`) || n.startsWith('../'))
            warnings.push(
              `${at} entry ${entry} resolves outside the role's workdir — use an absolute path if that is intended`,
            );
          continue;
        }
        const snap = snapshotScopeEntry(entry, '/', home);
        if (snap.refused) errors.push(`${at}: ${snap.refused}`);
        else if (!existsSync(entry))
          warnings.push(
            `${at} entry ${entry} does not exist — a path entry grants that path and everything beneath it; check it for a typo`,
          );
      }
  return { errors, warnings };
}
