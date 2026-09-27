/**
 * CLI MCP Client — core tool roster (advertised vs. discovery-only tools)
 * Split out of mcp-client.ts (file-size sweep). Pure move.
 */

import { categoryFromToolName, ensureCategory } from './mcp-client-registry.js';
import type { MCPTool } from './mcp-tools/types.js';

/**
 * Core tool roster — the categories advertised via tools/list by default.
 * Non-core categories remain CALLABLE (callMCPTool/hasTool lazy-load any
 * category by name) but are not advertised, cutting the per-call schema
 * payload from ~270 tools to ~70. Set MONOMIND_MCP_FULL=1 to advertise all.
 */
export const FULL_ROSTER = process.env.MONOMIND_MCP_FULL === '1';

export const CORE_TOOL_CATEGORIES = new Set([
  'memory',
  'monograph',
  'hooks',
  'task',
  'session',
  'knowledge',
  'system',
  'mcp',
  'guidance',
  'config',
  'agent',
  'monomind',
  'monodesign',
  'platforms',
  'pick',
  'org',
]);

// Only this subset of hooks is advertised; the rest of hooks (intelligence,
// model-routing, trajectory, worker tools) is discovery-only.
export const CORE_HOOKS_ALLOWLIST = new Set([
  'hooks_route',
  'hooks_pre-edit',
  'hooks_post-edit',
  'hooks_pre-command',
  'hooks_post-command',
  'hooks_pre-task',
  'hooks_post-task',
  'hooks_explain',
]);

// Rarely-used tools inside otherwise-core categories: not advertised via
// tools/list, but still callable and discoverable via monomind_tool_search.
export const CORE_HIDDEN_TOOLS = new Set([
  // monograph: build/index maintenance, impact-map, and route-map variants
  'monograph_dead_code',
  'monograph_route_map',
  'monograph_augment',
  'monograph_staleness',
  'monograph_detect_changes',
  'monograph_get_node',
  'monograph_god_nodes',
  'monograph_watch',
  'monograph_watch_stop',
  'monograph_doctor',
  'monograph_health',
  'monograph_stats',
  'monograph_api_impact',
  // memory: routing, admin, batch, hierarchical, and KG maintenance variants
  'memory_route',
  'memory_semantic-route',
  'memory_causal-edge',
  'memory_batch',
  'memory_context-synthesize',
  'memory_controllers',
  'memory_health',
  'memory_consolidate',
  'memory_kg_consolidate',
  'memory_hierarchical-store',
  'memory_hierarchical-recall',
  'memory_pattern-search',
  // NOTE: memory_kg_stats and memory_kg_rollback stay ADVERTISED — the
  // Memory Loop documented in CLAUDE.md (ingest → search → rollback on bad
  // ingest, glossary via kg_stats) references them; hiding them broke that
  // workflow in Claude sessions for ~160 tokens of savings.
]);

export function isCoreAdvertised(tool: MCPTool): boolean {
  const cat = categoryFromToolName(tool.name);
  if (!CORE_TOOL_CATEGORIES.has(cat)) return false;
  if (cat === 'hooks') return CORE_HOOKS_ALLOWLIST.has(tool.name);
  if (CORE_HIDDEN_TOOLS.has(tool.name)) return false;
  return true;
}

let _coreLoaded = false;
export async function ensureCoreLoaded(): Promise<void> {
  if (_coreLoaded) return;
  _coreLoaded = true;
  await Promise.all([...CORE_TOOL_CATEGORIES].map((cat) => ensureCategory(cat)));
}
