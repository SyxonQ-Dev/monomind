/**
 * Guidance task routing — task-pattern → capability-area routes and the
 * workflow templates guidance_recommend and guidance_workflow return.
 *
 * Split out of guidance-tools.ts, which registers the guidance tools in
 * `guidanceTools`.
 */

// ── Task-to-Capability Routing ──────────────────────────────

interface TaskRoute {
  pattern: RegExp;
  areas: string[];
  workflow: string;
}

const TASK_ROUTES: TaskRoute[] = [
  {
    pattern: /\b(bug|fix|debug|error|issue|crash|broken)\b/i,
    areas: ['agent-management', 'hooks-automation'],
    workflow: 'bugfix',
  },
  {
    pattern: /\b(feature|implement|create|build|add)\b/i,
    areas: ['agent-management', 'hooks-automation'],
    workflow: 'feature',
  },
  {
    pattern: /\b(refactor|restructure|reorganize|clean\s*up|modernize)\b/i,
    areas: ['agent-management', 'code-analysis'],
    workflow: 'refactor',
  },
  {
    pattern: /\b(test|coverage|tdd|spec|assert)\b/i,
    areas: ['agent-management', 'hooks-automation', 'code-analysis'],
    workflow: 'testing',
  },
  {
    pattern: /\b(security|vulnerab|cve|audit|threat|auth)\b/i,
    areas: ['security'],
    workflow: 'security',
  },
  {
    pattern: /\b(perf|benchmark|profil|slow|optimi|latency|speed)\b/i,
    areas: ['performance'],
    workflow: 'performance',
  },
  {
    pattern: /\b(memory|embed|vector|search|hnsw|semantic)\b/i,
    areas: ['memory-knowledge', 'embeddings-vectors'],
    workflow: 'memory',
  },
  {
    pattern: /\b(pr|pull\s*request|review|merge|branch)\b/i,
    areas: ['github-integration'],
    workflow: 'github-pr',
  },
  {
    pattern: /\b(release|deploy|publish|version|changelog)\b/i,
    areas: ['github-integration', 'session-workflow'],
    workflow: 'release',
  },
  {
    pattern: /\b(swarm|multi.agent|coordin|hive|consensus)\b/i,
    areas: ['agent-management'],
    workflow: 'swarm',
  },
  {
    pattern: /\b(learn|train|neural|pattern|sona|lora)\b/i,
    areas: ['intelligence-learning'],
    workflow: 'learning',
  },
  {
    pattern: /\b(hook|pre.task|post.task|worker)\b/i,
    areas: ['hooks-automation', 'session-workflow'],
    workflow: 'automation',
  },
  {
    pattern: /\b(config|setup|init|provider|doctor)\b/i,
    areas: ['config-system'],
    workflow: 'setup',
  },
];

const WORKFLOW_TEMPLATES: Record<string, { steps: string[]; agents: string[] }> = {
  bugfix: {
    steps: [
      'Research the bug (hooks route)',
      'Reproduce with tests',
      'Fix the code',
      'Verify fix passes',
      'Record outcome (hooks post-task)',
    ],
    agents: ['researcher', 'coder', 'tester'],
  },
  feature: {
    steps: [
      'Design architecture',
      'Implement solution',
      'Write tests',
      'Review code',
      'Record patterns (hooks post-task)',
    ],
    agents: ['planner', 'coder', 'tester', 'reviewer'],
  },
  refactor: {
    steps: [
      'Analyze code structure',
      'Plan refactor approach',
      'Implement changes',
      'Verify no regressions',
    ],
    agents: ['coder', 'reviewer'],
  },
  testing: {
    steps: [
      'Analyze coverage gaps',
      'Generate test plan',
      'Write tests',
      'Verify coverage improvement',
    ],
    agents: ['tester', 'coder'],
  },
  security: {
    steps: ['Run security scan', 'Triage findings', 'Fix vulnerabilities', 'Verify remediations'],
    agents: ['Security Engineer', 'coder', 'reviewer'],
  },
  performance: {
    steps: ['Run benchmarks', 'Profile bottlenecks', 'Implement optimizations', 'Re-benchmark'],
    agents: ['coder'],
  },
  memory: {
    steps: [
      'Initialize memory store',
      'Store/retrieve patterns',
      'Search with HNSW',
      'Compact and optimize',
    ],
    agents: ['monoswarm-memory-manager'],
  },
  'github-pr': {
    steps: [
      'Analyze changes',
      'Run code review swarm',
      'Check CI status',
      'Merge or request changes',
    ],
    agents: ['pr-manager', 'monoswarm-code-review', 'reviewer'],
  },
  release: {
    steps: [
      'Verify all tests pass',
      'Generate changelog',
      'Bump version',
      'Publish packages',
      'Create GitHub release',
    ],
    agents: ['release-manager', 'tester'],
  },
  swarm: {
    steps: [
      'Split the task into independent parts',
      "Spawn specialized agents with Claude Code's Task tool in one message",
      'Coordinate via memory',
      'Collect and synthesize results',
    ],
    agents: ['mesh-coordinator', 'coder', 'tester', 'reviewer'],
  },
  learning: {
    steps: [
      'Pretrain on codebase',
      'Record trajectories',
      'Compute rewards',
      'Distill learning',
      'Consolidate (EWC++)',
    ],
    agents: [],
  },
  automation: {
    steps: [
      'List available hooks/workers',
      'Configure hook handlers',
      'Dispatch workers',
      'Monitor outcomes',
    ],
    agents: [],
  },
  setup: {
    steps: ['Run doctor diagnostics', 'Configure providers', 'Initialize memory'],
    agents: [],
  },
};

export { TASK_ROUTES, WORKFLOW_TEMPLATES };
