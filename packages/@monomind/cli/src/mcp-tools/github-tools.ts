/**
 * GitHub MCP Tools for CLI
 *
 * Real GitHub integration via `gh` CLI and `git` commands.
 * Falls back to local state management when CLI tools are unavailable.
 */

import { githubIssueTrackTool, githubPrManageTool } from './github-tools-pr.js';
import { githubMetricsTool, githubRepoAnalyzeTool } from './github-tools-repo.js';
import { githubWorkflowTool } from './github-tools-workflow.js';
import type { MCPTool } from './types.js';

export const githubTools: MCPTool[] = [
  githubRepoAnalyzeTool,
  githubPrManageTool,
  githubIssueTrackTool,
  githubWorkflowTool,
  githubMetricsTool,
];
