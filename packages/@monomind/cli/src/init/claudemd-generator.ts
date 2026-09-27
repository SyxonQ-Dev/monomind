/**
 * CLAUDE.md Generator
 * Generates enforceable, analyzer-optimized Claude Code configuration
 * with template variants for different usage patterns.
 *
 * Templates: minimal | standard | full | security | performance | solo
 * All templates use bullet-format rules with imperative keywords for enforceability.
 */

import { _resetOptionalPackageCache } from './claudemd-detect.js';
import {
  antiDriftConfig,
  autoStartProtocol,
  behavioralRules,
  codingPrinciples,
  concurrencyRules,
  executionRules,
  fileOrganization,
  HONEST_MONOSWARM_SENTENCE,
  projectArchitecture,
  swarmOrchestration,
  swarmRules,
} from './claudemd-sections-core.js';
import {
  agentPicking,
  agentTypes,
  buildAndTest,
  cliCommandsTable,
  hooksSystem,
  intelligenceSystem,
  learningProtocol,
  memoryCommands,
  monographSection,
  performanceSection,
  secondBrainSection,
  securityRulesLight,
  securitySection,
  setupAndBoundary,
} from './claudemd-sections-reference.js';
import type { ClaudeMdTemplate, InitOptions } from './types.js';

export { _resetOptionalPackageCache, HONEST_MONOSWARM_SENTENCE };

// i-041/i-117 §4: MONOMIND_MEMORY_BACKEND and MONOMIND_MEMORY_PATH had no
// `process.env` reader anywhere in the repo (grepped — see claudemd-truth.test.ts
// and the developer report for the exact commands run). MONOMIND_CONFIG
// (services/config-file-manager.ts) and MONOMIND_LOG_LEVEL
// (mcp-tools/monoswarm-tools.ts) do; ANTHROPIC_API_KEY is read by the SDK,
// not by us. Keep only vars with a real reader — a var nobody reads is the
// same class of lie as a wrong count.
function envVars(): string {
  return `## Environment Variables

\`\`\`bash
MONOMIND_CONFIG=./monomind.config.json
MONOMIND_LOG_LEVEL=info
ANTHROPIC_API_KEY=sk-ant-...
\`\`\``;
}

// --- Template Composers ---

/**
 * Template section map — defines which sections are included per template.
 */
const TEMPLATE_SECTIONS: Record<ClaudeMdTemplate, Array<(opts: InitOptions) => string>> = {
  minimal: [
    behavioralRules,
    (_opts) => codingPrinciples(),
    fileOrganization,
    projectArchitecture,
    buildAndTest,
    (_opts) => securityRulesLight(),
    concurrencyRules,
    (_opts) => agentPicking(),
    (_opts) => secondBrainSection(),
    (_opts) => monographSection(),
    (_opts) => setupAndBoundary(),
  ],
  standard: [
    behavioralRules,
    (_opts) => codingPrinciples(),
    fileOrganization,
    projectArchitecture,
    buildAndTest,
    (_opts) => securityRulesLight(),
    concurrencyRules,
    (_opts) => agentPicking(),
    (_opts) => swarmRules(),
    (_opts) => cliCommandsTable(),
    (_opts) => agentTypes(),
    (_opts) => memoryCommands(),
    (_opts) => secondBrainSection(),
    (_opts) => monographSection(),
    (_opts) => setupAndBoundary(),
  ],
  full: [
    behavioralRules,
    (_opts) => codingPrinciples(),
    fileOrganization,
    projectArchitecture,
    buildAndTest,
    (_opts) => securityRulesLight(),
    concurrencyRules,
    (_opts) => agentPicking(),
    (_opts) => swarmOrchestration(),
    (_opts) => antiDriftConfig(),
    (_opts) => autoStartProtocol(),
    executionRules,
    (_opts) => cliCommandsTable(),
    (_opts) => agentTypes(),
    (_opts) => hooksSystem(),
    (_opts) => learningProtocol(),
    (_opts) => memoryCommands(),
    (_opts) => secondBrainSection(),
    (_opts) => monographSection(),
    (_opts) => intelligenceSystem(),
    (_opts) => envVars(),
    (_opts) => setupAndBoundary(),
  ],
  security: [
    behavioralRules,
    (_opts) => codingPrinciples(),
    fileOrganization,
    projectArchitecture,
    buildAndTest,
    concurrencyRules,
    (_opts) => agentPicking(),
    (_opts) => swarmOrchestration(),
    (_opts) => antiDriftConfig(),
    executionRules,
    (_opts) => securitySection(),
    (_opts) => cliCommandsTable(),
    (_opts) => agentTypes(),
    (_opts) => memoryCommands(),
    (_opts) => secondBrainSection(),
    (_opts) => monographSection(),
    (_opts) => setupAndBoundary(),
  ],
  performance: [
    behavioralRules,
    (_opts) => codingPrinciples(),
    fileOrganization,
    projectArchitecture,
    buildAndTest,
    (_opts) => securityRulesLight(),
    concurrencyRules,
    (_opts) => agentPicking(),
    (_opts) => swarmOrchestration(),
    (_opts) => antiDriftConfig(),
    executionRules,
    (_opts) => performanceSection(),
    (_opts) => cliCommandsTable(),
    (_opts) => agentTypes(),
    (_opts) => memoryCommands(),
    (_opts) => secondBrainSection(),
    (_opts) => monographSection(),
    (_opts) => intelligenceSystem(),
    (_opts) => setupAndBoundary(),
  ],
  solo: [
    behavioralRules,
    (_opts) => codingPrinciples(),
    fileOrganization,
    projectArchitecture,
    buildAndTest,
    (_opts) => securityRulesLight(),
    concurrencyRules,
    (_opts) => agentPicking(),
    executionRules,
    (_opts) => cliCommandsTable(),
    (_opts) => memoryCommands(),
    (_opts) => setupAndBoundary(),
  ],
};

// --- Public API ---

/**
 * Generate CLAUDE.md content based on init options and template.
 * Template is determined by: options.runtime.claudeMdTemplate > explicit param > 'standard'
 */
export function generateClaudeMd(options: InitOptions, template?: ClaudeMdTemplate): string {
  const tmpl = template ?? options.runtime.claudeMdTemplate ?? 'standard';
  const sections = TEMPLATE_SECTIONS[tmpl] ?? TEMPLATE_SECTIONS.standard;

  const header = `# Claude Code Configuration - Monomind\n`;
  const body = sections.map((fn) => fn(options)).join('\n\n');

  return `${header}\n${body}\n`;
}

/**
 * Generate minimal CLAUDE.md content (backward-compatible alias).
 */
export function generateMinimalClaudeMd(options: InitOptions): string {
  return generateClaudeMd(options, 'minimal');
}

/** Available template names for CLI wizard */
export const CLAUDE_MD_TEMPLATES: Array<{ name: ClaudeMdTemplate; description: string }> = [
  { name: 'minimal', description: 'Quick start — behavioral rules, CLI reference (~160 lines)' },
  {
    name: 'standard',
    description: 'Recommended — monoswarm rules, agents, memory commands (~225 lines)',
  },
  {
    name: 'full',
    description: 'Everything — hooks, learning protocol, intelligence system (~400 lines)',
  },
  {
    name: 'security',
    description: 'Security-focused — adds security scanning, audit protocols, CVE checks',
  },
  {
    name: 'performance',
    description: 'Performance-focused — adds benchmarking, profiling, optimization protocols',
  },
  {
    name: 'solo',
    description: 'Solo developer — no monoswarm, simple agent usage, memory commands (~150 lines)',
  },
];

export default generateClaudeMd;
