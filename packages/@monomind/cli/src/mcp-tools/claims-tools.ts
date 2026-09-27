/**
 * Claims MCP Tools for CLI
 *
 * Implements MCP tools for ADR-016: Collaborative Issue Claims
 * Provides programmatic access to claim operations for MCP clients.
 *
 * The claims store lives in claims-store.ts and the tools are grouped by
 * family in the claims-*-tools.ts siblings; this module registers them in
 * their original order.
 *
 * @module @monomind/cli/mcp-tools/claims
 */

import { claimsBalanceTools } from './claims-balance-tools.js';
import { claimsClaimTools } from './claims-claim-tools.js';
import { claimsQueryTools } from './claims-query-tools.js';
import { claimsStealTools } from './claims-steal-tools.js';
import type { MCPTool } from './types.js';

export const claimsTools: MCPTool[] = [
  ...claimsClaimTools,
  ...claimsQueryTools,
  ...claimsStealTools,
  ...claimsBalanceTools,
];

export default claimsTools;
