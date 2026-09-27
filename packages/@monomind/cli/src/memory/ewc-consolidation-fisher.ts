/**
 * Fisher-matrix methods for EWCConsolidator (compute/penalty/reset/online update).
 * File-size sweep: split out of ewc-consolidation.ts. Mixed into
 * EWCConsolidator.prototype at the bottom of ewc-consolidation.ts.
 *
 * @module v1/cli/memory/ewc-consolidation-fisher
 */

import type { EWCConsolidator } from './ewc-consolidation.js';

export const ewcFisherMethods = {
  /**
   * Compute Fisher Information Matrix from gradient history
   * Uses diagonal approximation for efficiency: F_i = E[g_i^2]
   *
   * @param patterns - Array of patterns with their gradients/embeddings
   * @returns Fisher information diagonal
   */
  computeFisherMatrix(
    this: EWCConsolidator,
    patterns: { id: string; embedding: number[]; success: boolean }[],
  ): number[] {
    const fisher = new Array(this.config.dimensions).fill(0);
    let sampleCount = 0;

    for (const pattern of patterns) {
      if (!pattern.embedding || pattern.embedding.length === 0) continue;

      // Only use successful patterns for Fisher computation
      // (we want to preserve what worked)
      if (!pattern.success) continue;

      sampleCount++;

      // Fisher diagonal is expectation of squared gradients
      // For embeddings, we use the embedding values as proxy for gradients
      const len = Math.min(pattern.embedding.length, this.config.dimensions);
      for (let i = 0; i < len; i++) {
        // Accumulate squared values (gradient proxy)
        fisher[i] += pattern.embedding[i] * pattern.embedding[i];
      }
    }

    // Normalize by sample count
    if (sampleCount > 0) {
      for (let i = 0; i < this.config.dimensions; i++) {
        fisher[i] /= sampleCount;
      }
    }

    // Update global Fisher with exponential moving average (EWC++)
    if (this.config.onlineMode) {
      const decay = this.config.fisherDecayRate;
      for (let i = 0; i < this.config.dimensions; i++) {
        this.globalFisher[i] = (1 - decay) * this.globalFisher[i] + decay * fisher[i];
      }
    }

    return fisher;
  },

  /**
   * Calculate EWC regularization penalty
   *
   * L_ewc = (lambda/2) * sum_i(F_i * (theta_i - theta_old_i)^2)
   *
   * @param oldWeights - Previous weight values
   * @param newWeights - New weight values
   * @param fisher - Fisher information diagonal (optional, uses global if not provided)
   * @returns Regularization penalty value
   */
  getPenalty(
    this: EWCConsolidator,
    oldWeights: number[],
    newWeights: number[],
    fisher?: number[],
  ): number {
    const fisherDiag = fisher || this.globalFisher;
    const len = Math.min(oldWeights.length, newWeights.length, fisherDiag.length);

    let penalty = 0;
    for (let i = 0; i < len; i++) {
      const diff = newWeights[i] - oldWeights[i];
      penalty += fisherDiag[i] * diff * diff;
    }

    return (this.config.lambda / 2) * penalty;
  },

  /**
   * Reset Fisher matrix (use with caution - allows forgetting)
   */
  resetFisher(this: EWCConsolidator): void {
    this.globalFisher = new Array(this.config.dimensions).fill(0);
  },

  /**
   * Update Fisher matrix from pattern confidence changes.
   * Called by SONA after distillLearning to track which patterns
   * are important and should be protected from forgetting.
   *
   * Uses online averaging: F_new = alpha * F_old + (1-alpha) * F_current
   *
   * @param confidenceChanges - Array of {id, embedding, oldConf, newConf}
   */
  updateFisherFromConfidences(
    this: EWCConsolidator,
    confidenceChanges: { id: string; embedding: number[]; oldConf: number; newConf: number }[],
  ): void {
    if (confidenceChanges.length === 0) return;

    const alpha = this.config.fisherDecayRate;
    const currentFisher = new Array(this.config.dimensions).fill(0);
    let sampleCount = 0;

    for (const change of confidenceChanges) {
      if (!change.embedding || change.embedding.length === 0) continue;

      const confDelta = Math.abs(change.newConf - change.oldConf);
      if (confDelta === 0) continue;

      sampleCount++;
      const len = Math.min(change.embedding.length, this.config.dimensions);

      // Squared gradient proxy: embedding scaled by confidence change magnitude
      for (let i = 0; i < len; i++) {
        const grad = change.embedding[i] * confDelta;
        currentFisher[i] += grad * grad;
      }
    }

    if (sampleCount > 0) {
      for (let i = 0; i < this.config.dimensions; i++) {
        currentFisher[i] /= sampleCount;
      }
    }

    // Online EMA: F_new = alpha * F_old + (1-alpha) * F_current
    for (let i = 0; i < this.config.dimensions; i++) {
      this.globalFisher[i] = alpha * this.globalFisher[i] + (1 - alpha) * currentFisher[i];
    }

    this.scheduleSave();
  },

  /**
   * Compute consolidation penalty for a proposed confidence update.
   * Used by SONA to check whether a pattern update would cause forgetting.
   *
   * @param oldConfidence - Current confidence value
   * @param newConfidence - Proposed new confidence value
   * @returns Penalty value (higher = more forgetting risk)
   */
  computeConfidencePenalty(
    this: EWCConsolidator,
    oldConfidence: number,
    newConfidence: number,
  ): number {
    // Use the global Fisher to estimate penalty for scalar confidence change
    // Average Fisher value represents overall importance
    let avgFisher = 0;
    for (let i = 0; i < this.globalFisher.length; i++) {
      avgFisher += this.globalFisher[i];
    }
    avgFisher = this.globalFisher.length > 0 ? avgFisher / this.globalFisher.length : 0;

    const diff = newConfidence - oldConfidence;
    return (this.config.lambda / 2) * avgFisher * diff * diff;
  },
};
