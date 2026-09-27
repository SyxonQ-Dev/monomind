/**
 * System MCP Tools for CLI
 *
 * V2 Compatibility - System monitoring tools: status, metrics, health
 *
 * ✅ Uses REAL system metrics via Node.js APIs:
 * - process.memoryUsage() for real memory stats
 * - process.cpuUsage() for real CPU stats
 * - os module for system information
 */

import { systemHealthTool } from './system-tools-health.js';
import { systemInfoTool, systemResetTool } from './system-tools-info.js';
import { mcpStatusTool, taskSummaryTool } from './system-tools-misc.js';
import { systemMetricsTool, systemStatusTool } from './system-tools-status.js';
import type { MCPTool } from './types.js';

export const systemTools: MCPTool[] = [
  systemStatusTool,
  systemMetricsTool,
  systemHealthTool,
  systemInfoTool,
  systemResetTool,
  mcpStatusTool,
  taskSummaryTool,
];
