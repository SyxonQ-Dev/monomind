/**
 * GitHub MCP Tools — PR management and issue tracking.
 * Extracted from github-tools.ts.
 */

import {
  hasGhCli,
  loadGitHubStore,
  run,
  runSafe,
  runSafeResult,
  safeGitHubNumber,
  saveGitHubStore,
} from './github-tools-store.js';
import type { MCPTool } from './types.js';

export const githubPrManageTool: MCPTool = {
  name: 'github_pr_manage',
  description: 'Manage pull requests',
  category: 'github',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'create', 'review', 'merge', 'close'],
        description: 'Action to perform',
      },
      owner: { type: 'string', description: 'Repository owner' },
      repo: { type: 'string', description: 'Repository name' },
      prNumber: { type: 'number', description: 'PR number' },
      title: { type: 'string', description: 'PR title' },
      branch: { type: 'string', description: 'Source branch' },
      baseBranch: { type: 'string', description: 'Target branch' },
      body: { type: 'string', description: 'PR description' },
    },
  },
  handler: async (input) => {
    const store = loadGitHubStore();
    const action = (input.action as string) || 'list';
    const gh = hasGhCli();

    if (action === 'list') {
      if (gh) {
        const raw = run(
          'gh pr list --state all --limit 20 --json number,title,state,headRefName,createdAt',
        );
        if (raw) {
          try {
            const prs = JSON.parse(raw);
            return {
              success: true,
              _real: true,
              source: 'gh-cli',
              pullRequests: prs,
              total: prs.length,
            };
          } catch (e) {
            if (process.env.DEBUG || process.env.MONOMIND_DEBUG)
              console.error('[github-tools] failed to parse gh pr list output:', e);
          }
        }
      }
      const prs = Object.values(store.prs);
      return {
        success: true,
        source: 'local-store',
        pullRequests: prs,
        total: prs.length,
        open: prs.filter((pr) => pr.status === 'open').length,
      };
    }

    if (action === 'create') {
      // Cap PR fields: title/branch/baseBranch are passed as CLI args to gh
      // (runSafe — no injection risk) and stored in the local JSON store on
      // disk; body is also stored and can be very large.
      const MAX_PR_TITLE_LEN = 256;
      const MAX_PR_BRANCH_LEN = 256;
      const MAX_PR_BODY_LEN = 64 * 1024; // 64 KB — typical PR body limit
      const rawPrTitle = (input.title as string) || 'New PR';
      const title =
        rawPrTitle.length > MAX_PR_TITLE_LEN ? rawPrTitle.slice(0, MAX_PR_TITLE_LEN) : rawPrTitle;
      const rawHeadBranch =
        (input.branch as string) || run('git rev-parse --abbrev-ref HEAD') || 'feature';
      const headBranch =
        rawHeadBranch.length > MAX_PR_BRANCH_LEN
          ? rawHeadBranch.slice(0, MAX_PR_BRANCH_LEN)
          : rawHeadBranch;
      const rawBaseBranch = (input.baseBranch as string) || 'main';
      const baseBranch =
        rawBaseBranch.length > MAX_PR_BRANCH_LEN
          ? rawBaseBranch.slice(0, MAX_PR_BRANCH_LEN)
          : rawBaseBranch;
      const rawPrBody = (input.body as string) || '';
      const body =
        rawPrBody.length > MAX_PR_BODY_LEN ? rawPrBody.slice(0, MAX_PR_BODY_LEN) : rawPrBody;
      if (gh) {
        const result = runSafe('gh', [
          'pr',
          'create',
          '--title',
          title,
          '--base',
          baseBranch,
          '--head',
          headBranch,
          '--body',
          body,
        ]);
        if (result) {
          return { success: true, _real: true, action: 'created', url: result };
        }
      }
      // Fallback: local store
      const prId = `pr-${Date.now()}`;
      // Locally-assigned PR number, independent of the timestamp-based key —
      // monotonic within this store so lookups by number are unambiguous.
      const existingNumbers = Object.values(store.prs).map((p) => p.number || 0);
      const nextNumber = existingNumbers.length > 0 ? Math.max(...existingNumbers) + 1 : 1;
      const pr = {
        id: prId,
        number: nextNumber,
        title,
        status: 'open',
        branch: headBranch,
        baseBranch,
        createdAt: new Date().toISOString(),
      };
      store.prs[prId] = pr;
      saveGitHubStore(store);
      return { success: true, source: 'local-store', action: 'created', pullRequest: pr };
    }

    if (action === 'review') {
      const prNumber = safeGitHubNumber(input.prNumber);
      if (!prNumber)
        return {
          success: false,
          error: 'prNumber is required and must be a positive integer for review.',
        };
      if (gh) {
        const raw = runSafe('gh', [
          'pr',
          'view',
          String(prNumber),
          '--json',
          'number,title,state,body,additions,deletions,changedFiles,reviews,mergeable,statusCheckRollup',
        ]);
        if (raw) {
          try {
            return { success: true, _real: true, action: 'review', pullRequest: JSON.parse(raw) };
          } catch (e) {
            if (process.env.DEBUG || process.env.MONOMIND_DEBUG)
              console.error('[github-tools] failed to parse gh pr view output:', e);
          }
        }
      }
      return {
        success: false,
        error: 'gh CLI not available or PR not found. Install gh: https://cli.github.com',
      };
    }

    if (action === 'merge') {
      const prNumber = safeGitHubNumber(input.prNumber);
      if (!prNumber)
        return {
          success: false,
          error: 'prNumber is required and must be a positive integer for merge.',
        };
      if (gh) {
        // gh CLI is actually installed — trust its real exit status. A genuine
        // failure (branch protection, conflicts, auth) must be reported as a
        // failure, not silently swallowed into the local-store simulation.
        const result = runSafeResult('gh', ['pr', 'merge', String(prNumber), '--merge']);
        if (result.ok) {
          return {
            success: true,
            _real: true,
            action: 'merged',
            prNumber,
            mergedAt: new Date().toISOString(),
          };
        }
        return { success: false, error: result.error };
      }
      // Fallback: local store (only reached when gh CLI is not installed at all)
      const prKey = Object.keys(store.prs).find((k) => store.prs[k].number === prNumber);
      if (prKey && store.prs[prKey]) {
        store.prs[prKey].status = 'merged';
        saveGitHubStore(store);
      }
      return {
        success: true,
        source: 'local-store',
        action: 'merged',
        prNumber,
        mergedAt: new Date().toISOString(),
      };
    }

    if (action === 'close') {
      const prNumber = safeGitHubNumber(input.prNumber);
      if (!prNumber)
        return {
          success: false,
          error: 'prNumber is required and must be a positive integer for close.',
        };
      if (gh) {
        const result = runSafeResult('gh', ['pr', 'close', String(prNumber)]);
        if (result.ok) {
          return {
            success: true,
            _real: true,
            action: 'closed',
            prNumber,
            closedAt: new Date().toISOString(),
          };
        }
        return { success: false, error: result.error };
      }
      // Fallback: local store (only reached when gh CLI is not installed at all)
      const prKey = Object.keys(store.prs).find((k) => store.prs[k].number === prNumber);
      if (prKey && store.prs[prKey]) {
        store.prs[prKey].status = 'closed';
        saveGitHubStore(store);
      }
      return {
        success: true,
        source: 'local-store',
        action: 'closed',
        prNumber,
        closedAt: new Date().toISOString(),
      };
    }

    return { success: false, error: 'Unknown action' };
  },
};

