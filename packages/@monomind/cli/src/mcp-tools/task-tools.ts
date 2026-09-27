/**
 * Task MCP Tools for CLI
 *
 * Tool definitions for task management with file persistence.
 */

export { loadTaskStore, loadTaskStoreOrNull } from './task-tools-core.js';

import { taskAssignTool, taskCancelTool } from './task-tools-assign.js';
import { taskCreateTool, taskListTool, taskStatusTool } from './task-tools-crud.js';
import { taskCompleteTool, taskUpdateTool } from './task-tools-lifecycle.js';
import type { MCPTool } from './types.js';

export const taskTools: MCPTool[] = [
  taskCreateTool,
  taskStatusTool,
  taskListTool,
  taskCompleteTool,
  taskUpdateTool,
  taskAssignTool,
  taskCancelTool,
];
