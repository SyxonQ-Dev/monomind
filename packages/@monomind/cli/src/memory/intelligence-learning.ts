/**
 * V1 Intelligence Module — learning/trajectory public API
 * Split out of intelligence.ts (file-size sweep). Pure move.
 *
 * @module v1/cli/intelligence
 */

import {
  globalStats,
  initializeIntelligence,
  reasoningBank,
  savePersistedStats,
  sonaCoordinator,
} from './intelligence.js';
import type { Pattern, TrajectoryStep } from './intelligence-types.js';
import { BRIDGE_EMBEDDING_DIMS } from './memory-bridge.js';

/**
 * Record a trajectory step for learning
 * Performance: <0.05ms without embedding generation
 */
export async function recordStep(step: TrajectoryStep): Promise<boolean> {
  if (!sonaCoordinator) {
    const init = await initializeIntelligence();
    if (!init.success) return false;
  }

  try {
    // Generate embedding if not provided
    // ADR-053: Try SQLite-backed memory bridge embedder first
    let embedding = step.embedding;
    if (!embedding) {
      try {
        const bridge = await import('./memory-bridge.js');
        const bridgeResult = await bridge.bridgeGenerateEmbedding(step.content);
        if (bridgeResult) {
          embedding = bridgeResult.embedding;
        }
      } catch {
        // Bridge not available
      }
      if (!embedding) {
        const { generateEmbedding } = await import('./memory-initializer.js');
        const result = await generateEmbedding(step.content);
        embedding = result.embedding;
      }
    }

    // Record in SONA - <0.05ms
    sonaCoordinator?.recordSignal({
      type: step.type,
      content: step.content,
      embedding,
      metadata: step.metadata,
      timestamp: step.timestamp || Date.now(),
    });

    // Add to current trajectory for outcome tracking
    const stepWithEmbedding = { ...step, embedding };
    sonaCoordinator?.addTrajectoryStep(stepWithEmbedding);

    // Store in ReasoningBank for retrieval
    if (reasoningBank) {
      reasoningBank.store({
        id: `step_${Date.now()}_${Math.random().toString(36).substring(7)}`,
        type: step.type,
        embedding,
        content: step.content,
        confidence: 1.0,
        metadata: step.metadata,
      });
    }

    // When a 'result' step arrives, end the trajectory and run the confidence-update loop
    if (step.type === 'result' && reasoningBank) {
      // Determine verdict from metadata or default to 'partial'
      const verdict = (step.metadata?.verdict as 'success' | 'failure' | 'partial') || 'partial';
      await sonaCoordinator?.endTrajectory(verdict, reasoningBank);

      // Distill learning from recent successful trajectories
      await sonaCoordinator?.distillLearning(reasoningBank);

      globalStats.lastAdaptation = Date.now();
    }

    globalStats.trajectoriesRecorded++;
    return true;
  } catch (e) {
    if (process.env.DEBUG || process.env.MONOMIND_DEBUG)
      console.error('[intelligence] recordStep failed:', e);
    return false;
  }
}

/**
 * Record a complete trajectory with verdict
 */
export async function recordTrajectory(
  steps: TrajectoryStep[],
  verdict: 'success' | 'failure' | 'partial',
): Promise<boolean> {
  if (!sonaCoordinator) {
    const init = await initializeIntelligence();
    if (!init.success) return false;
  }

  try {
    sonaCoordinator?.recordTrajectory({
      steps,
      verdict,
      timestamp: Date.now(),
    });

    // Update pattern confidences based on verdict
    if (reasoningBank) {
      // Load steps into the coordinator for endTrajectory processing
      for (const step of steps) {
        sonaCoordinator?.addTrajectoryStep(step);
      }
      await sonaCoordinator?.endTrajectory(verdict, reasoningBank);
      await sonaCoordinator?.distillLearning(reasoningBank);
    }

    globalStats.trajectoriesRecorded++;
    globalStats.lastAdaptation = Date.now();
    savePersistedStats();

    return true;
  } catch (e) {
    if (process.env.DEBUG || process.env.MONOMIND_DEBUG)
      console.error('[intelligence] recordTrajectory failed:', e);
    return false;
  }
}

/**
 * Find similar patterns from ReasoningBank
 */
export interface PatternMatch extends Pattern {
  similarity: number;
}

