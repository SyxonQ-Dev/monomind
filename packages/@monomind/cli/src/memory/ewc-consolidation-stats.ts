/**
 * Stats/accessor methods for EWCConsolidator (stats, gradient recording,
 * pattern lookup, lambda accessors, importance scoring).
 * File-size sweep: split out of ewc-consolidation.ts. Mixed into
 * EWCConsolidator.prototype at the bottom of ewc-consolidation.ts.
 *
 * @module v1/cli/memory/ewc-consolidation-stats
 */

import * as fs from 'node:fs';
import type { EWCConsolidator } from './ewc-consolidation.js';
import type { EWCStats, PatternWeights } from './ewc-consolidation-types.js';

export const ewcStatsMethods = {
  /**
   * Get consolidation statistics
   */
  getConsolidationStats(this: EWCConsolidator): EWCStats {
    let totalFisher = 0;
    let maxFisher = 0;
    let highImportance = 0;

    for (let i = 0; i < this.globalFisher.length; i++) {
      totalFisher += this.globalFisher[i];
      if (this.globalFisher[i] > maxFisher) {
        maxFisher = this.globalFisher[i];
      }
    }

    for (const pattern of this.patterns.values()) {
      if (this.calculateImportance(pattern) > this.config.importanceThreshold) {
        highImportance++;
      }
    }

    const totalPenalty = this.consolidationHistory.reduce((sum, h) => sum + h.penalty, 0);
    const avgPenalty =
      this.consolidationHistory.length > 0 ? totalPenalty / this.consolidationHistory.length : 0;

    // Estimate storage size
    let storageSizeBytes = 0;
    try {
      if (fs.existsSync(this.config.storagePath)) {
        const stats = fs.statSync(this.config.storagePath);
        storageSizeBytes = stats.size;
      }
    } catch {
      // Ignore stat errors
    }

    return {
      totalPatterns: this.patterns.size,
      highImportancePatterns: highImportance,
      avgFisherValue: this.globalFisher.length > 0 ? totalFisher / this.globalFisher.length : 0,
      maxFisherValue: maxFisher,
      consolidationCount: this.consolidationHistory.length,
      lastConsolidation:
        this.consolidationHistory.length > 0
          ? this.consolidationHistory[this.consolidationHistory.length - 1].timestamp
          : null,
      avgPenalty,
      storageSizeBytes,
    };
  },

  /**
   * Record a gradient sample for Fisher computation
   */
  recordGradient(
    this: EWCConsolidator,
    patternId: string,
    gradients: number[],
    success: boolean,
  ): void {
    this.gradientHistory.push({
      patternId,
      gradients,
      timestamp: Date.now(),
      success,
    });

    // Keep only recent gradients
    const maxGradients = this.config.maxPatterns * 2;
    if (this.gradientHistory.length > maxGradients) {
      this.gradientHistory = this.gradientHistory.slice(-maxGradients);
    }

    // Update pattern success/failure counts
    const pattern = this.patterns.get(patternId);
    if (pattern) {
      if (success) {
        pattern.successCount++;
      } else {
        pattern.failureCount++;
      }
      pattern.importance = this.calculateImportance(pattern);
    }

    // Online Fisher update from this gradient
    if (this.config.onlineMode && success) {
      const decay = this.config.fisherDecayRate;
      const len = Math.min(gradients.length, this.config.dimensions);
      for (let i = 0; i < len; i++) {
        this.globalFisher[i] =
          (1 - decay) * this.globalFisher[i] + decay * gradients[i] * gradients[i];
      }
    }

    // Schedule debounced flush so importance/Fisher updates are persisted
    this.scheduleSave();
  },

  /**
   * Get pattern weights by ID
   */
  getPatternWeights(this: EWCConsolidator, id: string): PatternWeights | undefined {
    return this.patterns.get(id);
  },

  /**
   * Get all stored patterns
   */
  getAllPatterns(this: EWCConsolidator): PatternWeights[] {
    return Array.from(this.patterns.values());
  },

  /**
   * Update EWC lambda (regularization strength)
   */
  setLambda(this: EWCConsolidator, lambda: number): void {
    this.config.lambda = lambda;
  },

  /**
   * Get current lambda value
   */
  getLambda(this: EWCConsolidator): number {
    return this.config.lambda;
  },

  /**
   * Calculate importance score for a pattern based on usage
   */
  calculateImportance(this: EWCConsolidator, pattern: PatternWeights): number {
    const total = pattern.successCount + pattern.failureCount;
    if (total === 0) return 0.5;

    // Success rate with Laplace smoothing
    const successRate = (pattern.successCount + 1) / (total + 2);

    // Recency factor: recent patterns are more important
    const hoursSinceUpdate = (Date.now() - pattern.lastUpdated) / (1000 * 60 * 60);
    const recencyFactor = Math.exp(-hoursSinceUpdate / 168); // 1 week half-life

    // Combine factors
    return successRate * 0.7 + recencyFactor * 0.3;
  },
};
