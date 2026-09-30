/**
 * Guidance capability catalog — the static map of Monomind capability areas
 * (tools, commands, agents, skills) that guidance_capabilities and
 * guidance_recommend read.
 *
 * Split out of guidance-tools.ts, which registers the guidance tools in
 * `guidanceTools`.
 */

import { HOOKS_SUBCOMMAND_COUNT, WORKER_COUNT } from '../init/generated-counts.js';

// ── Capability Catalog ──────────────────────────────────────

export interface CapabilityArea {
  name: string;
  description: string;
  tools: string[];
  commands: string[];
  agents: string[];
  skills: string[];
  whenToUse: string;
}

export const CAPABILITY_CATALOG: Record<string, CapabilityArea> = {
  'agent-management': {
    name: 'Agent Management',
    description: 'Spawn, manage, and monitor individual AI agents with lifecycle control.',
    tools: [
      'agent_spawn',
      'agent_list',
      'agent_status',
      'agent_terminate',
      'agent_pool',
      'agent_health',
    ],
    commands: [
      'agent spawn',
      'agent list',
      'agent status',
      'agent stop',
      'agent metrics',
      'agent pool',
      'agent health',
    ],
    agents: ['coder', 'tester', 'reviewer', 'researcher', 'planner'],
    skills: [],
    whenToUse: 'When you need to create or manage individual agents for specific tasks.',
  },
  'memory-knowledge': {
    name: 'Memory & Knowledge',
    description: 'Persistent memory with ANN vector search, SQLite storage, and embeddings.',
    tools: [
      'memory_pattern-store',
      'memory_hierarchical-store',
      'memory_pattern-search',
      'memory_hierarchical-recall',
      'memory_kg_ingest',
      'memory_kg_search',
      'memory_kg_stats',
      'memory_kg_consolidate',
      'memory_kg_rollback',
      'memory_batch',
      'memory_health',
    ],
    commands: [
      'memory store',
      'memory retrieve',
      'memory search',
      'memory list',
      'memory delete',
      'memory init',
    ],
    agents: ['monoswarm-memory-manager'],
    skills: ['memory-toolkit'],
    whenToUse: 'When you need to persist, search, or retrieve knowledge across sessions.',
  },
  'intelligence-learning': {
    name: 'Intelligence & Pattern Store',
    description:
      'Local JSON pattern/trajectory store with cosine-similarity search over embeddings. No model is trained.',
    tools: [
      'hooks_intelligence',
      'hooks_intelligence_learn',
      'hooks_intelligence_pattern-store',
      'hooks_intelligence_pattern-search',
      'hooks_intelligence_stats',
    ],
    commands: [],
    agents: [],
    skills: [],
    whenToUse:
      'When recording task outcomes, storing or searching patterns, or inspecting routing stats.',
  },
  'hooks-automation': {
    name: 'Hooks & Automation',
    description: `${HOOKS_SUBCOMMAND_COUNT} hook subcommands + ${WORKER_COUNT} background workers for outcome logging, agent routing and coordination.`,
    tools: [
      'hooks_pre-task',
      'hooks_post-task',
      'hooks_pre-edit',
      'hooks_post-edit',
      'hooks_route',
      'hooks_explain',
    ],
    commands: [
      'hooks pre-task',
      'hooks post-task',
      'hooks pre-edit',
      'hooks post-edit',
      'hooks session-start',
      'hooks session-end',
      'hooks route',
      'hooks explain',
      'hooks pretrain',
      'hooks intelligence',
      'hooks worker',
      'hooks coverage-gaps',
      'hooks coverage-route',
      'hooks coverage-suggest',
      'hooks statusline',
    ],
    agents: [],
    skills: ['hooks-automation'],
    whenToUse:
      'When you need pre/post task hooks, background workers, coverage routing, or intelligence.',
  },
  security: {
    name: 'Security & Compliance',
    description:
      'Security scanning, CVE remediation, input validation, claims-based authorization.',
    tools: [
      'monofence_scan',
      'monofence_analyze',
      'monofence_is_safe',
      'monofence_has_pii',
      'monofence_stats',
      'quality_detect_secrets',
      'claims_list',
    ],
    commands: ['security scan', 'security audit', 'security cve', 'security secrets'],
    agents: ['Security Engineer'],
    skills: [],
    whenToUse: 'When auditing code for vulnerabilities, managing permissions, or security reviews.',
  },
  performance: {
    name: 'Performance & Profiling',
    description: 'Benchmarking, profiling, metrics collection, and optimization recommendations.',
    tools: [
      'performance_benchmark',
      'performance_profile',
      'performance_metrics',
      'performance_optimize',
      'performance_report',
    ],
    commands: [
      'performance benchmark',
      'performance profile',
      'performance metrics',
      'performance bottleneck',
    ],
    agents: [],
    skills: ['performance-analysis'],
    whenToUse: 'When measuring, profiling, or optimizing system performance.',
  },
  'github-integration': {
    name: 'GitHub Integration',
    description:
      'PR management, code review, issue tracking, release automation, multi-repo coordination.',
    tools: [
      'github_pr_manage',
      'github_issue_track',
      'github_repo_analyze',
      'github_workflow',
      'github_metrics',
    ],
    commands: [],
    agents: [
      'pr-manager',
      'monoswarm-code-review',
      'issue-tracker',
      'release-manager',
      'repo-architect',
      'workflow-automation',
      'monoswarm-multi-repo',
      'project-board-sync',
      'sync-coordinator',
      'github-modes',
    ],
    skills: ['github-toolkit'],
    whenToUse: 'When working with GitHub repos, PRs, issues, releases, or CI/CD pipelines.',
  },
  'session-workflow': {
    name: 'Session & Tasks',
    description: 'Session state management and task lifecycle.',
    tools: [
      'session_save',
      'session_restore',
      'session_list',
      'session_info',
      'task_create',
      'task_assign',
      'task_status',
    ],
    commands: ['session save', 'session restore', 'session list', 'task create'],
    agents: [],
    skills: [],
    whenToUse: 'When managing long-running sessions or scheduling tasks.',
  },
  'embeddings-vectors': {
    name: 'Embeddings & Vector Search',
    description:
      'Vector embeddings with sql.js, HNSW indexing, hyperbolic embeddings, ONNX integration.',
    tools: ['embeddings_generate', 'embeddings_compare', 'embeddings_search', 'embeddings_init'],
    commands: [],
    agents: [],
    // No shipped skill covers the embeddings_* tools.
    skills: [],
    whenToUse:
      'When you need semantic search, document embedding, or vector similarity operations.',
  },
  'code-analysis': {
    name: 'Code Analysis & Diff',
    description: 'AST analysis, diff classification, coverage routing, dependency graph analysis.',
    tools: ['analyze_diff', 'analyze_diff-risk', 'coverage_gaps', 'monograph_impact'],
    commands: [],
    agents: [],
    skills: ['verification-quality'],
    whenToUse: 'When analyzing code quality, diffs, coverage gaps, or dependency graphs.',
  },
  'config-system': {
    name: 'Configuration & System',
    description: 'Configuration management, provider setup, system diagnostics, shell completions.',
    tools: ['config_get', 'config_set', 'config_list', 'config_export'],
    commands: [
      'config get',
      'config set',
      'config providers',
      'doctor',
      'status',
      'providers list',
      'completions',
    ],
    agents: [],
    skills: [],
    whenToUse: 'When managing configuration, providers, or running diagnostics.',
  },
};
