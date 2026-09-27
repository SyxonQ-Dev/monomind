/**
 * Hooks embedding — file-to-agent suggestions and command risk assessment.
 * Extracted from hooks-embedding.ts.
 */

import { getProjectCwd } from './types.js';

// File type → recommended agents for hooks_pre-edit. Every value is a spawnable
// agent name (a bundled agent's frontmatter `name`, the Task subagent_type).
export const AGENT_PATTERNS: Record<string, string[]> = {
  '.ts': ['coder', 'Software Architect', 'tester'],
  '.tsx': ['Frontend Developer', 'coder', 'reviewer'],
  '.test.ts': ['tester', 'reviewer'],
  '.spec.ts': ['tester', 'reviewer'],
  '.md': ['Technical Writer', 'researcher'],
  '.json': ['coder', 'Software Architect'],
  '.yaml': ['DevOps Automator', 'coder'],
  '.yml': ['DevOps Automator', 'coder'],
  '.sh': ['DevOps Automator', 'coder'],
  '.py': ['coder', 'AI Engineer', 'researcher'],
  '.sql': ['Database Optimizer', 'coder'],
  '.css': ['Frontend Developer', 'Monodesign'],
  '.scss': ['Frontend Developer', 'Monodesign'],
};

export function getFileExtension(filePath: string): string {
  const match = filePath.match(/\.[a-zA-Z0-9]+$/);
  return match ? match[0] : '';
}

export function suggestAgentsForFile(filePath: string): string[] {
  const ext = getFileExtension(filePath);

  // Check for test files first
  if (filePath.includes('.test.') || filePath.includes('.spec.')) {
    return AGENT_PATTERNS['.test.ts'] || ['tester', 'reviewer'];
  }

  return AGENT_PATTERNS[ext] || ['coder', 'Software Architect'];
}

/**
 * V3: Augment agent suggestions with semantic matches from intelligence.ts ReasoningBank.
 * Returns null when the intelligence system is unavailable or has no relevant patterns.
 * Used by the prompt hook (.claude/helpers/handlers/route-handler.cjs).
 */
// Only pattern types that are registry agent names (the spawnable Task
// subagent_type) count; structural labels ('action', 'observation',
// 'routing') and names no agent carries any more are skipped.
//
// Lean teardown: the SONA neural LoRA routing adaptation (applyNeuralAdaptation +
// the @monomind/neural NeuralLearningSystem singleton) has been removed. Routing now
// uses the pure keyword path plus the deterministic generateSimpleEmbedding query
// against the pattern index, with outcomes recorded via route-outcomes. No ONNX /
// LoRA inference happens on the routing hot path anymore.

export async function suggestAgentsFromIntelligence(
  task: string,
): Promise<{ agents: string[]; confidence: number } | null> {
  try {
    const intel = await import('../memory/intelligence.js');
    await intel.initializeIntelligence();
    const matches = await intel.findSimilarPatterns(task, { k: 5 });
    if (!matches || matches.length === 0) return null;

    // Only count patterns whose type is a registry agent name.
    // Trajectory-derived patterns use type='action'|'observation' etc. — skip those.
    const { agentNames } = await import('../decision/catalogs.js');
    const names = agentNames(getProjectCwd());
    const agentCounts: Record<string, number> = {};
    for (const m of matches) {
      const agent = m.type ?? '';
      if (!names.has(agent)) continue;
      agentCounts[agent] = (agentCounts[agent] ?? 0) + (m.similarity ?? m.confidence ?? 0.5);
    }

    const sorted = Object.entries(agentCounts).sort((a, b) => b[1] - a[1]);
    if (sorted.length === 0) return null;

    // Return top-3 ranked agents so callers can build multi-agent task assignments
    const topAgents = sorted.slice(0, 3).map(([agent]) => agent);
    const confidence = Math.min(0.9, sorted[0][1] / matches.length);
    return { agents: topAgents, confidence };
  } catch {
    return null;
  }
}

export function assessCommandRisk(command: string): {
  risk: string;
  level: number;
  warnings: string[];
} {
  const warnings: string[] = [];
  let level = 0;

  // High risk commands
  if (command.includes('rm -rf') || command.includes('rm -r')) {
    level = Math.max(level, 0.9);
    warnings.push('Recursive deletion detected - verify target path');
  }
  if (command.includes('sudo')) {
    level = Math.max(level, 0.7);
    warnings.push('Elevated privileges requested');
  }
  if (command.includes('> /') || command.includes('>> /')) {
    level = Math.max(level, 0.6);
    warnings.push('Writing to system path');
  }
  if (command.includes('chmod') || command.includes('chown')) {
    level = Math.max(level, 0.5);
    warnings.push('Permission modification');
  }
  if (command.includes('curl') && command.includes('|')) {
    level = Math.max(level, 0.8);
    warnings.push('Piping remote content to shell');
  }

  // Safe commands
  if (command.startsWith('npm ') || command.startsWith('npx ')) {
    level = Math.min(level, 0.3);
  }
  if (command.startsWith('git ')) {
    level = Math.min(level, 0.2);
  }
  if (command.startsWith('ls ') || command.startsWith('cat ') || command.startsWith('echo ')) {
    level = Math.min(level, 0.1);
  }

  const risk = level >= 0.7 ? 'high' : level >= 0.4 ? 'medium' : 'low';

  return { risk, level, warnings };
}
