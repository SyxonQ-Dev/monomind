/**
 * Skill-version update check for context.mjs's boot output.
 *
 * Split out of context.mjs. See that file for context.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── Update check ──────────────────────────────────────────────────────────
// Piggyback a lightweight skill-version check on the once-per-session boot.
// When a newer skill ships, append an UPDATE_AVAILABLE directive so the agent
// can offer `monomind design update`. Everything here is best-effort and
// silent on failure: a network problem, sandbox, or missing cache must never
// block context output or print an error.

const UPDATE_HOST = (process.env.MONODESIGN_UPDATE_HOST || 'https://github.com/monoes/monomind').replace(/\/$/, '');
const UPDATE_CACHE_PATH =
  process.env.MONODESIGN_UPDATE_CACHE || path.join(os.homedir(), '.monodesign', 'update-check.json');
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // throttle the network poll to once a day
const RENOTIFY_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // don't re-surface the same version for a week
const FETCH_TIMEOUT_MS = 1200;


/**
 * Read the installed skill's own version from the sibling SKILL.md frontmatter
 * (this file lives at `<skill>/scripts/context.mjs`). Returns null when the
 * frontmatter is missing or unreadable.
 */
function readLocalSkillVersion() {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const skillMd = path.join(here, '..', 'SKILL.md');
    const content = fs.readFileSync(skillMd, 'utf-8');
    const match = content.match(/^version:\s*(.+)$/m);
    return match ? match[1].trim().replace(/^["']|["']$/g, '') : null;
  } catch {
    return null;
  }
}

function readUpdateCache() {
  try {
    return JSON.parse(fs.readFileSync(UPDATE_CACHE_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function writeUpdateCache(cache) {
  try {
    fs.mkdirSync(path.dirname(UPDATE_CACHE_PATH), { recursive: true });
    fs.writeFileSync(UPDATE_CACHE_PATH, JSON.stringify(cache));
  } catch {
    // Best-effort: a read-only home dir just means we re-poll next session.
  }
}

/** Compare dotted numeric versions. Returns >0 when a is newer than b. */
function compareSemver(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

async function fetchLatestSkillVersion() {
  try {
    const res = await fetch(`${UPDATE_HOST}/api/version`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data?.skills === 'string' ? data.skills : null;
  } catch {
    return null; // offline, sandboxed, timed out, or bad JSON: all non-fatal
  }
}

function buildUpdateDirective(localVersion, latestVersion) {
  return (
    `UPDATE_AVAILABLE: A newer Monodesign skill is available ` +
    `(installed v${localVersion}, latest v${latestVersion}). ` +
    `Before continuing, ask the user once: "A newer Monodesign (v${latestVersion}) is available. ` +
    `Update now? It runs \`monomind design update\`." ` +
    `If they agree, run \`monomind design update\` (the update applies to the next session, not this one). ` +
    `Either way, continue the current task without waiting, and do not raise this again.`
  );
}

/**
 * Best-effort update directive for the boot output. Returns a string to append
 * or null. Polls the version endpoint at most once per day (cached globally in
 * the user's home dir) and re-surfaces a given version at most once per week so
 * the agent never nags. Opt out entirely with MONODESIGN_NO_UPDATE_CHECK=1.
 */
// Read the unified config's top-level `updateCheck` (local overrides shared).
// Inlined rather than importing hook-lib so the boot path stays lightweight.
function updateCheckDisabledByConfig(cwd = process.cwd()) {
  let value;
  for (const name of ['config.json', 'config.local.json']) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(cwd, '.monodesign', name), 'utf-8'));
      if (raw && typeof raw === 'object' && typeof raw.updateCheck === 'boolean') value = raw.updateCheck;
    } catch { /* missing or malformed: ignore */ }
  }
  return value === false;
}

export async function computeUpdateDirective(now = Date.now()) {
  // Update checking is disabled in monomind: the skill ships with the monomind
  // package and follows monomind's own update flow (`monomind update`), so
  // there is no separate registry endpoint to poll. Kept as a stub so the boot
  // path (and MONODESIGN_NO_UPDATE_CHECK-aware tests) stays unchanged.
  return null;
  // biome-ignore lint/correctness/noUnreachable: disabled on purpose (see above); kept to re-enable
  try {
    if (process.env.MONODESIGN_NO_UPDATE_CHECK) return null;
    if (updateCheckDisabledByConfig()) return null;
    const localVersion = readLocalSkillVersion();
    if (!localVersion) return null;

    const cache = readUpdateCache();

    // Poll the network only when the throttle window has elapsed. Stamp
    // lastCheck even on failure so an offline machine doesn't poll every boot.
    if (!cache.lastCheck || now - cache.lastCheck > CHECK_INTERVAL_MS) {
      const latest = await fetchLatestSkillVersion();
      cache.lastCheck = now;
      if (latest) cache.latestVersion = latest;
      writeUpdateCache(cache);
    }

    const latest = cache.latestVersion;
    if (!latest || compareSemver(latest, localVersion) <= 0) return null;

    // Anti-nag: surface a given version at most once per RENOTIFY window.
    if (cache.notifiedVersion === latest && cache.notifiedAt && now - cache.notifiedAt < RENOTIFY_INTERVAL_MS) {
      return null;
    }
    cache.notifiedVersion = latest;
    cache.notifiedAt = now;
    writeUpdateCache(cache);

    return buildUpdateDirective(localVersion, latest);
  } catch {
    return null;
  }
}
