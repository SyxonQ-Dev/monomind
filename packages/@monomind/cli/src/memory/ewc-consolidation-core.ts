/**
 * Core consolidation logic for EWCConsolidator (consolidate/blend/prune).
 * File-size sweep: split out of ewc-consolidation.ts. Mixed into
 * EWCConsolidator.prototype at the bottom of ewc-consolidation.ts.
 *
 * @module v1/cli/memory/ewc-consolidation-core
 */

import type { EWCConsolidator } from './ewc-consolidation.js';
import type { ConsolidationResult, PatternWeights } from './ewc-consolidation-types.js';

export const ewcCoreMethods = {
  /**
   * Consolidate new patterns with old patterns without forgetting
   * Applies EWC penalty to preserve important weights
   *
   * @param newPatterns - New patterns to incorporate
   * @param oldPatterns - Existing patterns to preserve
   * @returns Consolidated patterns with modified weights
   */
  consolidate(
    this: EWCConsolidator,
    newPatterns: { id: string; embedding: number[]; type: string; description?: string }[],
    oldPatterns?: PatternWeights[],
  ): ConsolidationResult {
    const startTime = performance.now();
    const result: ConsolidationResult = {
      success: false,
      patternsConsolidated: 0,
      totalPenalty: 0,
      modifiedPatterns: [],
      protectedPatterns: [],
      duration: 0,
    };

    try {
      // Use stored patterns if no old patterns provided
      const existingPatterns = oldPatterns || Array.from(this.patterns.values());

      // Compute Fisher from successful existing patterns
      const fisherInput = existingPatterns
        .filter((p) => p.successCount > p.failureCount)
        .map((p) => ({
          id: p.id,
          embedding: p.weights,
          success: true,
        }));

      const fisher = this.computeFisherMatrix(fisherInput);

      // Process each new pattern
      for (const newPattern of newPatterns) {
        if (!newPattern.embedding || newPattern.embedding.length === 0) continue;
        // Cap pattern ID length: unbounded IDs fill both the Map key and the
        // modifiedPatterns/protectedPatterns result arrays without any limit.
        const patternId =
          typeof newPattern.id === 'string'
            ? newPattern.id.slice(0, 256)
            : String(newPattern.id).slice(0, 256);

        const existingPattern = this.patterns.get(patternId);

        if (existingPattern) {
          // Calculate EWC penalty for updating existing pattern
          const penalty = this.getPenalty(existingPattern.weights, newPattern.embedding, fisher);

          // Determine if update is allowed based on penalty
          const importanceScore = this.calculateImportance(existingPattern);

          if (importanceScore > this.config.importanceThreshold && penalty > this.config.lambda) {
            // Protect high-importance patterns with high penalty
            result.protectedPatterns.push(patternId);

            // Apply constrained update: blend old and new based on importance
            const blendFactor = 1 - importanceScore;
            const blendedWeights = this.blendWeights(
              existingPattern.weights,
              newPattern.embedding,
              blendFactor,
              fisher,
            );

            existingPattern.weights = blendedWeights;
            existingPattern.lastUpdated = Date.now();
            result.modifiedPatterns.push(patternId);
          } else {
            // Low importance or low penalty: allow full update
            existingPattern.weights = newPattern.embedding.slice(0, this.config.dimensions);
            existingPattern.lastUpdated = Date.now();
            result.modifiedPatterns.push(patternId);
          }

          // Update Fisher diagonal for this pattern
          existingPattern.fisherDiagonal = fisher;
          result.totalPenalty += penalty;
        } else {
          // New pattern: add directly
          const weights: PatternWeights = {
            id: patternId,
            weights: newPattern.embedding.slice(0, this.config.dimensions),
            fisherDiagonal: fisher,
            importance: 0.5,
            successCount: 0,
            failureCount: 0,
            lastUpdated: Date.now(),
            type: newPattern.type,
            description: newPattern.description,
          };

          this.patterns.set(patternId, weights);
          result.modifiedPatterns.push(patternId);
        }

        result.patternsConsolidated++;
      }

      // Prune old patterns if exceeding limit
      if (this.patterns.size > this.config.maxPatterns) {
        this.pruneOldPatterns();
      }

      // Record consolidation
      this.consolidationHistory.push({
        timestamp: Date.now(),
        penalty: result.totalPenalty,
        patterns: result.patternsConsolidated,
      });
      if (this.consolidationHistory.length > 100) {
        this.consolidationHistory = this.consolidationHistory.slice(-100);
      }

      // Schedule debounced disk flush
      this.scheduleSave();

      result.success = true;
      result.duration = performance.now() - startTime;

      return result;
    } catch (error) {
      // Sanitize: strip filesystem paths and cap length so internal error
      // messages are not reflected verbatim into CallerResult.error.
      const rawMsg = error instanceof Error ? error.message : String(error);
      result.error = rawMsg.replace(/\/[^\s:]+(\/|(?=\s|:|$))/g, '<path>/').slice(0, 500);
      result.duration = performance.now() - startTime;
      return result;
    }
  },

  /**
   * Blend old and new weights using Fisher-weighted interpolation
   */
  blendWeights(
    this: EWCConsolidator,
    oldWeights: number[],
    newWeights: number[],
    blendFactor: number,
    fisher: number[],
  ): number[] {
    const len = Math.min(oldWeights.length, newWeights.length, this.config.dimensions);
    const result = new Array(len);

    // Normalize Fisher for per-weight blend factors
    let maxF = 0;
    for (let i = 0; i < len; i++) {
      if (fisher[i] > maxF) maxF = fisher[i];
    }
    const normFactor = maxF > 0 ? 1 / maxF : 1;

    for (let i = 0; i < len; i++) {
      // Higher Fisher = more weight on old value
      const fisherWeight = fisher[i] * normFactor;
      const adjustedBlend = blendFactor * (1 - fisherWeight * 0.5);

      result[i] = oldWeights[i] * (1 - adjustedBlend) + newWeights[i] * adjustedBlend;
    }

    return result;
  },

  /**
   * Prune old, low-importance patterns to stay within limit
   */
  pruneOldPatterns(this: EWCConsolidator): void {
    if (this.patterns.size <= this.config.maxPatterns) return;

    // Sort by importance (ascending)
    const sortedPatterns = Array.from(this.patterns.entries())
      .map(([id, pattern]) => ({ id, importance: this.calculateImportance(pattern) }))
      .sort((a, b) => a.importance - b.importance);

    // Remove lowest importance patterns
    const toRemove = this.patterns.size - this.config.maxPatterns;
    for (let i = 0; i < toRemove; i++) {
      this.patterns.delete(sortedPatterns[i].id);
    }
  },
};
