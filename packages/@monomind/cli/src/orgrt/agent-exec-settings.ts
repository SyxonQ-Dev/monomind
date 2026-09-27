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
 * unaffected — matching AgentRunArgs.settingSources's own "other runners
 * ignore it" contract.
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
