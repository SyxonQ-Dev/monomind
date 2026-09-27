// packages/@monomind/cli/src/orgrt/agent-runner-claude-settings.ts
/**
 * Coder mode (#356): pure helper that decides how ClaudeAgentRunner packages
 * the SDK's own settings-discovery/MCP/system-prompt options, kept out of
 * agent-runner-claude.ts (a shared file three parallel issues touch — see
 * /var/tmp/coder/common.md) so that file's own diff stays a small,
 * reviewable branch on the existing options object instead of inline logic.
 *
 * `settingSources: []` (the empty-array default) reproduces today's
 * isolated behavior byte-for-byte: `strictMcpConfig: true`, the in-process
 * `org` MCP server as the sole tool surface, and the caller's system prompt
 * used verbatim (no preset). Any non-empty list is "coder mode": the SDK
 * loads the requested settings sources (CLAUDE.md, skills, hooks, project +
 * user MCP servers), `strictMcpConfig` relaxes so those MCP servers aren't
 * excluded, the `org` server is merged in only when the caller actually gave
 * this turn its own tools (no caller tools = no `mcpServers` override at
 * all, letting the SDK's own discovery be the complete MCP surface), and the
 * system prompt switches to the `claude_code` preset with the caller's text
 * appended instead of replacing Claude Code's own tool-use prompt.
 */

/** CSV tokens accepted by `--settings` (see doc/agent-exec-protocol.md §3.1). */
export type SettingSource = 'user' | 'project' | 'local';

export interface ClaudeSettingsOverrides {
  settingSources: SettingSource[];
  strictMcpConfig: boolean;
  /** Present only when the SDK's own `mcpServers` option should be set at
   *  all — omitted (not `{}`) so a non-none turn with no caller tools lets
   *  the SDK's settings discovery be the sole source of MCP servers. */
  mcpServers?: Record<string, unknown>;
  systemPrompt: string | { type: 'preset'; preset: 'claude_code'; append: string };
}

/** `args.orgServer` is the SDK's `createSdkMcpServer(...)` return value —
 *  typed `unknown` here to avoid pulling `@anthropic-ai/claude-agent-sdk`
 *  into this pure-logic module; the caller already has the real type. */
export function resolveClaudeSettingsOverrides(
  settingSources: SettingSource[],
  args: { systemPrompt: string; orgServer: unknown; hasCallerTools: boolean },
): ClaudeSettingsOverrides {
  if (settingSources.length === 0) {
    return {
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: { org: args.orgServer },
      systemPrompt: args.systemPrompt,
    };
  }
  return {
    settingSources,
    strictMcpConfig: false,
    ...(args.hasCallerTools ? { mcpServers: { org: args.orgServer } } : {}),
    systemPrompt: { type: 'preset', preset: 'claude_code', append: args.systemPrompt },
  };
}