export const githubIssueTrackTool: MCPTool = {
  name: 'github_issue_track',
  description: 'Track and manage issues',
  category: 'github',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'create', 'update', 'close', 'assign'],
        description: 'Action to perform',
      },
      owner: { type: 'string', description: 'Repository owner' },
      repo: { type: 'string', description: 'Repository name' },
      issueNumber: { type: 'number', description: 'Issue number' },
      title: { type: 'string', description: 'Issue title' },
      body: { type: 'string', description: 'Issue body' },
      labels: { type: 'array', items: { type: 'string' }, description: 'Issue labels' },
      assignees: { type: 'array', items: { type: 'string' }, description: 'Assignees' },
    },
  },
  handler: async (input) => {
    const store = loadGitHubStore();
    const action = (input.action as string) || 'list';
    const gh = hasGhCli();

    if (action === 'list') {
      if (gh) {
        const raw = run(
          'gh issue list --state all --limit 20 --json number,title,state,labels,createdAt',
        );
        if (raw) {
          try {
            const issues = JSON.parse(raw);
            return { success: true, _real: true, source: 'gh-cli', issues, total: issues.length };
          } catch (e) {
            if (process.env.DEBUG || process.env.MONOMIND_DEBUG)
              console.error('[github-tools] failed to parse gh issue list output:', e);
          }
        }
      }
      const issues = Object.values(store.issues);
      return {
        success: true,
        source: 'local-store',
        issues,
        total: issues.length,
        open: issues.filter((i) => i.status === 'open').length,
      };
    }

    if (action === 'create') {
      // Cap issue fields: stored in local JSON store and passed as CLI args
      // to gh (runSafe — no injection risk).
      const MAX_ISSUE_TITLE_LEN = 256;
      const MAX_ISSUE_BODY_LEN = 64 * 1024;
      const MAX_ISSUE_LABELS = 20;
      const MAX_ISSUE_LABEL_LEN = 128;
      const rawIssueTitle = (input.title as string) || 'New Issue';
      const title =
        rawIssueTitle.length > MAX_ISSUE_TITLE_LEN
          ? rawIssueTitle.slice(0, MAX_ISSUE_TITLE_LEN)
          : rawIssueTitle;
      const rawIssueBody = (input.body as string) || '';
      const body =
        rawIssueBody.length > MAX_ISSUE_BODY_LEN
          ? rawIssueBody.slice(0, MAX_ISSUE_BODY_LEN)
          : rawIssueBody;
      const rawLabels = (input.labels as string[]) || [];
      const labels = Array.isArray(rawLabels)
        ? rawLabels
            .slice(0, MAX_ISSUE_LABELS)
            .map((l) =>
              typeof l === 'string' && l.length > MAX_ISSUE_LABEL_LEN
                ? l.slice(0, MAX_ISSUE_LABEL_LEN)
                : l,
            )
        : [];
      if (gh) {
        const issueArgs = ['issue', 'create', '--title', title, '--body', body];
        if (labels.length > 0) issueArgs.push('--label', labels.join(','));
        const result = runSafe('gh', issueArgs);
        if (result) {
          return { success: true, _real: true, action: 'created', url: result };
        }
      }
      const issueId = `issue-${Date.now()}`;
      const issue = {
        id: issueId,
        title,
        status: 'open',
        labels,
        createdAt: new Date().toISOString(),
      };
      store.issues[issueId] = issue;
      saveGitHubStore(store);
      return { success: true, source: 'local-store', action: 'created', issue };
    }

    if (action === 'update') {
      const issueNumber = input.issueNumber as number;
      if (gh && issueNumber) {
        const editArgs = ['issue', 'edit', String(issueNumber)];
        // Cap title and labels to prevent inflating args and local store
        const MAX_UPDATE_TITLE_LEN = 256;
        if (input.title) {
          const t = input.title as string;
          editArgs.push(
            '--title',
            t.length > MAX_UPDATE_TITLE_LEN ? t.slice(0, MAX_UPDATE_TITLE_LEN) : t,
          );
        }
        if (input.labels) editArgs.push('--add-label', (input.labels as string[]).join(','));
        if (editArgs.length > 3) {
          const result = runSafe('gh', editArgs);
          if (result !== null)
            return { success: true, _real: true, action: 'updated', issueNumber };
        }
      }
      const issueKey = Object.keys(store.issues).find((k) => k.includes(String(issueNumber)));
      if (issueKey && store.issues[issueKey]) {
        if (input.title) {
          const t = input.title as string;
          store.issues[issueKey].title = t.length > 256 ? t.slice(0, 256) : t;
        }
        if (input.labels) store.issues[issueKey].labels = input.labels as string[];
        saveGitHubStore(store);
      }
      return { success: true, source: 'local-store', action: 'updated', issueNumber };
    }

    if (action === 'close') {
      const issueNumber = safeGitHubNumber(input.issueNumber);
      if (!issueNumber)
        return {
          success: false,
          error: 'issueNumber is required and must be a positive integer for close.',
        };
      if (gh) {
        const result = runSafe('gh', ['issue', 'close', String(issueNumber)]);
        if (result !== null)
          return {
            success: true,
            _real: true,
            action: 'closed',
            issueNumber,
            closedAt: new Date().toISOString(),
          };
      }
      const issueKey = Object.keys(store.issues).find((k) => k.includes(String(issueNumber)));
      if (issueKey && store.issues[issueKey]) {
        store.issues[issueKey].status = 'closed';
        saveGitHubStore(store);
      }
      return {
        success: true,
        source: 'local-store',
        action: 'closed',
        issueNumber,
        closedAt: new Date().toISOString(),
      };
    }

    return { success: false, error: 'Unknown action' };
  },
};
