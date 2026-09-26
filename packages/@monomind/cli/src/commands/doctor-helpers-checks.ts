/**
 * Doctor — hook helper checks: installed helpers vs the bundled copies
 * (freshness and --fix) and guidance gate wiring.
 * Extracted from doctor-project-checks.ts.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isKeptUserEdit } from '../init/file-guard.js';
import { DOCTOR_TRACKED_HELPERS, OBSOLETE_HELPER_NAMES } from '../init/helpers-generator.js';
import {
  type HealthCheck,
  MAX_DOCTOR_CONFIG_BYTES,
  MAX_DOCTOR_HELPER_BYTES,
  MAX_DOCTOR_PKG_BYTES,
} from './doctor-env-checks.js';

function _resolveBundledHelper(relativePath: string): string | null {
  try {
    const thisFile = fileURLToPath(import.meta.url);
    let dir = dirname(thisFile);
    for (;;) {
      const candidate = join(dir, 'package.json');
      if (existsSync(candidate) && statSync(candidate).size <= MAX_DOCTOR_PKG_BYTES) {
        try {
          const pkg = JSON.parse(readFileSync(candidate, 'utf8'));
          if (
            pkg.name === '@monomind/cli' ||
            pkg.name === 'monomind' ||
            pkg.name === '@monoes/monomindcli'
          ) {
            const helperPath = join(dir, relativePath);
            return existsSync(helperPath) ? helperPath : null;
          }
        } catch {
          /* keep walking */
        }
      }
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  } catch {
    return null;
  }
}

// Top-level critical helpers, plus every file bundled under handlers/ and utils/
// (capture-handler.cjs, gates-handler.cjs, route-handler.cjs, session-handler.cjs,
// etc. — where most actual hook-behavior fixes live). Subdir membership is
// discovered from the bundled package itself, not hardcoded, so a helper added
// upstream is picked up automatically instead of silently never syncing.
function _allTrackedHelperNames(): string[] {
  const names = [...DOCTOR_TRACKED_HELPERS];
  for (const sub of ['handlers', 'utils']) {
    const bundledSubDir = _resolveBundledHelper(join('.claude', 'helpers', sub));
    if (!bundledSubDir) continue;
    try {
      for (const f of readdirSync(bundledSubDir)) {
        if (f.startsWith('._')) continue;
        if (statSync(join(bundledSubDir, f)).isDirectory()) continue;
        names.push(join(sub, f));
      }
    } catch {
      /* skip */
    }
  }
  return names;
}

