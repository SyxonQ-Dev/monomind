/**
 * EWC-inspired pattern consolidation.
 *
 * Protects high-importance stored patterns from being overwritten by newer,
 * similar ones — the pattern-store analogue of avoiding catastrophic
 * forgetting.
 *
 * HONEST SCOPE — read before extending this:
 * This is *not* Elastic Weight Consolidation. Real EWC penalises drift in a
 * model's parameters using Fisher information estimated from training
 * gradients:
 *
 *   L_total = L_new + (lambda/2) * sum_i(F_i * (theta_i - theta_old_i)^2)
 *
 * There is no model here, no training loop, and therefore no gradients. What
 * this file actually computes is a per-dimension importance weight from the
 * *squared embedding values* of stored patterns, used as a stand-in for the
 * Fisher diagonal (see computeFisherMatrix — the substitution is noted at the
 * line that performs it), smoothed with an EMA and applied as a quadratic
 * penalty when a new pattern would displace an existing one.
 *
 * That heuristic is real, deterministic, and useful. The EWC name and the
 * formula above describe the *inspiration*, not the implementation — do not
 * cite this as an EWC implementation or reason about it as if `F_i` carried
 * Fisher semantics.
 *
 * What it does:
 * - Per-dimension importance from squared embedding magnitudes (gradient proxy)
 * - Online EMA updates as new patterns stream in
 * - Selective consolidation based on that importance
 * - Persistent storage in .swarm/ewc-fisher.json
 *
 * File-size sweep: types live in ewc-consolidation-types.ts; the class's
 * method BODIES are grouped into sibling modules — Fisher-matrix methods in
 * ewc-consolidation-fisher.ts, the consolidate/blend/prune core in
 * ewc-consolidation-core.ts, stats/accessor methods in
 * ewc-consolidation-stats.ts, and save/load/clear in
 * ewc-consolidation-persist.ts — mixed onto EWCConsolidator.prototype below.
 * The singleton accessor and module-level convenience functions live in
 * ewc-consolidation-singleton.ts and are re-exported here. Each moved method
 * stays a real method here (same signature, same visibility) so callers and
 * TypeScript see no difference; the body is just
 * `return theSiblingImpl.call(this, ...args)`. Fields those bodies read/write
 * moved from `private` to `protected` (compile-time only; no runtime change)
 * — TypeScript allows a standalone function typed `this: EWCConsolidator` to
 * reach `protected` members but not `private` ones, so `protected` is the
 * minimum visibility the split needs.
 *
 * @module v1/cli/memory/ewc-consolidation
 */

import * as path from 'node:path';
import { ewcCoreMethods } from './ewc-consolidation-core.js';
import { ewcFisherMethods } from './ewc-consolidation-fisher.js';
import { ewcPersistMethods } from './ewc-consolidation-persist.js';
import { ewcStatsMethods } from './ewc-consolidation-stats.js';
import type {
  ConsolidationResult,
  EWCConfig,
  EWCStats,
  FisherEntry,
  GradientSample,
  PatternWeights,
} from './ewc-consolidation-types.js';
import { BRIDGE_EMBEDDING_DIMS } from './memory-bridge.js';

export type {
  ConsolidationResult,
  EWCConfig,
  EWCStats,
  FisherEntry,
  GradientSample,
  PatternWeights,
};

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_EWC_CONFIG: EWCConfig = {
  lambda: 0.4,
  maxPatterns: 1000,
  fisherDecayRate: 0.01,
  importanceThreshold: 0.3,
  storagePath: path.join(process.cwd(), '.swarm', 'ewc-fisher.json'),
  onlineMode: true,
  dimensions: BRIDGE_EMBEDDING_DIMS,
};

// ============================================================================
// EWC Consolidator Class
// ============================================================================

/**
 * EWC++ Consolidator
 * Implements Elastic Weight Consolidation with online updates
 * for preventing catastrophic forgetting in continual learning
 */
export class EWCConsolidator {
  protected config: EWCConfig;
  protected patterns: Map<string, PatternWeights> = new Map();
  protected gradientHistory: GradientSample[] = [];
  protected globalFisher: number[] = [];
  protected consolidationHistory: { timestamp: number; penalty: number; patterns: number }[] = [];
  protected initialized: boolean = false;
  /** Dirty flag: true when in-memory state diverges from disk */
  protected dirty = false;
  /** Pending debounced write timer */
  protected saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** Debounce window for disk writes (ms) */
  private static readonly SAVE_DEBOUNCE_MS = 2_000;

  constructor(config?: Partial<EWCConfig>) {
    this.config = { ...DEFAULT_EWC_CONFIG, ...config };
    this.globalFisher = new Array(this.config.dimensions).fill(0);
  }

