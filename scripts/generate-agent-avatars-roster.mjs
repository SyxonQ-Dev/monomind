/**
 * Split out of generate-agent-avatars.mjs (file-size sweep). Pure move: no
 * behaviour change.
 */

// ─── Agent definitions ────────────────────────────────────────────────────────
// Each: { id, label, category, skinI, hairStyleI, hairColorI, eyeStyleI, eyeColorI, accessory, icon }
// Index values are seeded deterministically per agent.

const AGENTS = [
  // ── Core Development ──────────────────────────────────────────────────────
  { id: 'coder', label: 'Coder', cat: 'core', icon: '💻', acc: 'glasses' },
  { id: 'senior-developer', label: 'Senior Developer', cat: 'core', icon: '⚡', acc: 'glasses' },
  { id: 'reviewer', label: 'Code Reviewer', cat: 'core', icon: '🔍', acc: 'none' },
  { id: 'tester', label: 'Tester', cat: 'core', icon: '🧪', acc: 'none' },
  { id: 'planner', label: 'Planner', cat: 'core', icon: '📋', acc: 'none' },
  { id: 'researcher', label: 'Researcher', cat: 'core', icon: '📚', acc: 'glasses' },
  // ── Security ──────────────────────────────────────────────────────────────
  {
    id: 'security-architect',
    label: 'Security Architect',
    cat: 'security',
    icon: '🛡️',
    acc: 'none',
  },
  {
    id: 'security-auditor',
    label: 'Security Auditor',
    cat: 'security',
    icon: '🔒',
    acc: 'headband',
  },
  { id: 'threat-detection', label: 'Threat Detection', cat: 'security', icon: '⚠️', acc: 'goggles' },
  { id: 'input-validator', label: 'Input Validator', cat: 'security', icon: '✅', acc: 'none' },
  { id: 'path-validator', label: 'Path Validator', cat: 'security', icon: '🗂️', acc: 'none' },
  { id: 'safe-executor', label: 'Safe Executor', cat: 'security', icon: '🔐', acc: 'none' },
  // ── Swarm ─────────────────────────────────────────────────────────────────
  { id: 'hierarchical-coord', label: 'Hierarchical Coord.', cat: 'swarm', icon: '🏛️', acc: 'crown' },
  { id: 'mesh-coordinator', label: 'Mesh Coordinator', cat: 'swarm', icon: '🕸️', acc: 'headset' },
  {
    id: 'adaptive-coordinator',
    label: 'Adaptive Coordinator',
    cat: 'swarm',
    icon: '🔄',
    acc: 'none',
  },
  { id: 'collective-coord', label: 'Collective Intel.', cat: 'swarm', icon: '🧠', acc: 'none' },
  { id: 'queen-coordinator', label: 'Queen Coordinator', cat: 'swarm', icon: '👑', acc: 'crown' },
  { id: 'worker-specialist', label: 'Worker Specialist', cat: 'swarm', icon: '⚙️', acc: 'none' },
  // ── Consensus ─────────────────────────────────────────────────────────────
  { id: 'byzantine-coord', label: 'Byzantine Coord.', cat: 'consensus', icon: '⚖️', acc: 'none' },
  { id: 'raft-manager', label: 'Raft Manager', cat: 'consensus', icon: '🚣', acc: 'none' },
  { id: 'quorum-manager', label: 'Quorum Manager', cat: 'consensus', icon: '🗳️', acc: 'none' },
  {
    id: 'consensus-coordinator',
    label: 'Consensus Coord.',
    cat: 'consensus',
    icon: '🤝',
    acc: 'none',
  },
  // ── Performance ──────────────────────────────────────────────────────────
  { id: 'perf-analyzer', label: 'Perf Analyzer', cat: 'perf', icon: '📊', acc: 'goggles' },
  { id: 'benchmarker', label: 'Benchmarker', cat: 'perf', icon: '⏱️', acc: 'none' },
  { id: 'task-orchestrator', label: 'Task Orchestrator', cat: 'perf', icon: '🎯', acc: 'headset' },
  { id: 'memory-coordinator', label: 'Memory Coordinator', cat: 'perf', icon: '🧮', acc: 'none' },
  { id: 'load-balancer', label: 'Load Balancer', cat: 'perf', icon: '⚖️', acc: 'none' },
  { id: 'resource-allocator', label: 'Resource Allocator', cat: 'perf', icon: '📦', acc: 'none' },
  // ── GitHub / Repository ───────────────────────────────────────────────────
  { id: 'pr-manager', label: 'PR Manager', cat: 'github', icon: '🔀', acc: 'none' },
  { id: 'code-review-swarm', label: 'Code Review Swarm', cat: 'github', icon: '👁️', acc: 'glasses' },
  { id: 'issue-tracker', label: 'Issue Tracker', cat: 'github', icon: '🐛', acc: 'none' },
  { id: 'release-manager', label: 'Release Manager', cat: 'github', icon: '🚀', acc: 'none' },
  { id: 'repo-architect', label: 'Repo Architect', cat: 'github', icon: '🏗️', acc: 'none' },
  {
    id: 'workflow-automation',
    label: 'Workflow Automation',
    cat: 'github',
    icon: '⚡',
    acc: 'none',
  },
  // ── Specialized Dev ───────────────────────────────────────────────────────
  { id: 'backend-dev', label: 'Backend Dev', cat: 'core', icon: '🗄️', acc: 'none' },
  {
    id: 'frontend-developer',
    label: 'Frontend Developer',
    cat: 'frontend',
    icon: '🎨',
    acc: 'none',
  },
  { id: 'mobile-dev', label: 'Mobile Developer', cat: 'frontend', icon: '📱', acc: 'none' },
  { id: 'ml-developer', label: 'ML Developer', cat: 'ai', icon: '🤖', acc: 'goggles' },
  { id: 'cicd-engineer', label: 'CI/CD Engineer', cat: 'devops', icon: '🔄', acc: 'none' },
  { id: 'system-architect', label: 'System Architect', cat: 'core', icon: '🏛️', acc: 'none' },
  // ── AI / Data ─────────────────────────────────────────────────────────────
  { id: 'ai-engineer', label: 'AI Engineer', cat: 'ai', icon: '🧠', acc: 'goggles' },
  { id: 'model-qa', label: 'Model QA Specialist', cat: 'ai', icon: '🔬', acc: 'glasses' },
  { id: 'data-engineer', label: 'Data Engineer', cat: 'data', icon: '🗃️', acc: 'none' },
  { id: 'analytics-reporter', label: 'Analytics Reporter', cat: 'data', icon: '📈', acc: 'none' },
  { id: 'experiment-tracker', label: 'Experiment Tracker', cat: 'ai', icon: '🧫', acc: 'none' },
  { id: 'data-consolidator', label: 'Data Consolidator', cat: 'data', icon: '🔧', acc: 'none' },
  // ── DevOps / Infra ────────────────────────────────────────────────────────
  { id: 'devops-automator', label: 'DevOps Automator', cat: 'devops', icon: '⚙️', acc: 'headset' },
  { id: 'sre', label: 'SRE', cat: 'devops', icon: '🔭', acc: 'none' },
  {
    id: 'incident-commander',
    label: 'Incident Commander',
    cat: 'devops',
    icon: '🚨',
    acc: 'headset',
  },
  { id: 'infrastructure', label: 'Infrastructure', cat: 'infra', icon: '🏗️', acc: 'none' },
  {
    id: 'database-optimizer',
    label: 'Database Optimizer',
    cat: 'infra',
    icon: '🗄️',
    acc: 'glasses',
  },
  { id: 'cloud-architect', label: 'Cloud Architect', cat: 'infra', icon: '☁️', acc: 'none' },
  // ── Legal / Trial ─────────────────────────────────────────────────────────
  { id: 'prosecutor', label: 'Prosecutor', cat: 'legal', icon: '⚡', acc: 'none' },
  { id: 'defender', label: 'Defender', cat: 'legal', icon: '🛡️', acc: 'none' },
  { id: 'judge', label: 'Judge', cat: 'legal', icon: '⚖️', acc: 'crown' },
  { id: 'case-analyst', label: 'Case Analyst', cat: 'legal', icon: '📂', acc: 'glasses' },
  { id: 'trial-director', label: 'Trial Director', cat: 'legal', icon: '🎬', acc: 'crown' },
  { id: 'legal-compliance', label: 'Legal Compliance', cat: 'legal', icon: '📜', acc: 'none' },
  // ── Content / Marketing ───────────────────────────────────────────────────
  { id: 'technical-writer', label: 'Technical Writer', cat: 'content', icon: '✍️', acc: 'glasses' },
  { id: 'content-creator', label: 'Content Creator', cat: 'content', icon: '🎭', acc: 'none' },
  { id: 'seo-specialist', label: 'SEO Specialist', cat: 'content', icon: '🔎', acc: 'none' },
  { id: 'social-media', label: 'Social Media', cat: 'content', icon: '📣', acc: 'none' },
  { id: 'email-marketing', label: 'Email Marketing', cat: 'content', icon: '📧', acc: 'none' },
  { id: 'ai-citation', label: 'AI Citation', cat: 'content', icon: '🔗', acc: 'glasses' },
  // ── Product ───────────────────────────────────────────────────────────────
  { id: 'product-manager', label: 'Product Manager', cat: 'product', icon: '🗺️', acc: 'none' },
  {
    id: 'sprint-prioritizer',
    label: 'Sprint Prioritizer',
    cat: 'product',
    icon: '🎯',
    acc: 'none',
  },
  { id: 'launch-strategist', label: 'Launch Strategist', cat: 'product', icon: '🚀', acc: 'none' },
  {
    id: 'pricing-strategist',
    label: 'Pricing Strategist',
    cat: 'product',
    icon: '💰',
    acc: 'none',
  },
  {
    id: 'feedback-synthesizer',
    label: 'Feedback Synthesizer',
    cat: 'product',
    icon: '📥',
    acc: 'none',
  },
  { id: 'cro-specialist', label: 'CRO Specialist', cat: 'product', icon: '📊', acc: 'glasses' },
  // ── Sales ─────────────────────────────────────────────────────────────────
  { id: 'sales-engineer', label: 'Sales Engineer', cat: 'sales', icon: '🤝', acc: 'badge' },
  { id: 'deal-strategist', label: 'Deal Strategist', cat: 'sales', icon: '♟️', acc: 'none' },
  { id: 'account-strategist', label: 'Account Strategist', cat: 'sales', icon: '📊', acc: 'badge' },
  {
    id: 'outbound-strategist',
    label: 'Outbound Strategist',
    cat: 'sales',
    icon: '📡',
    acc: 'headset',
  },
  { id: 'pipeline-analyst', label: 'Pipeline Analyst', cat: 'sales', icon: '📉', acc: 'none' },
  { id: 'sales-coach', label: 'Sales Coach', cat: 'sales', icon: '🏋️', acc: 'none' },
  // ── Support / Success ─────────────────────────────────────────────────────
  {
    id: 'support-responder',
    label: 'Support Responder',
    cat: 'content',
    icon: '💬',
    acc: 'headset',
  },
  { id: 'discovery-coach', label: 'Discovery Coach', cat: 'sales', icon: '🔭', acc: 'none' },
  {
    id: 'proposal-strategist',
    label: 'Proposal Strategist',
    cat: 'sales',
    icon: '📋',
    acc: 'none',
  },
  // ── Creative / Game ───────────────────────────────────────────────────────
  { id: 'game-designer', label: 'Game Designer', cat: 'creative', icon: '🎮', acc: 'none' },
  {
    id: 'narrative-designer',
    label: 'Narrative Designer',
    cat: 'creative',
    icon: '📖',
    acc: 'none',
  },
  { id: 'level-designer', label: 'Level Designer', cat: 'creative', icon: '🗺️', acc: 'none' },
  {
    id: 'game-audio-engineer',
    label: 'Game Audio Engineer',
    cat: 'creative',
    icon: '🎵',
    acc: 'headset',
  },
  { id: 'technical-artist', label: 'Technical Artist', cat: 'creative', icon: '🎨', acc: 'none' },
  { id: 'unity-architect', label: 'Unity Architect', cat: 'creative', icon: '🕹️', acc: 'none' },
  // ── Blockchain ────────────────────────────────────────────────────────────
  {
    id: 'blockchain-auditor',
    label: 'Blockchain Auditor',
    cat: 'blockchain',
    icon: '⛓️',
    acc: 'none',
  },
  {
    id: 'solidity-engineer',
    label: 'Solidity Engineer',
    cat: 'blockchain',
    icon: '💎',
    acc: 'glasses',
  },
  { id: 'zk-steward', label: 'ZK Steward', cat: 'blockchain', icon: '🔏', acc: 'none' },
  // ── Management ────────────────────────────────────────────────────────────
  { id: 'studio-producer', label: 'Studio Producer', cat: 'management', icon: '🎬', acc: 'crown' },
  { id: 'project-shepherd', label: 'Project Shepherd', cat: 'management', icon: '🐑', acc: 'none' },
  { id: 'senior-pm', label: 'Senior PM', cat: 'management', icon: '📌', acc: 'none' },
  {
    id: 'studio-operations',
    label: 'Studio Operations',
    cat: 'management',
    icon: '🏢',
    acc: 'none',
  },
  {
    id: 'workflow-architect',
    label: 'Workflow Architect',
    cat: 'management',
    icon: '🌐',
    acc: 'none',
  },
  {
    id: 'adaptive-coordinator2',
    label: 'Adaptive Coord. II',
    cat: 'management',
    icon: '♻️',
    acc: 'headband',
  },
  // ── Testing / QA ─────────────────────────────────────────────────────────
  { id: 'api-tester', label: 'API Tester', cat: 'testing', icon: '🔌', acc: 'none' },
  {
    id: 'evidence-collector',
    label: 'Evidence Collector',
    cat: 'testing',
    icon: '📸',
    acc: 'goggles',
  },
  { id: 'reality-checker', label: 'Reality Checker', cat: 'testing', icon: '🔍', acc: 'glasses' },
  {
    id: 'production-validator',
    label: 'Production Validator',
    cat: 'testing',
    icon: '✅',
    acc: 'none',
  },
  // ── Finance / HR ──────────────────────────────────────────────────────────
  { id: 'finance-tracker', label: 'Finance Tracker', cat: 'sales', icon: '💹', acc: 'none' },
  { id: 'accounts-payable', label: 'Accounts Payable', cat: 'sales', icon: '💳', acc: 'none' },
  { id: 'recruitment', label: 'Recruitment', cat: 'management', icon: '🎯', acc: 'none' },
  // ── Emerging Tech ─────────────────────────────────────────────────────────
  {
    id: 'visionos-engineer',
    label: 'visionOS Engineer',
    cat: 'frontend',
    icon: '👓',
    acc: 'goggles',
  },
  { id: 'embedded-firmware', label: 'Embedded Firmware', cat: 'infra', icon: '🔌', acc: 'goggles' },
  { id: 'ios-developer', label: 'iOS Developer', cat: 'frontend', icon: '📱', acc: 'none' },
  {
    id: 'mobile-app-builder',
    label: 'Mobile App Builder',
    cat: 'frontend',
    icon: '🏗️',
    acc: 'none',
  },
  { id: 'mcp-builder', label: 'MCP Builder', cat: 'core', icon: '🔧', acc: 'none' },
  {
    id: 'automation-governance',
    label: 'Automation Governance',
    cat: 'devops',
    icon: '🏛️',
    acc: 'none',
  },
  { id: 'payment-agent', label: 'Payment Agent', cat: 'blockchain', icon: '💸', acc: 'none' },
  {
    id: 'compliance-auditor',
    label: 'Compliance Auditor',
    cat: 'security',
    icon: '📋',
    acc: 'glasses',
  },
  { id: 'trend-researcher', label: 'Trend Researcher', cat: 'ai', icon: '📡', acc: 'none' },
  { id: 'scout-explorer', label: 'Scout Explorer', cat: 'swarm', icon: '🧭', acc: 'visor' },
];

// Pad or trim to exactly 120
while (AGENTS.length < 120) {
  const a = AGENTS[AGENTS.length % AGENTS.length];
  AGENTS.push({ ...a, id: `${a.id}-v${AGENTS.length}`, label: `${a.label} II` });
}
export const AGENTS120 = AGENTS.slice(0, 120);
