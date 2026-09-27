/**
 * Guidance capability catalog — the static map of Monomind capability areas
 * (tools, commands, agents, skills) that guidance_capabilities and
 * guidance_recommend read.
 *
 * Split out of guidance-tools.ts, which registers the guidance tools in
 * `guidanceTools`.
 */

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
      'agent_stop',
      'agent_metrics',
      'agent_pool',
      'agent_health',
      'agent_logs',
    ],
    commands: [
      'agent spawn',
      'agent list',
      'agent status',
      'agent stop',
      'agent metrics',
      'agent pool',
      'agent health',
      'agent logs',
    ],
    agents: ['coder', 'tester', 'reviewer', 'researcher', 'planner'],
    skills: [],
    whenToUse: 'When you need to create or manage individual agents for specific tasks.',
  },
  monoswarm: {
    name: 'Monoswarm Coordination',
    description:
      'Multi-agent coordination and vote arbitration: topology/roster bookkeeping in a JSON state file, threshold-based voting (majority/supermajority/unanimous/threshold).',
    tools: [
      'monoswarm_init',
      'monoswarm_status',
      'monoswarm_scale',
      'monoswarm_health',
      'monoswarm_shutdown',
      'monoswarm_agent_add',
      'monoswarm_vote',
    ],
    commands: ['monoswarm init', 'monoswarm status', 'monoswarm scale', 'monoswarm stop'],
    agents: [
      'coordinator',
      'mesh-coordinator',
      'collective-intelligence-coordinator',
      'quorum-manager',
    ],
    skills: ['monoswarm'],
    whenToUse:
      'When a task requires multiple agents working together (3+ files, features, refactoring), or agents need to vote on a decision.',
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
    skills: ['memory-advanced', 'memory-vector-search', 'memory-patterns', 'memory-learning'],
    whenToUse: 'When you need to persist, search, or retrieve knowledge across sessions.',
  },
  'intelligence-learning': {
    name: 'Intelligence & Learning',
    description:
      'Pattern storage and cosine-similarity search (SONA/ReasoningBank) backed by real embeddings.',
    tools: [
      'neural_train',
      'neural_predict',
      'neural_status',
      'neural_patterns',
      'neural_optimize',
    ],
    commands: [],
    agents: [],
    skills: ['reasoningbank-intelligence', 'memory-reasoningbank'],
    whenToUse:
      'When optimizing agent routing, training patterns from outcomes, or adaptive learning.',
  },
  'hooks-automation': {
    name: 'Hooks & Automation',
    description:
      '17 lifecycle hooks + 12 background workers for automated learning and coordination.',
    tools: [
      'hooks_pre_task',
      'hooks_post_task',
      'hooks_pre_edit',
      'hooks_post_edit',
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
      'hooks progress',
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
      'security_scan',
      'security_audit',
      'security_cve',
      'security_threats',
      'security_validate',
      'security_report',
      'claims_check',
      'claims_grant',
      'claims_revoke',
      'claims_list',
    ],
    commands: [
      'security scan',
      'security audit',
      'security cve',
      'security threats',
      'claims check',
      'claims grant',
    ],
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
      'performance optimize',
      'performance report',
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
      'github_code_review',
      'github_issue_track',
      'github_repo_analyze',
      'github_sync_coord',
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
    skills: [
      'github-release-management',
      'github-workflow-automation',
      'github-code-review',
      'github-project-management',
      'github-multi-repo',
    ],
    whenToUse: 'When working with GitHub repos, PRs, issues, releases, or CI/CD pipelines.',
  },
  'session-workflow': {
    name: 'Session & Tasks',
    description: 'Session state management and task lifecycle.',
    tools: [
      'session_start',
      'session_end',
      'session_restore',
      'session_list',
      'task_create',
      'task_assign',
      'task_status',
    ],
    commands: ['session start', 'session end', 'session restore', 'task create'],
    agents: [],
    skills: [],
    whenToUse: 'When managing long-running sessions or scheduling tasks.',
  },
  'embeddings-vectors': {
    name: 'Embeddings & Vector Search',
    description:
      'Vector embeddings with sql.js, HNSW indexing, hyperbolic embeddings, ONNX integration.',
    tools: ['embeddings_embed', 'embeddings_batch', 'embeddings_search', 'embeddings_init'],
    commands: ['embeddings embed', 'embeddings batch', 'embeddings search', 'embeddings init'],
    agents: [],
    skills: ['memory-vector-search', 'memory-optimization'],
    whenToUse:
      'When you need semantic search, document embedding, or vector similarity operations.',
  },
  'code-analysis': {
    name: 'Code Analysis & Diff',
    description: 'AST analysis, diff classification, coverage routing, dependency graph analysis.',
    tools: ['analyze_diff', 'analyze_coverage', 'analyze_graph'],
    commands: [],
    agents: [],
    skills: ['verification-quality'],
    whenToUse: 'When analyzing code quality, diffs, coverage gaps, or dependency graphs.',
  },
  'config-system': {
    name: 'Configuration & System',
    description: 'Configuration management, provider setup, system diagnostics, shell completions.',
    tools: ['config_get', 'config_set', 'config_list', 'config_provider'],
    commands: [
      'config get',
      'config set',
      'config list',
      'config provider',
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
