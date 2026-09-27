/**
 * Session MCP Tools for CLI
 *
 * Tool definitions for session management with file persistence.
 */

import { sessionQueryTools } from './session-tools-query.js';
import { sessionSaveTools } from './session-tools-save.js';
import type { MCPTool } from './types.js';

export const sessionTools: MCPTool[] = [...sessionSaveTools, ...sessionQueryTools];