  /**
   * Initialize the consolidator by loading persisted state
   */
  async initialize(): Promise<boolean> {
    if (this.initialized) return true;

    try {
      await this.loadFromDisk();
      this.initialized = true;
      return true;
    } catch (e) {
      // Start fresh if no persisted state
      if (process.env.DEBUG || process.env.MONOMIND_DEBUG)
        console.error('[ewc-consolidation] failed to load persisted state, starting fresh:', e);
      this.initialized = true;
      return true;
    }
  }

  // Bodies live in ewc-consolidation-fisher.ts (file-size sweep).
  computeFisherMatrix(patterns: { id: string; embedding: number[]; success: boolean }[]): number[] {
    return ewcFisherMethods.computeFisherMatrix.call(this, patterns);
  }

  getPenalty(oldWeights: number[], newWeights: number[], fisher?: number[]): number {
    return ewcFisherMethods.getPenalty.call(this, oldWeights, newWeights, fisher);
  }

  resetFisher(): void {
    ewcFisherMethods.resetFisher.call(this);
  }

  updateFisherFromConfidences(
    confidenceChanges: { id: string; embedding: number[]; oldConf: number; newConf: number }[],
  ): void {
    ewcFisherMethods.updateFisherFromConfidences.call(this, confidenceChanges);
  }

  computeConfidencePenalty(oldConfidence: number, newConfidence: number): number {
    return ewcFisherMethods.computeConfidencePenalty.call(this, oldConfidence, newConfidence);
  }

  // Bodies live in ewc-consolidation-core.ts (file-size sweep).
  consolidate(
    newPatterns: { id: string; embedding: number[]; type: string; description?: string }[],
    oldPatterns?: PatternWeights[],
  ): ConsolidationResult {
    return ewcCoreMethods.consolidate.call(this, newPatterns, oldPatterns);
  }

  protected blendWeights(
    oldWeights: number[],
    newWeights: number[],
    blendFactor: number,
    fisher: number[],
  ): number[] {
    return ewcCoreMethods.blendWeights.call(this, oldWeights, newWeights, blendFactor, fisher);
  }

  protected pruneOldPatterns(): void {
    ewcCoreMethods.pruneOldPatterns.call(this);
  }

  // Bodies live in ewc-consolidation-stats.ts (file-size sweep).
  getConsolidationStats(): EWCStats {
    return ewcStatsMethods.getConsolidationStats.call(this);
  }

  recordGradient(patternId: string, gradients: number[], success: boolean): void {
    ewcStatsMethods.recordGradient.call(this, patternId, gradients, success);
  }

  getPatternWeights(id: string): PatternWeights | undefined {
    return ewcStatsMethods.getPatternWeights.call(this, id);
  }

  getAllPatterns(): PatternWeights[] {
    return ewcStatsMethods.getAllPatterns.call(this);
  }

  setLambda(lambda: number): void {
    ewcStatsMethods.setLambda.call(this, lambda);
  }

  getLambda(): number {
    return ewcStatsMethods.getLambda.call(this);
  }

  protected calculateImportance(pattern: PatternWeights): number {
    return ewcStatsMethods.calculateImportance.call(this, pattern);
  }

  // Bodies live in ewc-consolidation-persist.ts (file-size sweep).
  clear(): void {
    ewcPersistMethods.clear.call(this);
  }

  private saveToDisk(): void {
    ewcPersistMethods.saveToDisk.call(this);
  }

  private async loadFromDisk(): Promise<void> {
    return ewcPersistMethods.loadFromDisk.call(this);
  }

  /**
   * Schedule a debounced disk flush.
   * Multiple calls within SAVE_DEBOUNCE_MS coalesce into one write,
   * preventing blocking I/O on every consolidation or gradient event.
   */
  protected scheduleSave(): void {
    this.dirty = true;
    if (this.saveTimer) return; // already scheduled
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      if (this.dirty) {
        this.dirty = false;
        this.saveToDisk();
      }
    }, EWCConsolidator.SAVE_DEBOUNCE_MS);
    // Allow the process to exit without waiting for the timer
    if (this.saveTimer.unref) this.saveTimer.unref();
  }
}

export {
  consolidatePatterns,
  getEWCConsolidator,
  getEWCStats,
  recordPatternOutcome,
  resetEWCConsolidator,
} from './ewc-consolidation-singleton.js';

import {
  consolidatePatterns,
  getEWCConsolidator,
  getEWCStats,
  recordPatternOutcome,
  resetEWCConsolidator,
} from './ewc-consolidation-singleton.js';

export default {
  EWCConsolidator,
  getEWCConsolidator,
  resetEWCConsolidator,
  consolidatePatterns,
  recordPatternOutcome,
  getEWCStats,
};
