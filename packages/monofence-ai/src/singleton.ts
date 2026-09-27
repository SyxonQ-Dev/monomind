/**
 * monofence-ai — default MonoDefence singleton and convenience functions
 * Split out of index.ts (file-size sweep). Pure move.
 */

import type { ThreatDetectionResult } from './domain/entities/threat.js';
import { createMonoDefence, type MonoDefence, type MonoDefenceConfig } from './facade.js';

/**
 * Singleton instance for convenience
 */
let defaultInstance: MonoDefence | null = null;

/**
 * Get the default MonoDefence instance (singleton, learning enabled)
 */
export function getMonoDefence(config?: MonoDefenceConfig): MonoDefence {
  if (!defaultInstance) {
    defaultInstance = createMonoDefence(config ?? { enableLearning: true });
  } else if (config) {
    console.warn(
      '[MonoDefence] getMonoDefence() called with config after singleton is already initialized. ' +
        'Config ignored — use createMonoDefence() for a separate instance, or call resetMonoDefence() first.',
    );
  }
  return defaultInstance;
}

/**
 * Reset the default singleton so the next getMonoDefence() call creates a fresh instance.
 * Useful in tests or when reconfiguration is needed.
 */
export function resetMonoDefence(): void {
  defaultInstance = null;
}

/**
 * Convenience function for quick threat check (synchronous).
 * Checks the allowlist first for consistency with detect().
 */
export function isSafe(input: string): boolean {
  const instance = getMonoDefence();
  if (instance.isAllowed(input)) {
    return true;
  }
  return instance.quickScan(input).threat === false;
}

/**
 * Convenience function for full threat detection with details
 */
export async function checkThreats(input: string): Promise<ThreatDetectionResult> {
  return getMonoDefence().detect(input);
}
