// packages/@monomind/cli/src/orgrt/tool-providers.ts
/**
 * Role tool providers (M1, capability `org-tool-providers`).
 *
 * A role's `tool_providers[]` names stdio MCP servers whose tools the role
 * gets next to the org tools, exposed as `<prefix>__<mcpToolName>` (so on the
 * Claude runner they arrive as `mcp__org__<prefix>__<tool>`).
 *
 * Lifecycle (contract §2 M1):
 *  - tool list: fetched once per provider config (hash of command, args, env,
 *    allow) by a short-lived process — spawn, initialize, tools/list, exit —
 *    and cached for the daemon's lifetime;
 *  - calls: the provider process is spawned lazily on the first call, reused,
 *    and exits after `idle_ms` without calls; a crash is restarted once per
 *    session, after which calls return `ERROR: tool provider <name>
 *    unavailable: <reason>`;
 *  - every provider process is killed on session end and on `stopOrg`.
 *
 * The MCP client here is a deliberately small, dependency-free JSON-RPC 2.0
 * client over newline-delimited stdio (the MCP stdio transport): initialize,
 * notifications/initialized, tools/list (with pagination), tools/call.
 */
import { randomBytes } from 'node:crypto';

export type {
  McpRpcError,
  McpSpawnSpec,
  McpTimeoutError,
  McpToolInfo,
} from './tool-providers-client.js';
export { MCP_PROTOCOL_VERSION, McpStdioClient } from './tool-providers-client.js';
export type { RoleProviderToolSet } from './tool-providers-hub.js';
export { ToolProviderHub } from './tool-providers-hub.js';
export type { ProviderContext } from './tool-providers-process.js';
export { providerPrefix, roleProviderPrefixes } from './tool-providers-process.js';
export {
  jsonSchemaCatchall,
  jsonSchemaToZod,
  jsonSchemaToZodShape,
} from './tool-providers-schema.js';

// ── Trace ────────────────────────────────────────────────────────────────

export interface ChainTrace {
  chain_id: string;
  hop: number;
}

export interface ToolCallTrace extends ChainTrace {
  org: string;
  run: string;
  role: string;
}

const TRACE_LINE = /^\[trace (chn_[A-Za-z0-9_-]+) hop=(\d+)\]/m;

/** The `[trace chn_<id> hop=<n>]` line of a message body, if any. */
export function parseTraceLine(body: string): ChainTrace | undefined {
  const m = TRACE_LINE.exec(body);
  if (!m) return undefined;
  return { chain_id: m[1], hop: Number.parseInt(m[2], 10) };
}

/** `chn_` + 20 random [a-z0-9]. */
export function freshChainId(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = randomBytes(20);
  let id = 'chn_';
  for (const b of bytes) id += alphabet[b % alphabet.length];
  return id;
}

// ── MCP result mapping ───────────────────────────────────────────────────

/** MCP `tools/call` result → tool text: text parts joined with '\n',
 *  non-text parts as `[<type> omitted]`, `isError: true` → `ERROR: ` prefix. */
export function mapToolResult(result: unknown): string {
  const r = (result ?? {}) as { content?: unknown; isError?: unknown };
  const parts: string[] = [];
  if (Array.isArray(r.content)) {
    for (const c of r.content as Array<{ type?: unknown; text?: unknown }>) {
      if (c && c.type === 'text' && typeof c.text === 'string') parts.push(c.text);
      else parts.push(`[${String(c?.type ?? 'unknown')} omitted]`);
    }
  }
  const text = parts.join('\n');
  return r.isError === true ? `ERROR: ${text}` : text;
}
