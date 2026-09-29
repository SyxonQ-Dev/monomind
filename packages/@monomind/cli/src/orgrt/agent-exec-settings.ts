// packages/@monomind/cli/src/orgrt/agent-exec-settings.ts
/**
 * Coder mode (#356): `--settings` flag parsing and the exec-engine-side
 * status/startup-watchdog handling. Kept out of commands/agent-exec.ts and
 * orgrt/agent-exec.ts (both shared with #355/#357 — see
 * /var/tmp/coder/common.md) so those files only gain a call site each.
 */

import type { SettingSource } from './agent-runner-claude-settings.js';

export type { SettingSource };

const VALID_SOURCES: readonly SettingSource[] = ['user', 'project', 'local'];

/** Parse `--settings none|<csv of user,project,local>` (default: `none`). */
export function parseSettingsFlag(raw: unknown): { sources: SettingSource[] } | { error: string } {
  const s = raw === undefined || raw === null || raw === '' ? 'none' : String(raw).trim();
  if (s === 'none') return { sources: [] };
  const tokens = s
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  const sources = new Set<SettingSource>();
  for (const t of tokens) {
    if (!(VALID_SOURCES as readonly string[]).includes(t)) {
      return {
        error: `invalid --settings value "${t}" (expected "none" or a CSV of user,project,local)`,
      };
    }
    sources.add(t as SettingSource);
  }
  if (sources.size === 0) {
    return { error: 'invalid --settings value (expected "none" or a CSV of user,project,local)' };
  }
  return { sources: [...sources] };
}

/**
 * Bridges ClaudeAgentRunner's `status` AgentMessage (emitted only when
 * `settingSources` is non-empty — see agent-runner-claude.ts) onto the
 * protocol's `status` NDJSON event, and races it against a startup watchdog:
 * loading the user's own settings/MCP servers re-triggers the historical
 * hang this feature investigated (#356) — if `phase:"ready"` never arrives
 * within `timeoutMs`, `terminate` fires and a `runner-error` is emitted
 * instead of hanging until `--timeout`. Disabled (`enabled: false`) is a
 * no-op so runtimes other than `claude`, or `--settings none`, are
 * unaffected: only ClaudeAgentRunner reports `phase:"ready"`, so the
 * watchdog cannot apply to a runtime that never would (those get
 * `runtimeStartupNotices` below instead).
 */
export interface ExecStatusHandler {
  onMessage(m: { type: string; phase?: string; mcp_servers?: unknown }): void;
  dispose(): void;
}

export function createExecStatusHandler(opts: {
  enabled: boolean;
  timeoutMs: number;
  emit: (ev: Record<string, unknown>) => void;
  terminate: (code: 'runner-error', exitCode: number) => void;
}): ExecStatusHandler {
  let settled = !opts.enabled;
  const timer = opts.enabled
    ? setTimeout(() => {
        if (settled) return;
        settled = true;
        opts.terminate('runner-error', 1);
        opts.emit({
          v: 1,
          type: 'error',
          code: 'runner-error',
          fatal: false,
          message: 'claude did not initialize (settings/MCP startup hang?)',
        });
      }, opts.timeoutMs)
    : null;
  return {
    onMessage(m) {
      if (!opts.enabled || m.type !== 'status') return;
      opts.emit({
        v: 1,
        type: 'status',
        phase: m.phase,
        ...(m.mcp_servers ? { mcp_servers: m.mcp_servers } : {}),
      });
      if (m.phase === 'ready' && !settled) {
        settled = true;
        if (timer) clearTimeout(timer);
      }
    },
    dispose() {
      settled = true;
      if (timer) clearTimeout(timer);
    },
  };
}

/** What each non-claude runtime loads when `--settings` leaves its own
 *  config un-isolated. The CLI decides; this names it for the caller. The
 *  source subset (user/project/local) is all-or-nothing outside claude. */
const RUNTIME_LOADS: Record<string, string> = {
  codex: 'user config (~/.codex/config.toml, incl. its MCP servers) + project AGENTS.md',
  opencode: 'user config (~/.config/opencode) + project opencode.json, AGENTS.md and MCP servers',
  antigravity: 'user settings (~/.gemini) + project GEMINI.md and .gemini/',
  kimicode: 'user config (~/.kimi) + project AGENTS.md and .kimi-code/',
};

/**
 * `status` notices a non-claude turn gets right after `start` (rev 15):
 * what `--settings` makes the CLI load, and an `--effort` the runtime does
 * not honor. `phase:"notice"` + `message`; claude's own
 * `initializing`/`ready` pair is unchanged and never produced here.
 */
export function runtimeStartupNotices(opts: {
  runtime: string;
  settings?: readonly string[];
  effort?: string;
  effortSupported: boolean;
}): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const note = (message: string) => out.push({ v: 1, type: 'status', phase: 'notice', message });
  if (opts.runtime !== 'claude' && (opts.settings?.length ?? 0) > 0) {
    const loads = RUNTIME_LOADS[opts.runtime] ?? 'its own user config and project files';
    note(`${opts.runtime}: ${loads}`);
  }
  if (opts.effort && !opts.effortSupported) {
    note(`${opts.runtime}: --effort ${opts.effort} ignored (no effort control on this runtime)`);
  }
  return out;
}
