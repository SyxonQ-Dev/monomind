/**
 * Agent MCP Tools for CLI
 *
 * Tool definitions for agent lifecycle management with file persistence.
 * Includes model routing integration for intelligent model selection.
 */

import { agentLifecycleTools } from './agent-tools-lifecycle.js';
import { agentPoolTools } from './agent-tools-pool.js';
import type { MCPTool } from './types.js';

export { loadAgentStore, loadAgentStoreOrNull } from './agent-tools-store.js';

export const agentTools: MCPTool[] = [...agentLifecycleTools, ...agentPoolTools];
