/**
 * Terminal MCP Tools for CLI
 *
 * Terminal session management with real command execution.
 */

export { filterSecretEnvVars } from './terminal-tools-core.js';

import { terminalCreateTool } from './terminal-tools-create.js';
import { terminalExecuteTool } from './terminal-tools-execute.js';
import {
  terminalCloseTool,
  terminalHistoryTool,
  terminalListTool,
} from './terminal-tools-session.js';
import type { MCPTool } from './types.js';

export const terminalTools: MCPTool[] = [
  terminalCreateTool,
  terminalExecuteTool,
  terminalListTool,
  terminalCloseTool,
  terminalHistoryTool,
];
