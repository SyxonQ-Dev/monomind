/**
 * SONA Optimizer — singleton instance and convenience functions
 * Split out of sona-optimizer.ts (file-size sweep). Pure move.
 *
 * @module v1/cli/memory/sona-optimizer
 */

import { SONAOptimizer } from './sona-optimizer.js';
import type { RoutingSuggestion, SONAStats, TrajectoryOutcome } from './sona-optimizer-types.js';

// ============================================================================
// Singleton Instance
// ============================================================================

let sonaOptimizerInstance: SONAOptimizer | null = null;
let initializationPromise: Promise<SONAOptimizer> | null = null;

/**
 * Get the singleton SONAOptimizer instance
 * Uses lazy initialization to avoid circular imports
 */
export async function getSONAOptimizer(): Promise<SONAOptimizer> {
  if (sonaOptimizerInstance) {
    return sonaOptimizerInstance;
  }

  // Prevent multiple concurrent initializations
  if (initializationPromise) {
    return initializationPromise;
  }

  initializationPromise = (async () => {
    const optimizer = new SONAOptimizer();
    await optimizer.initialize();
    sonaOptimizerInstance = optimizer;
    return optimizer;
  })();

  return initializationPromise;
}

/**
 * Reset the singleton instance (for testing)
 */
export function resetSONAOptimizer(): void {
  if (sonaOptimizerInstance) {
    sonaOptimizerInstance.reset();
  }
  sonaOptimizerInstance = null;
  initializationPromise = null;
}

/**
 * Process a trajectory outcome (convenience function)
 */
export async function processTrajectory(outcome: TrajectoryOutcome): Promise<{
  learned: boolean;
  patternKey: string;
  confidence: number;
  keywordsExtracted: string[];
}> {
  const optimizer = await getSONAOptimizer();
  return optimizer.processTrajectoryOutcome(outcome);
}

/**
 * Get routing suggestion (convenience function)
 */
export async function getSuggestion(task: string): Promise<RoutingSuggestion> {
  const optimizer = await getSONAOptimizer();
  return optimizer.getRoutingSuggestion(task);
}

/**
 * Get SONA statistics (convenience function)
 */
export async function getSONAStats(): Promise<SONAStats> {
  const optimizer = await getSONAOptimizer();
  return optimizer.getStats();
}

export default {
  SONAOptimizer,
  getSONAOptimizer,
  resetSONAOptimizer,
  processTrajectory,
  getSuggestion,
  getSONAStats,
};
