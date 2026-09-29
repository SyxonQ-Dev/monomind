// packages/@monomind/cli/src/orgrt/cline-runner-host.ts
/**
 * Cline runner setup and cleanup: where cline keeps its state for a turn,
 * the session-id lookup (`cline history --json`), and the hub daemon reaper.
 *
 * Hub daemon (verified live, cline 3.0.65): a turn that uses cline's own
 * state (no `--data-dir`) and every `--acp` session spawns a detached
 * `cline --cline-hub-daemon --cwd … --port …` in its own session (setsid),
 * which outlives the turn. Its pid is in `<dataDir>/locks/hub/<env>.json`,
 * and it inherits the spawning cline's environment — so the per-turn marker
 * CLINE_TURN_ENV the runner sets identifies exactly the daemon this turn
 * started (a daemon the user already had running is reused, not marked, and
 * never killed). `--data-dir` (scoped turns) forces cline's local backend:
 * no daemon at all.
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentRunArgs } from './agent-runner.js';
import { installScopedPlugin, SCOPED_WORKSPACE_ENV } from './cline-runner-scoped.js';
import type { ClineHistoryRow, ClineHost } from './cline-runner-types.js';
import { omitAnthropicManagedKeys } from './provider.js';

/** Per-turn marker env on every cline process this runner spawns (and so on
 *  the hub daemon and the commands cline runs). Also the nested-agent marker. */
export const CLINE_TURN_ENV = 'MONOMIND_CLINE_TURN';
const HUB_DAEMON_ARG = '--cline-hub-daemon';
const REAP_GRACE_MS = 3000;

export const defaultClineHost: ClineHost = {
  history(bin, env, limit) {
    return new Promise((resolve) => {
      execFile(
        bin,
        ['history', '--json', '--limit', String(limit)],
        { env, timeout: 20_000, maxBuffer: 32 * 1024 * 1024 },
        (err, stdout) => {
          if (err) return resolve([]);
          try {
            const rows = JSON.parse(String(stdout));
            resolve(Array.isArray(rows) ? (rows as ClineHistoryRow[]) : []);
          } catch {
            resolve([]);
          }
        },
      );
    });
  },
  hubLockPids(dataDir) {
    const dir = join(dataDir, 'locks', 'hub');
    const pids: number[] = [];
    try {
      for (const f of readdirSync(dir)) {
        if (!f.endsWith('.json')) continue;
        try {
          const pid = JSON.parse(readFileSync(join(dir, f), 'utf8'))?.pid;
          if (Number.isInteger(pid) && pid > 1) pids.push(pid);
        } catch {
          /* torn or foreign file */
        }
      }
    } catch {
      /* no hub lock yet */
    }
    return pids;
  },
  pidsWithEnv(name, value) {
    if (process.platform !== 'linux') return [];
    const want = `${name}=${value}`;
    const pids: number[] = [];
    let entries: string[] = [];
    try {
      entries = readdirSync('/proc');
    } catch {
      return [];
    }
    for (const e of entries) {
      if (!/^\d+$/.test(e)) continue;
      try {
        if (readFileSync(`/proc/${e}/environ`, 'latin1').split('\0').includes(want))
          pids.push(Number(e));
      } catch {
        /* gone, or another user's */
      }
    }
    return pids;
  },
  cmdline(pid) {
    if (process.platform !== 'linux') return undefined;
    try {
      return readFileSync(`/proc/${pid}/cmdline`, 'latin1').split('\0').join(' ');
    } catch {
      return undefined;
    }
  },
  kill(pid, signal) {
    if (signal !== 0 && process.platform !== 'win32') {
      try {
        process.kill(-pid, signal); // the daemon leads its own session/group
        return true;
      } catch {
        /* not a group leader — the pid alone below */
      }
    }
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  },
  scopedDir: () => join(homedir(), '.monomind', 'cline-scoped'),
};

/** How one run reaches cline: its env, the state flags, the data dir. */
export interface ClineSetup {
  bin: string;
  /** Child env (the per-turn marker is added per spawn). */
  env: Record<string, string>;
  /** `--config <dir>` in scoped mode, [] when cline uses the user's own. */
  configArgs: string[];
  /** `--data-dir <dir>` for json turns in scoped mode. */
  dataDirArgs: string[];
  /** Where the hub lock and sessions live for this run. */
  dataDir: string;
  scoped: boolean;
}