// Top-level helpers the bundle ships. Their mere ABSENCE is a defect no
// matter which one it is — handlers/ scripts require() some of them at module
// load, and a missing one fails the hook closed (issue #225: doctor reported
// "helpers match bundled version" while audit-log-writer.cjs was absent and
// every PreToolUse hook was crashing). Existence is checked for all of them;
// content is still only hash-compared for _allTrackedHelperNames(), because
// the rest are user-editable scaffolds (memory.cjs, session.cjs) whose local
// edits are legitimate and must not be reported as staleness.
function _bundledTopLevelHelperNames(): string[] {
  const bundledDir = _resolveBundledHelper(join('.claude', 'helpers'));
  if (!bundledDir) return [];
  try {
    return readdirSync(bundledDir, { withFileTypes: true })
      .filter((e) => e.isFile() && !e.name.startsWith('._'))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

// The installed helper copies doctor compares against the bundle: the Claude
// Code tree, plus the copy init writes to .gemini/helpers (Antigravity's status
// bar runs .gemini/helpers/statusline.cjs), which is only checked when present.
const CLAUDE_HELPERS = join('.claude', 'helpers');
const GEMINI_HELPERS = join('.gemini', 'helpers');

async function _detectStaleHelpers(helpersDir: string = CLAUDE_HELPERS): Promise<{
  stale: string[];
  missing: string[];
  orphaned: string[];
}> {
  const stale: string[] = [];
  const missing: string[] = [];
  // Helpers this product shipped under a name it has since renamed away from
  // (e.g. graphify-freshen.cjs -> monograph-freshen.cjs). Reported separately
  // from `stale`/`missing`: unlike those, doctor --fix does not delete these
  // on its own — settings.json may still have a hook command pointing at one,
  // and only `init --force` (which also refreshes settings.json in the same
  // pass) can safely remove it. See writeHelpers/writeSettings.
  const orphaned = OBSOLETE_HELPER_NAMES.filter((name) =>
    existsSync(join(process.cwd(), '.claude', 'helpers', name)),
  );
  const crypto = await import('node:crypto');
  const hashChecked = new Set(_allTrackedHelperNames());
  for (const name of new Set([..._allTrackedHelperNames(), ..._bundledTopLevelHelperNames()])) {
    const bundled = _resolveBundledHelper(join('.claude', 'helpers', name));
    // Oversized-bundled is reported the same as missing-bundled: doctor can't
    // verify freshness either way, and silently excluding it from both `stale`
    // and `missing` would let checkHelpersFresh() report "pass" without ever
    // having actually compared this file.
    if (!bundled || statSync(bundled).size > MAX_DOCTOR_HELPER_BYTES) {
      missing.push(name);
      continue;
    }
    const local = join(process.cwd(), helpersDir, name);
    if (!existsSync(local)) {
      stale.push(name);
      continue;
    } // bundled has it, project doesn't — needs creating
    if (!hashChecked.has(name)) continue; // existence-only (see above)
    if (statSync(local).size > MAX_DOCTOR_HELPER_BYTES) continue;
    try {
      const hashLocal = crypto.createHash('sha256').update(readFileSync(local)).digest('hex');
      const hashBundled = crypto.createHash('sha256').update(readFileSync(bundled)).digest('hex');
      if (hashLocal !== hashBundled) stale.push(name);
    } catch {
      /* skip */
    }
  }
  return { stale, missing, orphaned };
}

/** Stale helpers in the Gemini copy, as `.gemini/helpers/<name>`; none if not installed. */
async function _detectStaleGeminiHelpers(): Promise<string[]> {
  if (!existsSync(join(process.cwd(), GEMINI_HELPERS))) return [];
  const { stale } = await _detectStaleHelpers(GEMINI_HELPERS);
  return stale.map((name) => `.gemini/helpers/${name.split(sep).join('/')}`);
}

export async function fixStaleHelpers(): Promise<boolean> {
  const { stale } = await _detectStaleHelpers();
  const targets = stale.map((name) => ({ name, local: join(process.cwd(), CLAUDE_HELPERS, name) }));
  if (existsSync(join(process.cwd(), GEMINI_HELPERS))) {
    for (const name of (await _detectStaleHelpers(GEMINI_HELPERS)).stale) {
      targets.push({ name, local: join(process.cwd(), GEMINI_HELPERS, name) });
    }
  }
  let fixed = 0;
  for (const { name, local } of targets) {
    // A helper `monomind init` kept because the user edited it is theirs.
    if (isKeptUserEdit(process.cwd(), local)) continue;
    const bundled = _resolveBundledHelper(join('.claude', 'helpers', name));
    if (bundled) {
      try {
        mkdirSync(dirname(local), { recursive: true });
        copyFileSync(bundled, local);
        fixed++;
      } catch (e) {
        if (process.env.DEBUG || process.env.MONOMIND_DEBUG)
          console.error(`[fixStaleHelpers] failed to copy ${name}:`, e);
      }
    }
  }
  return fixed > 0;
}

export async function checkHelpersFresh(): Promise<HealthCheck> {
  try {
    const { stale: claudeStale, missing, orphaned } = await _detectStaleHelpers();
    const stale = [...claudeStale, ...(await _detectStaleGeminiHelpers())];
    if (orphaned.length > 0) {
      return {
        name: 'Helper Files',
        status: 'warn',
        message: `Found ${orphaned.length} hook(s) from before a rename, still on disk: ${orphaned.join(', ')}. Run \`monomind init --force\` to update your hooks and rebuild the Monograph graph.`,
        fix: 'monomind init --force',
        // `--fix` only copies stale helpers; it never removes these.
        fixSafety: 'manual',
      };
    }
    if (stale.length === 0 && missing.length === 0) {
      return {
        name: 'Helper Files',
        status: 'pass',
        message: 'Project helpers match bundled version',
      };
    }
    if (stale.length > 0) {
      return {
        name: 'Helper Files',
        status: 'warn',
        message: `${stale.length} stale helper(s): ${stale.join(', ')}`,
        fix: 'monomind init upgrade',
        fixSafety: 'auto',
      };
    }
    return {
      name: 'Helper Files',
      status: 'warn',
      message: `Could not locate bundled copies of: ${missing.join(', ')}`,
      fix: 'Reinstall monomind or run `monomind init upgrade`',
      fixSafety: 'manual',
    };
  } catch (e) {
    return {
      name: 'Helper Files',
      status: 'warn',
      message: `check failed: ${e instanceof Error ? e.message : 'unknown'}`,
    };
  }
}

export async function checkGuidanceGates(): Promise<HealthCheck> {
  const settingsPath = join(process.cwd(), '.claude', 'settings.json');
  const gatesHandlerPath = join(
    process.cwd(),
    '.claude',
    'helpers',
    'handlers',
    'gates-handler.cjs',
  );
  if (!existsSync(gatesHandlerPath)) {
    return {
      name: 'Guidance Gates',
      status: 'warn',
      message: 'gates-handler.cjs not found — enforcement gates not installed',
      fix: 'monomind init  (then monomind guidance setup)',
    };
  }
  if (!existsSync(settingsPath)) {
    return {
      name: 'Guidance Gates',
      status: 'warn',
      message: 'gates-handler.cjs present but .claude/settings.json missing',
      fix: 'monomind guidance setup',
    };
  }
  try {
    if (statSync(settingsPath).size > MAX_DOCTOR_CONFIG_BYTES) {
      return {
        name: 'Guidance Gates',
        status: 'warn',
        message: 'settings.json too large to parse',
      };
    }
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    const preToolUse: Array<{ matcher?: string; hooks: Array<{ command: string }> }> =
      settings?.hooks?.PreToolUse ?? [];
    // Match on capability, not on an exact matcher string. The matcher is a
    // regex alternation that legitimately changes as tools are added — it
    // gained `|NotebookEdit` when that tool turned out to bypass the secret
    // gate — and an `=== 'Write|Edit|MultiEdit'` test reported the gate as
    // INACTIVE the moment it did, telling users their secrets gate was off
    // while it was demonstrably blocking secrets, and sending them to
    // `guidance setup`, which would then add a duplicate entry.
    const hasPreWrite = preToolUse.some(
      (e) =>
        /\bWrite\b/.test(e.matcher ?? '') && e.hooks.some((h) => h.command?.includes('pre-write')),
    );
    const hasPreBash = preToolUse.some(
      (e) => e.matcher === 'Bash' && e.hooks.some((h) => h.command?.includes('pre-bash')),
    );
    if (!hasPreWrite && !hasPreBash)
      return {
        name: 'Guidance Gates',
        status: 'warn',
        message: 'gates-handler.cjs present but no gates registered',
        fix: 'monomind guidance setup',
      };
    if (!hasPreWrite)
      return {
        name: 'Guidance Gates',
        status: 'warn',
        message: 'pre-write hook not registered — secrets gate inactive',
        fix: 'monomind guidance setup',
      };
    if (!hasPreBash)
      return {
        name: 'Guidance Gates',
        status: 'warn',
        message: 'pre-bash hook not registered — destructive-ops gate inactive',
        fix: 'monomind guidance setup',
      };
    return {
      name: 'Guidance Gates',
      status: 'pass',
      message: 'destructive-ops (pre-bash) + secrets (pre-write) gates active',
    };
  } catch {
    return {
      name: 'Guidance Gates',
      status: 'warn',
      message: 'Could not parse .claude/settings.json',
      fix: 'monomind guidance setup --force',
    };
  }
}
