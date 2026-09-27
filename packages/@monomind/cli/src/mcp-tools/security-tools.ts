/**
 * Security MCP Tools - MonoFence Integration
 *
 * Provides MCP tools for AI manipulation defense:
 * - monofence_scan: Scan input for threats
 * - monofence_analyze: Deep analysis of threats
 * - monofence_stats: Get detection statistics
 * - monofence_learn: Learn from detection feedback
 *
 * github.com/monoes/monomind
 */

import {
  monofenceContextTool,
  monofenceHasPIITool,
  monofenceIsSafeTool,
  monofenceScanOutputTool,
} from './security-tools-checks.js';
import { monofenceLearnTool, monofenceStatsTool } from './security-tools-feedback.js';
import { monofenceAnalyzeTool, monofenceScanTool } from './security-tools-scan.js';
import type { MCPTool } from './types.js';

/**
 * Export all security tools
 */
export const securityTools: MCPTool[] = [
  monofenceScanTool,
  monofenceAnalyzeTool,
  monofenceStatsTool,
  monofenceLearnTool,
  monofenceIsSafeTool,
  monofenceHasPIITool,
  monofenceScanOutputTool,
  monofenceContextTool,
];

export default securityTools;
