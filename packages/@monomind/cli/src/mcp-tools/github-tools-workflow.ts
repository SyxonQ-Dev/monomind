/**
 * GitHub MCP Tools — GitHub Actions workflow management.
 * Extracted from github-tools.ts.
 */

import { hasGhCli, run, runSafe } from './github-tools-store.js';
import type { MCPTool } from './types.js';

export const githubWorkflowTool: MCPTool = {
  name: 'github_workflow',
  description: 'Manage GitHub Actions workflows',
  category: 'github',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'trigger', 'status', 'cancel'],
        description: 'Action to perform',
      },
      owner: { type: 'string', description: 'Repository owner' },
      repo: { type: 'string', description: 'Repository name' },
      workflowId: { type: 'string', description: 'Workflow ID or name' },
      ref: { type: 'string', description: 'Branch or tag ref' },
    },
  },
  handler: async (input) => {
    const action = (input.action as string) || 'list';
    const gh = hasGhCli();

    if (!gh) {
      return { success: false, error: 'gh CLI not available. Install: https://cli.github.com' };
    }

    if (action === 'list') {
      const raw = run(
        'gh run list --limit 10 --json databaseId,displayTitle,status,conclusion,headBranch,createdAt',
      );
      if (raw) {
        try {
          return { success: true, _real: true, runs: JSON.parse(raw) };
        } catch (e) {
          if (process.env.DEBUG || process.env.MONOMIND_DEBUG)
            console.error('[github-tools] failed to parse gh run list output:', e);
        }
      }
      const workflows = run('gh workflow list --json id,name,state');
      if (workflows) {
        try {
          return { success: true, _real: true, workflows: JSON.parse(workflows) };
        } catch (e) {
          if (process.env.DEBUG || process.env.MONOMIND_DEBUG)
            console.error('[github-tools] failed to parse gh workflow list output:', e);
        }
      }
    }

    if (action === 'status') {
      const workflowId = input.workflowId as string;
      if (workflowId) {
        const raw = runSafe('gh', [
          'run',
          'view',
          workflowId,
          '--json',
          'databaseId,displayTitle,status,conclusion,jobs',
        ]);
        if (raw) {
          try {
            return { success: true, _real: true, run: JSON.parse(raw) };
          } catch (e) {
            if (process.env.DEBUG || process.env.MONOMIND_DEBUG)
              console.error('[github-tools] failed to parse gh run view output:', e);
          }
        }
      }
      // List recent runs as fallback
      const recent = run('gh run list --limit 5 --json databaseId,displayTitle,status,conclusion');
      if (recent) {
        try {
          return { success: true, _real: true, recentRuns: JSON.parse(recent) };
        } catch (e) {
          if (process.env.DEBUG || process.env.MONOMIND_DEBUG)
            console.error('[github-tools] failed to parse gh run list (recent) output:', e);
        }
      }
    }

    if (action === 'trigger') {
      const workflowId = input.workflowId as string;
      const ref = (input.ref as string) || 'main';
      if (workflowId) {
        const result = runSafe('gh', ['workflow', 'run', workflowId, '--ref', ref]);
        if (result !== null)
          return { success: true, _real: true, action: 'triggered', workflowId, ref };
      }
      return { success: false, error: 'workflowId is required to trigger a workflow.' };
    }

    if (action === 'cancel') {
      const workflowId = input.workflowId as string;
      if (workflowId) {
        const result = runSafe('gh', ['run', 'cancel', workflowId]);
        if (result !== null)
          return { success: true, _real: true, action: 'cancelled', runId: workflowId };
      }
      return { success: false, error: 'workflowId (run ID) is required to cancel.' };
    }

    return { success: false, error: `Unknown action: ${action}` };
  },
};
