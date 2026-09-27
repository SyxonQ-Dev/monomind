import * as fs from 'node:fs';
import * as path from 'node:path';
import { registryPath } from '../agents/registry-freshness.js';
import { agentCatalog } from '../decision/catalogs.js';
import { output } from '../output.js';
import { writeJsonFileAtomic } from '../utils/json-file.js';

// ─── Shared utilities ────────────────────────────────────────────────────────

export function updateSwarmActivityMetrics(agentCountDelta: number): void {
  try {
    const metricsDir = path.join(process.cwd(), '.monomind', 'metrics');
    const activityPath = path.join(metricsDir, 'monoswarm-activity.json');

    let data: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      monoswarm: { active: false, agent_count: 0, coordination_active: false },
    };

    if (fs.existsSync(activityPath) && fs.statSync(activityPath).size <= 10 * 1024 * 1024) {
      data = JSON.parse(fs.readFileSync(activityPath, 'utf-8'));
    }

    const swarm = (data.monoswarm as Record<string, unknown>) ?? {};
    const currentCount = Math.max(0, (swarm.agent_count as number) || 0);
    const newCount = Math.max(0, currentCount + agentCountDelta);

    swarm.agent_count = newCount;
    swarm.active = newCount > 0;
    swarm.coordination_active = newCount > 0;
    data.monoswarm = swarm;
    data.timestamp = new Date().toISOString();

    writeJsonFileAtomic(activityPath, data);
  } catch {
    // Non-critical — don't fail the command if metrics update fails
  }
}

/** Type names `agent spawn --type` used to offer before it read the registry,
 *  mapped to the registry agent that does that job. `coder`, `researcher`,
 *  `tester`, `reviewer` and `coordinator` are registry names already. */
export const AGENT_TYPE_ALIASES: Record<string, string> = {
  architect: 'Software Architect',
  'core-architect': 'Software Architect',
  analyst: 'Performance Benchmarker',
  optimizer: 'Performance Benchmarker',
  'performance-engineer': 'Performance Benchmarker',
  'security-architect': 'Security Engineer',
  'security-auditor': 'Security Engineer',
  'memory-specialist': 'monoswarm-memory-manager',
  'swarm-specialist': 'coordinator',
  'test-architect': 'tdd-london-monoswarm',
};

/** The registry agent a `--type` value names: the value itself when it is a
 *  registry agent name, its alias target, or null when neither exists. With
 *  no registry to check against, the value passes through unchanged. */
export function resolveAgentType(type: string, names: Set<string>): string | null {
  if (names.size === 0 || names.has(type)) return type;
  const lower = type.toLowerCase();
  const byCase = [...names].find((n) => n.toLowerCase() === lower);
  if (byCase) return byCase;
  const alias = AGENT_TYPE_ALIASES[lower];
  return alias && names.has(alias) ? alias : null;
}

/** Interactive choices: the registry's non-deprecated agents, by name. */
export function agentTypeOptions(root: string): { value: string; label: string; hint?: string }[] {
  return agentCatalog(root)
    .map((a) => ({ value: a.name ?? a.id, label: a.name ?? a.id, hint: a.category }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export function getAgentCapabilities(type: string): string[] {
  const capabilities: Record<string, string[]> = {
    coder: ['code-generation', 'refactoring', 'debugging', 'testing'],
    researcher: ['web-search', 'data-analysis', 'summarization', 'citation'],
    tester: ['unit-testing', 'integration-testing', 'coverage-analysis', 'automation'],
    reviewer: ['code-review', 'security-audit', 'quality-check', 'documentation'],
    architect: ['system-design', 'pattern-analysis', 'scalability', 'documentation'],
    coordinator: ['task-orchestration', 'agent-management', 'workflow-control'],
    'security-architect': ['threat-modeling', 'security-patterns', 'compliance', 'audit'],
    'memory-specialist': ['vector-search', 'sqlite', 'caching', 'optimization'],
    'performance-engineer': ['benchmarking', 'profiling', 'optimization', 'monitoring'],
  };
  return capabilities[type] || ['general'];
}

/** The `capabilities` the registry lists for agent `name`, or []. */
function registryCapabilities(root: string, name: string): string[] {
  try {
    const file = registryPath(root);
    if (fs.statSync(file).size > 10 * 1024 * 1024) return [];
    const reg = JSON.parse(fs.readFileSync(file, 'utf-8')) as {
      agents?: { name?: unknown; capabilities?: unknown }[];
    };
    const caps = reg.agents?.find((a) => a.name === name)?.capabilities;
    return Array.isArray(caps) ? caps.filter((c): c is string => typeof c === 'string') : [];
  } catch {
    return [];
  }
}

/** Capabilities of the agent a spawn resolved to: the registry's list for it,
 *  else the built-in set for the resolved or the requested (old) type name. */
export function agentCapabilities(root: string, resolved: string, requested: string): string[] {
  const fromRegistry = registryCapabilities(root, resolved);
  if (fromRegistry.length > 0) return fromRegistry;
  const own = getAgentCapabilities(resolved);
  return own[0] === 'general' ? getAgentCapabilities(requested.toLowerCase()) : own;
}

export function formatStatus(status: unknown): string {
  const s = String(status);
  switch (s) {
    case 'active':
      return output.success(s);
    case 'idle':
      return output.warning(s);
    case 'inactive':
    case 'stopped':
      return output.dim(s);
    case 'error':
      return output.error(s);
    default:
      return s;
  }
}
