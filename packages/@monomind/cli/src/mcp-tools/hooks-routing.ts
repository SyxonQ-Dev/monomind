/**
 * Hooks Routing MCP Tools
 * MCP tool implementations for pre/post edit/command, route, explain, pretrain,
 * transfer, session, list, metrics, pre-task, post-task, intelligence.
 * Extracted from hooks-tools.ts.
 */

export {
  hooksPostCommand,
  hooksPostEdit,
  hooksPreCommand,
  hooksPreEdit,
} from './hooks-edit-command.js';
export { hooksIntelligence, hooksPretrain, hooksTransfer } from './hooks-learning.js';
export { hooksList, hooksMetrics } from './hooks-metrics-list.js';
export { hooksExplain, hooksRoute, hooksRouteSemantic } from './hooks-route.js';
export { hooksSessionEnd, hooksSessionRestore, hooksSessionStart } from './hooks-session.js';
export { hooksPostTask, hooksPreTask, postTaskOriginRef } from './hooks-task.js';