export async function findSimilarPatterns(
  query: string,
  options?: { k?: number; threshold?: number; type?: string },
): Promise<PatternMatch[]> {
  // Cap query length to prevent OOM via embedding generation on unbounded input
  if (typeof query === 'string' && query.length > 2000) {
    query = query.slice(0, 2000);
  }
  if (!reasoningBank) {
    const init = await initializeIntelligence();
    if (!init.success) return [];
  }
  const bank = reasoningBank;
  if (!bank) return [];

  try {
    // ADR-053: Try SQLite-backed memory bridge embedder first
    let queryEmbedding: number[] | null = null;
    try {
      const bridge = await import('./memory-bridge.js');
      const bridgeResult = await bridge.bridgeGenerateEmbedding(query);
      if (bridgeResult) {
        queryEmbedding = bridgeResult.embedding;
      }
    } catch {
      // Bridge not available
    }
    if (!queryEmbedding) {
      const { generateEmbedding } = await import('./memory-initializer.js');
      const queryResult = await generateEmbedding(query);
      queryEmbedding = queryResult.embedding;
    }

    // Hash-fallback embeddings (128-dim) produce lower cosine similarities
    // than ONNX/transformer embeddings, so use a lower default threshold
    const isHashFallback = queryEmbedding.length === 128;
    const defaultThreshold = isHashFallback ? 0.1 : 0.5;

    const results = bank.findSimilar(queryEmbedding, {
      k: options?.k ?? 5,
      threshold: options?.threshold ?? defaultThreshold,
      type: options?.type,
    });

    // Record usage for each matched pattern (findSimilar is now a pure read)
    for (const r of results) {
      bank.recordUsage(r.id);
    }

    return results.map((r) => ({
      id: r.id,
      type: r.type,
      embedding: r.embedding,
      content: r.content,
      confidence: r.confidence,
      usageCount: r.usageCount,
      createdAt: r.createdAt,
      lastUsedAt: r.lastUsedAt,
      similarity: (r as unknown as { similarity?: number }).similarity ?? r.confidence ?? 0.5,
    }));
  } catch (e) {
    if (process.env.DEBUG || process.env.MONOMIND_DEBUG)
      console.error('[intelligence] findSimilarPatterns failed:', e);
    return [];
  }
}

/**
 * End the current trajectory with a verdict and apply confidence updates.
 * This is the public API for the SONA feedback loop.
 *
 * @param verdict - 'success' (reward=1.0), 'partial' (0.5), or 'failure' (-0.5)
 * @returns Update statistics or null if not initialized
 */
export async function endTrajectoryWithVerdict(
  verdict: 'success' | 'failure' | 'partial',
): Promise<{ reward: number; patternsUpdated: number } | null> {
  if (!sonaCoordinator || !reasoningBank) {
    const init = await initializeIntelligence();
    if (!init.success) return null;
  }
  const coordinator = sonaCoordinator;
  const bank = reasoningBank;
  if (!coordinator || !bank) return null;

  try {
    const result = await coordinator.endTrajectory(verdict, bank);
    globalStats.lastAdaptation = Date.now();
    savePersistedStats();
    return result;
  } catch (e) {
    if (process.env.DEBUG || process.env.MONOMIND_DEBUG)
      console.error('[intelligence] endTrajectoryWithVerdict failed:', e);
    return null;
  }
}

/**
 * Distill learning from recent successful trajectories.
 * Applies incremental confidence updates with EWC consolidation protection.
 *
 * @returns Distillation statistics or null if not initialized
 */
export async function distillLearning(): Promise<{
  patternsDistilled: number;
  ewcPenalty: number;
} | null> {
  if (!sonaCoordinator || !reasoningBank) {
    const init = await initializeIntelligence();
    if (!init.success) return null;
  }
  const coordinator = sonaCoordinator;
  const bank = reasoningBank;
  if (!coordinator || !bank) return null;

  try {
    const result = await coordinator.distillLearning(bank);
    globalStats.lastAdaptation = Date.now();
    savePersistedStats();
    return result;
  } catch (e) {
    if (process.env.DEBUG || process.env.MONOMIND_DEBUG)
      console.error('[intelligence] distillLearning failed:', e);
    return null;
  }
}

/**
 * Benchmark SONA adaptation time
 */
export function benchmarkAdaptation(iterations: number = 1000): {
  totalMs: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
  targetMet: boolean;
} {
  if (!sonaCoordinator) {
    return { totalMs: 0, avgMs: 0, minMs: 0, maxMs: 0, targetMet: false };
  }

  // Cap iterations to prevent OOM/CPU exhaustion from unbounded caller input
  const safeIterations = Math.min(Math.max(1, iterations >>> 0), 100_000);

  const times: number[] = [];
  const testEmbedding = Array.from({ length: BRIDGE_EMBEDDING_DIMS }, () => Math.random());

  for (let i = 0; i < safeIterations; i++) {
    const start = performance.now();
    sonaCoordinator.recordSignal({
      type: 'test',
      content: `benchmark_${i}`,
      embedding: testEmbedding,
      timestamp: Date.now(),
    });
    times.push(performance.now() - start);
  }

  const totalMs = times.reduce((a, b) => a + b, 0);
  const avgMs = totalMs / safeIterations;
  const minMs = Math.min(...times);
  const maxMs = Math.max(...times);

  return {
    totalMs,
    avgMs,
    minMs,
    maxMs,
    targetMet: avgMs < 0.05,
  };
}
