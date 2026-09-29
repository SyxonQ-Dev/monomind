// packages/@monomind/cli/src/orgrt/cline-runner-scoped.ts
/**
 * Limited (scoped) cline turns refuse every tool call that needs approval —
 * they never auto-approve it and never wait for an answer.
 *
 * "Needs approval" is cline's own rule (cline 3.0.65, runtime/tool-policies
 * .ts): with auto-approve off, only SAFE_TOOLS run without asking; commands,
 * file edits, patches, subagents, teams and MCP tools ask. Verified against
 * the 3.0.65 binary (2026-09-29):
 *   - `--json --auto-approve false` makes EVERY tool ask (the `"*"` policy
 *     has no per-tool exceptions in json mode), and a non-TTY run refuses
 *     each ask at once ("requires approval in a TTY session") — no hang, but
 *     reads are refused too.
 *   - A Cline plugin module in `<--config dir>/plugins/` is loaded in json
 *     and ACP mode, and its `hooks.beforeTool` can return `{policy}` (merged
 *     over the tool policy) or `{skip, reason}` (the call is not run; its
 *     result is `{error: reason}`).
 * So a scoped turn runs with `--auto-approve false` (fail closed: without the
 * plugin nothing runs) plus the plugin below, which re-approves SAFE_TOOLS
 * and skips everything else with a refusal the model can read. ACP turns
 * also answer `session/request_permission` the same way (allow SAFE_TOOLS,
 * reject the rest), should a request get through.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** cline's SAFE_AUTO_APPROVE_TOOL_NAMES (runtime/tool-policies.ts). */
export const CLINE_SAFE_TOOLS: readonly string[] = [
  'ask_followup_question',
  'ask_question',
  'fetch_web_content',
  'read_files',
  'search_codebase',
  'skills',
  'submit_and_exit',
];

/** Start of every refusal the plugin returns (and the ACP rejection names). */
export const SCOPED_REFUSAL = 'monomind limited mode refused';

export const SCOPED_PLUGIN_FILE = 'monomind-scoped.js';

/** Source of the plugin module written into the scoped config dir. */
export function scopedPluginSource(): string {
  return `// Written by monomind (cline-runner-scoped.ts) for limited cline turns.
const SAFE = new Set(${JSON.stringify(CLINE_SAFE_TOOLS)});
export default {
  name: 'monomind-scoped',
  manifest: { capabilities: ['hooks'] },
  hooks: {
    beforeTool(ctx) {
      const name = (ctx && ctx.toolCall && ctx.toolCall.toolName) || (ctx && ctx.tool && ctx.tool.name) || '';
      if (SAFE.has(name)) return { policy: { autoApprove: true } };
      return {
        skip: true,
        reason: ${JSON.stringify(SCOPED_REFUSAL)} + ' "' + name + '": this coder turn runs in limited mode, ' +
          'which never runs commands, file edits, subagents or MCP tools. Do not retry it; ' +
          'say what you would have done so the user can do it or switch to full access.',
      };
    },
  },
};
`;
}

/** Writes the plugin into `<configDir>/plugins/` (only when it changed). */
export function installScopedPlugin(configDir: string): void {
  const dir = join(configDir, 'plugins');
  const file = join(dir, SCOPED_PLUGIN_FILE);
  const src = scopedPluginSource();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (existsSync(file) && readFileSync(file, 'utf8') === src) return;
  writeFileSync(file, src, { mode: 0o600 });
}

/** Whether a tool error is a refusal (this runner's, or cline's own
 *  approval refusals) rather than the tool failing. */
export function isClineRefusal(text: string | undefined): boolean {
  if (!text) return false;
  return (
    text.includes(SCOPED_REFUSAL) ||
    /requires approval in a TTY session|requires approval but no approval callback|User rejected the tool call|Permission request was cancelled/.test(
      text,
    )
  );
}

/** The cline tool name of an ACP permission request (`title` is
 *  `"<toolName>: <input summary>"`). */
export function permissionToolName(toolCall: Record<string, unknown> | undefined): string {
  const title = typeof toolCall?.title === 'string' ? toolCall.title : '';
  return title.split(':')[0].trim();
}

type Option = { optionId?: unknown; kind?: unknown };

/** The answer to an ACP `session/request_permission`: full access allows it;
 *  scoped allows SAFE_TOOLS only and rejects the rest. */
export function acpPermissionOutcome(
  params: Record<string, unknown> | undefined,
  scoped: boolean,
): { outcome: Record<string, unknown>; denied: boolean } {
  const opts = Array.isArray(params?.options) ? (params.options as Option[]) : [];
  const pick = (...kinds: string[]) =>
    kinds.map((k) => opts.find((o) => o.kind === k)).find((o) => o !== undefined);
  const toolCall = params?.toolCall as Record<string, unknown> | undefined;
  const allowed = !scoped || CLINE_SAFE_TOOLS.includes(permissionToolName(toolCall));
  const chosen = allowed
    ? pick('allow_always', 'allow_once')
    : pick('reject_once', 'reject_always');
  return {
    outcome: chosen ? { outcome: 'selected', optionId: chosen.optionId } : { outcome: 'cancelled' },
    denied: !allowed || !chosen,
  };
}
