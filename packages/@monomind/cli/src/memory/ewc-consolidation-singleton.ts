/**
 * Singleton accessor and convenience utility functions for EWCConsolidator.
 * File-size sweep: split out of ewc-consolidation.ts.
 *
 * @module v1/cli/memory/ewc-consolidation-singleton
 */

import { EWCConsolidator } from './ewc-consolidation.js';
import type { ConsolidationResult, EWCConfig, EWCStats } from './ewc-consolidation-types.js';

let ewcConsolidatorInstance: EWCConsolidator | null = null;

/**
 * Get the singleton EWC Consolidator instance
 *
 * @param config - Optional configuration overrides
 * @returns EWC Consolidator instance
 */
export async function getEWCConsolidator(config?: Partial<EWCConfig>): Promise<EWCConsolidator> {
  if (!ewcConsolidatorInstance) {
    ewcConsolidatorInstance = new EWCConsolidator(config);
    await ewcConsolidatorInstance.initialize();
  }
  return ewcConsolidatorInstance;
}

/**
 * Reset the singleton instance (for testing)
 */
export function resetEWCConsolidator(): void {
  if (ewcConsolidatorInstance) {
    ewcConsolidatorInstance.clear();
    ewcConsolidatorInstance = null;
  }
}

/**
 * Quick consolidation helper for common use case
 * Consolidates new patterns with existing ones using EWC
 *
 * @param newPatterns - New patterns to add
 * @returns Consolidation result
 */
export async function consolidatePatterns(
  newPatterns: { id: string; embedding: number[]; type: string; description?: string }[],
): Promise<ConsolidationResult> {
  const consolidator = await getEWCConsolidator();
  return consolidator.consolidate(newPatterns);
}

/**
 * Record pattern usage outcome
 * Updates Fisher information and pattern importance
 *
 * @param patternId - Pattern identifier
 * @param embedding - Pattern embedding (used as gradient proxy)
 * @param success - Whether the pattern was successful
 */
export async function recordPatternOutcome(
  patternId: string,
  embedding: number[],
  success: boolean,
): Promise<void> {
  const consolidator = await getEWCConsolidator();
  consolidator.recordGradient(patternId, embedding, success);
}

/**
 * Get EWC statistics
 */
export async function getEWCStats(): Promise<EWCStats> {
  const consolidator = await getEWCConsolidator();
  return consolidator.getConsolidationStats();
}
