/**
 * kimi-code MCP config generation (.kimi-code/mcp.json).
 * File-size sweep: split out of kimi-generator.ts.
 */

import type { InitOptions } from './types.js';

function isWindows(): boolean {
  return process.platform === 'win32';
}

/** Platform-specific npx invocation, mirrors mcp-generator.ts. */
function monomindMcpEntry(env: Record<string, string>): Record<string, unknown> {
  const base = ['-y', 'monomind@latest', 'mcp', 'start'];
  return isWindows()
    ? { command: 'cmd', args: ['/c', 'npx', ...base], env }
    : { command: 'npx', args: base, env };
}

function monomindEnv(options: InitOptions): Record<string, string> {
  return {
    npm_config_update_notifier: 'false',
    MONOMIND_MODE: 'v1',
    MONOMIND_HOOKS_ENABLED: 'true',
    MONOMIND_TOPOLOGY: options.runtime.topology,
    MONOMIND_MAX_AGENTS: String(options.runtime.maxAgents),
    MONOMIND_MEMORY_BACKEND: options.runtime.memoryBackend,
  };
}

/**
 * Build the .kimi-code/mcp.json object. Standalone (no existing file) case;
 * the executor merges into an existing file via mergeKimiMcpJson below.
 */
export function generateKimiMcpConfig(options: InitOptions): Record<string, unknown> {
  const config: Record<string, unknown> = { mcpServers: {} };
  if (options.mcp.monomind) {
    (config.mcpServers as Record<string, unknown>).monomind = monomindMcpEntry(
      monomindEnv(options),
    );
  }
  return config;
}

export function generateKimiMcpJson(options: InitOptions): string {
  return `${JSON.stringify(generateKimiMcpConfig(options), null, 2)}\n`;
}

/**
 * Merge the monomind server into an existing .kimi-code/mcp.json without
 * touching the user's other servers. Returns null when the existing file is
 * unparseable (caller should skip, never clobber).
 */
export function mergeKimiMcpJson(existing: string, options: InitOptions): string | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(existing) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const servers = (parsed.mcpServers ?? {}) as Record<string, unknown>;
  if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) return null;
  if (options.mcp.monomind) servers.monomind = monomindMcpEntry(monomindEnv(options));
  parsed.mcpServers = servers;
  return `${JSON.stringify(parsed, null, 2)}\n`;
}
