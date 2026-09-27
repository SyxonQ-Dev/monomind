/**
 * GitHub MCP Tools — repo analyze and metrics.
 * Extracted from github-tools.ts.
 */

import {
  hasGhCli,
  loadGitHubStore,
  type RepoInfo,
  run,
  saveGitHubStore,
} from './github-tools-store.js';
import { getProjectCwd, type MCPTool } from './types.js';

export const githubRepoAnalyzeTool: MCPTool = {
  name: 'github_repo_analyze',
  description: 'Analyze a GitHub repository',
  category: 'github',
  inputSchema: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner' },
      repo: { type: 'string', description: 'Repository name' },
      branch: { type: 'string', description: 'Branch to analyze' },
      deep: { type: 'boolean', description: 'Deep analysis' },
    },
  },
  handler: async (input) => {
    const store = loadGitHubStore();
    const branch = (input.branch as string) || 'main';
    const cwd = getProjectCwd();

    // Try real git analysis first
    const commitCount = run('git rev-list --count HEAD', cwd);
    const branchCount = run('git branch -a --no-color | wc -l', cwd);
    const contributors = run('git shortlog -sn --no-merges HEAD | wc -l', cwd);
    const currentBranch = run('git rev-parse --abbrev-ref HEAD', cwd);
    const remoteUrl = run('git remote get-url origin', cwd);

    // Parse owner/repo from remote URL
    let owner = (input.owner as string) || '';
    let repo = (input.repo as string) || '';
    if (remoteUrl && (!owner || !repo)) {
      const m = remoteUrl.match(/[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/);
      if (m) {
        owner = owner || m[1];
        repo = repo || m[2];
      }
    }
    const repoKey = `${owner || 'local'}/${repo || 'repo'}`;

    if (commitCount !== null) {
      // Real git data available
      const repoInfo: RepoInfo = {
        owner: owner || 'local',
        name: repo || 'repo',
        branch: currentBranch || branch,
        lastAnalyzed: new Date().toISOString(),
        metrics: {
          commits: parseInt(commitCount, 10) || 0,
          branches: parseInt(branchCount || '0', 10) || 0,
          contributors: parseInt(contributors || '0', 10) || 0,
          openIssues: 0,
          openPRs: 0,
        },
      };

      // Try gh CLI for issue/PR counts
      if (hasGhCli()) {
        const issueCount = run(
          `gh issue list --state open --limit 1000 --json number --jq 'length'`,
        );
        const prCount = run(`gh pr list --state open --limit 1000 --json number --jq 'length'`);
        if (issueCount !== null) repoInfo.metrics!.openIssues = parseInt(issueCount, 10) || 0;
        if (prCount !== null) repoInfo.metrics!.openPRs = parseInt(prCount, 10) || 0;
      }

      store.repos[repoKey] = repoInfo;
      saveGitHubStore(store);

      return {
        success: true,
        _real: true,
        repository: repoKey,
        branch: repoInfo.branch,
        metrics: repoInfo.metrics,
        remoteUrl: remoteUrl || null,
        lastAnalyzed: repoInfo.lastAnalyzed,
      };
    }

    // No git — return local store data
    return {
      success: false,
      error: 'Not a git repository or git not available.',
      localData: { storedRepos: Object.keys(store.repos) },
    };
  },
};

export const githubMetricsTool: MCPTool = {
  name: 'github_metrics',
  description: 'Get repository metrics and statistics',
  category: 'github',
  inputSchema: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner' },
      repo: { type: 'string', description: 'Repository name' },
      metric: {
        type: 'string',
        enum: ['all', 'commits', 'contributors', 'traffic', 'releases'],
        description: 'Metric type',
      },
      timeRange: { type: 'string', description: 'Time range (e.g., "7d", "30d", "90d")' },
    },
  },
  handler: async (input) => {
    const metric = (input.metric as string) || 'all';
    const timeRange = (input.timeRange as string) || '30d';
    const cwd = getProjectCwd();

    // Parse time range
    const days = parseInt(timeRange, 10) || 30;
    const since = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];

    const result: Record<string, unknown> = { _real: true, timeRange: `${days}d`, since };

    const wantAll = metric === 'all';

    if (wantAll || metric === 'commits') {
      const total = run(`git rev-list --count HEAD`, cwd);
      const recent = run(`git rev-list --count --since="${since}" HEAD`, cwd);
      result.commits = {
        total: parseInt(total || '0', 10),
        sincePeriod: parseInt(recent || '0', 10),
      };
    }

    if (wantAll || metric === 'contributors') {
      const allContrib = run('git shortlog -sn --no-merges HEAD', cwd);
      if (allContrib) {
        const lines = allContrib.split('\n').filter(Boolean);
        result.contributors = {
          total: lines.length,
          top: lines
            .slice(0, 10)
            .map((l) => {
              const m = l.trim().match(/^(\d+)\t(.+)$/);
              return m ? { commits: parseInt(m[1], 10), name: m[2].trim() } : null;
            })
            .filter(Boolean),
        };
      }
    }

    if (wantAll || metric === 'releases') {
      if (hasGhCli()) {
        const raw = run('gh release list --limit 10 --json tagName,name,publishedAt,isPrerelease');
        if (raw) {
          try {
            result.releases = JSON.parse(raw);
          } catch (e) {
            if (process.env.DEBUG || process.env.MONOMIND_DEBUG)
              console.error('[github-tools] failed to parse gh release list output:', e);
          }
        }
      }
      if (!result.releases) {
        const tags = run('git tag --sort=-creatordate | head -10', cwd);
        result.releases = tags
          ? tags
              .split('\n')
              .filter(Boolean)
              .map((t) => ({ tagName: t }))
          : [];
      }
    }

    // Always include branch info
    const branchCount = run('git branch -a --no-color | wc -l', cwd);
    const currentBranch = run('git rev-parse --abbrev-ref HEAD', cwd);
    result.branches = { total: parseInt(branchCount || '0', 10), current: currentBranch };

    return { success: true, ...result };
  },
};
