/**
 * Config MCP Tools for CLI
 *
 * Tool definitions for configuration management with file persistence.
 */

import { configReadTools } from './config-tools-read.js';
import { configWriteTools } from './config-tools-write.js';
import type { MCPTool } from './types.js';

const [configGetTool, configListTool, configExportTool] = configReadTools;
const [configSetTool, configResetTool, configImportTool] = configWriteTools;

export const configTools: MCPTool[] = [
  configGetTool,
  configSetTool,
  configListTool,
  configResetTool,
  configExportTool,
  configImportTool,
];