/**
 * Full access (`access: 'full'`) or `--settings` (settingSources non-empty):
 * cline runs on the user's own state — `~/.cline` auth, rules, hooks and the
 * MCP servers in `cline_mcp_settings.json` — untouched. Otherwise (scoped):
 * `--config`/`--data-dir` point at a persistent monomind-owned dir, and
 * CLINE_MCP_SETTINGS_PATH at an empty server list, so no user MCP server or
 * hook loads; auth then comes from the environment (CLINE_PROVIDER plus the
 * provider's key variable, e.g. ANTHROPIC_API_KEY / OPENROUTER_API_KEY).
 * Scoped turns also refuse every tool call that needs approval
 * (cline-runner-scoped.ts): the config dir carries the refusal plugin.
 */
export function prepareClineSetup(args: AgentRunArgs, bin: string, host: ClineHost): ClineSetup {
  const env = { ...omitAnthropicManagedKeys(process.env), ...args.env };
  const scoped = args.access !== 'full' && (args.settingSources?.length ?? 0) === 0;
  if (!scoped) {
    const clineDir = env.CLINE_DIR || join(homedir(), '.cline');
    return {
      bin,
      env,
      configArgs: [],
      dataDirArgs: [],
      dataDir: env.CLINE_DATA_DIR || join(clineDir, 'data'),
      scoped,
    };
  }
  const dir = host.scopedDir();
  const dataDir = join(dir, 'data');
  const mcpPath = join(dir, 'cline_mcp_settings.json');
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  if (!existsSync(mcpPath)) writeFileSync(mcpPath, '{"mcpServers":{}}\n', { mode: 0o600 });
  // Refuse, never approve or wait (cline-runner-scoped.ts): the plugin, and
  // no desktop approval IPC, whose unanswered request would block 5 minutes.
  installScopedPlugin(dir);
  delete env.CLINE_TOOL_APPROVAL_MODE;
  delete env.CLINE_TOOL_APPROVAL_DIR;
  env.CLINE_DATA_DIR = dataDir;
  env.CLINE_MCP_SETTINGS_PATH = mcpPath;
  env[SCOPED_WORKSPACE_ENV] = args.cwd;
  return {
    bin,
    env,
    configArgs: ['--config', dir],
    dataDirArgs: ['--data-dir', dataDir],
    dataDir,
    scoped,
  };
}

/** The hub daemons a turn started: marker-carrying processes, plus a lock
 *  pid that appeared during the turn — each confirmed a hub daemon by its
 *  command line when the platform can read one. */
export function turnHubDaemons(
  host: ClineHost,
  marker: string,
  dataDir: string,
  before: ReadonlySet<number>,
): number[] {
  const found = new Set<number>();
  for (const pid of host.pidsWithEnv(CLINE_TURN_ENV, marker)) {
    if (host.cmdline(pid)?.includes(HUB_DAEMON_ARG)) found.add(pid);
  }
  for (const pid of host.hubLockPids(dataDir)) {
    if (before.has(pid) || found.has(pid)) continue;
    const cmd = host.cmdline(pid);
    if (cmd === undefined ? host.kill(pid, 0) : cmd.includes(HUB_DAEMON_ARG)) found.add(pid);
  }
  return [...found];
}

/** SIGTERM each daemon now and SIGKILL any still alive after a grace. */
export function reapHubDaemons(host: ClineHost, pids: number[], graceMs = REAP_GRACE_MS): void {
  for (const pid of pids) host.kill(pid, 'SIGTERM');
  if (pids.length === 0) return;
  const t = setTimeout(() => {
    for (const pid of pids) if (host.kill(pid, 0)) host.kill(pid, 'SIGKILL');
  }, graceMs);
  t.unref?.();
}

/** A turn run by the hub daemon records its prompt wrapped as
 *  `<user_input mode="act">…</user_input>` (verified live); the local
 *  backend records it bare. */
function normalizePrompt(p: string): string {
  return p
    .trim()
    .replace(/^<user_input\b[^>]*>/u, '')
    .replace(/<\/user_input>$/u, '')
    .trim();
}

/** The history row of the json turn that just ran: same cwd, started at or
 *  after the spawn; its prompt, else its pid, else the only such row. A
 *  hub-run turn records the daemon's pid, so the prompt is the main key. */
export function matchHistoryRow(
  rows: ClineHistoryRow[],
  q: { cwd: string; prompt: string; pid?: number; sinceMs: number },
): ClineHistoryRow | undefined {
  const fresh = rows.filter((r) => {
    if (r.isSubagent || r.cwd !== q.cwd || typeof r.sessionId !== 'string') return false;
    const t = r.startedAt ? Date.parse(r.startedAt) : Number.NaN;
    return Number.isNaN(t) || t >= q.sinceMs - 2000;
  });
  const want = normalizePrompt(q.prompt);
  return (
    fresh.find((r) => r.prompt !== undefined && normalizePrompt(r.prompt) === want) ??
    (q.pid !== undefined ? fresh.find((r) => r.pid === q.pid) : undefined) ??
    (fresh.length === 1 ? fresh[0] : undefined)
  );
}
