/**
 * Performance MCP Tools for CLI
 *
 * V2 Compatibility - Performance monitoring and optimization tools
 *
 * ✅ Uses REAL process metrics where available:
 * - process.memoryUsage() for real heap/memory stats
 * - process.cpuUsage() for real CPU time
 * - os module for system load and memory
 * - Real timing for benchmark operations
 *
 * Note: Some optimization suggestions are illustrative
 */

import { performanceBenchmarkTools } from './performance-tools-benchmark.js';
import { performanceOptimizeTools } from './performance-tools-optimize.js';
import { performanceReportTools } from './performance-tools-report.js';
import type { MCPTool } from './types.js';

export const performanceTools: MCPTool[] = [
  ...performanceReportTools,
  ...performanceBenchmarkTools,
  ...performanceOptimizeTools,
];
