/**
 * V1 Intelligence Module — AutoMem: Memory Proficiency Tracking
 * Split out of intelligence.ts (file-size sweep). Pure move.
 * Tracks success rate and pattern-hit rate of recalled memory decisions,
 * so recall quality can be measured and reported by `doctor`.
 *
 * @module v1/cli/intelligence
 */

import { initializeIntelligence, reasoningBank } from './intelligence.js';

interface MemoryDecisionInput {
  taskDescription: string;
  agent: string;
  success: boolean;
  latencyMs: number;
}

const memoryProficiencyStats = {
  totalDecisions: 0,
  successfulDecisions: 0,
  patternHits: 0,
  patternMisses: 0,
};

/**
 * Record a memory decision from a completed task. Stores successful patterns
 * in the 'memory-proficiency' domain so future PLAN routines can retrieve them.
 */
export async function recordMemoryDecision(input: MemoryDecisionInput): Promise<void> {
  memoryProficiencyStats.totalDecisions++;
  if (input.success) memoryProficiencyStats.successfulDecisions++;

  if (!input.success || !input.taskDescription || input.taskDescription.length < 10) return;

  if (!reasoningBank) {
    const init = await initializeIntelligence();
    if (!init.success) return;
  }
  const bank = reasoningBank;
  if (!bank) return;

  try {
    let embedding: number[] | null = null;
    try {
      const bridge = await import('./memory-bridge.js');
      const result = await bridge.bridgeGenerateEmbedding(input.taskDescription);
      if (result) embedding = result.embedding;
    } catch {
      /* bridge unavailable */
    }
    if (!embedding) {
      const { generateEmbedding } = await import('./memory-initializer.js');
      embedding = (await generateEmbedding(input.taskDescription)).embedding;
    }

    // Check for similar existing pattern to avoid redundant storage
    const existing = bank.findSimilar(embedding, {
      k: 1,
      threshold: 0.85,
      type: 'memory-proficiency',
    });
    if (existing.length > 0) {
      const existingPattern = existing[0];
      if (!existingPattern) return;
      bank.recordUsage(existingPattern.id);
      memoryProficiencyStats.patternHits++;
      return;
    }

    memoryProficiencyStats.patternMisses++;

    bank.store({
      id: `mprof_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      type: 'memory-proficiency',
      embedding,
      content: `[${input.agent}] ${input.taskDescription}`,
      confidence: input.success ? 0.8 : 0.3,
      metadata: {
        agent: input.agent,
        latencyMs: input.latencyMs,
      },
    });
  } catch {
    /* non-fatal */
  }
}

/**
 * Return memory proficiency stats for doctor health check.
 */
export function getMemoryProficiencyStats(): {
  totalDecisions: number;
  successRate: number;
  proficiencyPatterns: number;
  patternHitRate: number;
} {
  const { totalDecisions, successfulDecisions, patternHits, patternMisses } =
    memoryProficiencyStats;
  const proficiencyPatterns = reasoningBank?.getByType('memory-proficiency').length ?? 0;
  const totalLookups = patternHits + patternMisses;

  return {
    totalDecisions,
    successRate: totalDecisions > 0 ? successfulDecisions / totalDecisions : 0,
    proficiencyPatterns,
    patternHitRate: totalLookups > 0 ? patternHits / totalLookups : 0,
  };
}
