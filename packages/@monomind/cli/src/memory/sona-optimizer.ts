/**
 * SONA Optimizer
 *
 * Processes trajectory outcomes to learn optimal routing patterns.
 * Integrates with keyword router and persistence layer.
 *
 * Features:
 * - Processes trajectory outcomes from hooksTrajectoryEnd
 * - Extracts keywords from tasks for pattern matching
 * - Maintains learned routing patterns with confidence scoring
 * - Persists patterns to .swarm/sona-patterns.json
 *
 * File-size sweep: split into sibling modules (sona-optimizer-types.ts,
 * sona-optimizer-keywords.ts, sona-optimizer-singleton.ts). This file remains
 * the entry point and re-exports everything that used to live here so every
 * existing import keeps working.
 * @module v1/cli/memory/sona-optimizer
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  CONFIDENCE_DECREMENT,
  CONFIDENCE_INCREMENT,
  createPatternKey,
  DECAY_RATE,
  DEFAULT_PERSISTENCE_PATH,
  extractKeywords,
  getAlternatives,
  MAX_CONFIDENCE,
  MAX_PATTERNS,
  MIN_CONFIDENCE,
  matchKeywordsToAgent,
  PATTERN_VERSION,
  validatePattern,
} from './sona-optimizer-keywords.js';
import type {
  LearnedPattern,
  PersistedState,
  RoutingSuggestion,
  SONAStats,
  TrajectoryOutcome,
} from './sona-optimizer-types.js';

// ============================================================================
// SONAOptimizer Class
// ============================================================================

/**
 * SONA Optimizer for adaptive routing based on trajectory outcomes
 *
 * Learns from past task outcomes to improve future routing decisions.
 */
export class SONAOptimizer {
  private patterns: Map<string, LearnedPattern> = new Map();
  private trajectoriesProcessed = 0;
  private successfulRoutings = 0;
  private failedRoutings = 0;
  private lastUpdate: number | null = null;
  private persistencePath: string;
  /** Set when in-memory state diverges from disk — triggers next debounced write */
  private dirty = false;
  /** NodeJS timeout handle for debounced disk flush */
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** Debounce window for disk writes (ms) — batches rapid trajectory bursts */
  private static readonly SAVE_DEBOUNCE_MS = 2_000;

  constructor(options?: { persistencePath?: string }) {
    this.persistencePath = options?.persistencePath || DEFAULT_PERSISTENCE_PATH;
  }

  /**
   * Initialize the optimizer and load persisted state
   */
  async initialize(): Promise<{ success: boolean; patternsLoaded: number }> {
    // Load persisted patterns
    const loaded = this.loadFromDisk();

    return {
      success: true,
      patternsLoaded: loaded ? this.patterns.size : 0,
    };
  }

  /**
   * Process a trajectory outcome and learn from it
   * Called by hooksTrajectoryEnd
   */
  processTrajectoryOutcome(outcome: TrajectoryOutcome): {
    learned: boolean;
    patternKey: string;
    confidence: number;
    keywordsExtracted: string[];
  } {
    const { task, agent, success } = outcome;

    // Extract keywords from task
    const keywords = extractKeywords(task);
    if (keywords.length === 0) {
      return {
        learned: false,
        patternKey: '',
        confidence: 0,
        keywordsExtracted: [],
      };
    }

    // Create pattern key from sorted keywords
    const patternKey = createPatternKey(keywords, agent);

    // Get or create pattern
    let pattern = this.patterns.get(patternKey);
    if (!pattern) {
      pattern = {
        keywords,
        agent,
        confidence: 0.5, // Start at neutral
        successCount: 0,
        failureCount: 0,
        lastUsed: Date.now(),
        createdAt: Date.now(),
      };
    }

    // Update pattern based on outcome
    if (success) {
      pattern.successCount++;
      pattern.confidence = Math.min(
        MAX_CONFIDENCE,
        pattern.confidence + CONFIDENCE_INCREMENT * (1 - pattern.confidence),
      );
      this.successfulRoutings++;
    } else {
      pattern.failureCount++;
      pattern.confidence = Math.max(
        MIN_CONFIDENCE,
        pattern.confidence - CONFIDENCE_DECREMENT * pattern.confidence,
      );
      this.failedRoutings++;
    }

    pattern.lastUsed = Date.now();

    // Store pattern
    this.patterns.set(patternKey, pattern);
    this.trajectoriesProcessed++;
    this.lastUpdate = Date.now();

    // Prune old patterns if needed
    this.prunePatterns();

    // Mark dirty and schedule a debounced write
    this.scheduleSave();

    return {
      learned: true,
      patternKey,
      confidence: pattern.confidence,
      keywordsExtracted: keywords,
    };
  }

  /**
   * Get routing suggestion based on learned patterns
   */
  getRoutingSuggestion(task: string): RoutingSuggestion {
    const keywords = extractKeywords(task);

    // Try SONA pattern matching first
    const sonaResult = this.findBestPatternMatch(keywords);
    if (sonaResult && sonaResult.confidence >= 0.6) {
      return {
        agent: sonaResult.agent,
        confidence: sonaResult.confidence,
        source: 'sona-pattern',
        alternatives: getAlternatives(keywords, sonaResult.agent),
        matchedKeywords: sonaResult.matchedKeywords,
      };
    }

    // Fallback to keyword-based heuristic
    const keywordMatch = matchKeywordsToAgent(keywords);
    if (keywordMatch) {
      return {
        agent: keywordMatch.agent,
        confidence: keywordMatch.confidence,
        source: 'keyword-match',
        alternatives: getAlternatives(keywords, keywordMatch.agent),
        matchedKeywords: keywordMatch.matchedKeywords,
      };
    }

    // Default fallback
    return {
      agent: 'coder',
      confidence: 0.3,
      source: 'default',
      alternatives: [
        { agent: 'researcher', score: 0.2 },
        { agent: 'architect', score: 0.15 },
      ],
    };
  }

  /**
   * Get optimizer statistics
   */
  getStats(): SONAStats {
    let totalConfidence = 0;
    for (const pattern of this.patterns.values()) {
      totalConfidence += pattern.confidence;
    }

    return {
      totalPatterns: this.patterns.size,
      successfulRoutings: this.successfulRoutings,
      failedRoutings: this.failedRoutings,
      trajectoriesProcessed: this.trajectoriesProcessed,
      avgConfidence: this.patterns.size > 0 ? totalConfidence / this.patterns.size : 0,
      lastUpdate: this.lastUpdate,
    };
  }

  /**
   * Apply temporal decay to pattern confidence
   * Reduces confidence of unused patterns
   */
  applyTemporalDecay(): number {
    const now = Date.now();
    let decayed = 0;

    for (const [key, pattern] of this.patterns) {
      const daysSinceUse = (now - pattern.lastUsed) / (1000 * 60 * 60 * 24);
      if (daysSinceUse > 1) {
        const decay = Math.exp(-DECAY_RATE * daysSinceUse);
        const newConfidence = pattern.confidence * decay;

        if (newConfidence < MIN_CONFIDENCE) {
          // Remove patterns with very low confidence
          this.patterns.delete(key);
        } else {
          pattern.confidence = newConfidence;
        }
        decayed++;
      }
    }

    if (decayed > 0) {
      this.scheduleSave();
    }

    return decayed;
  }

  /**
   * Reset all learned patterns
   */
  reset(): void {
    this.patterns.clear();
    this.trajectoriesProcessed = 0;
    this.successfulRoutings = 0;
    this.failedRoutings = 0;
    this.lastUpdate = null;

    // Flush immediately on explicit reset (don't wait for debounce)
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.dirty = false;
    this.saveToDisk();
  }

  /**
   * Export patterns for analysis
   */
  exportPatterns(): Record<string, LearnedPattern> {
    const result: Record<string, LearnedPattern> = {};
    for (const [key, pattern] of this.patterns) {
      result[key] = { ...pattern };
    }
    return result;
  }

  /**
   * Import patterns (for migration or testing)
   */
  importPatterns(patterns: Record<string, LearnedPattern>): number {
    let imported = 0;
    for (const [key, pattern] of Object.entries(patterns)) {
      if (validatePattern(pattern)) {
        this.patterns.set(key, pattern);
        imported++;
      }
    }
    if (imported > 0) this.scheduleSave();
    return imported;
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * Find the best matching pattern for given keywords
   */
  private findBestPatternMatch(keywords: string[]): {
    agent: string;
    confidence: number;
    matchedKeywords: string[];
  } | null {
    if (keywords.length === 0 || this.patterns.size === 0) {
      return null;
    }

    let bestMatch: { agent: string; confidence: number; matchedKeywords: string[] } | null = null;
    let bestScore = 0;

    for (const pattern of this.patterns.values()) {
      const matchedKeywords = pattern.keywords.filter((k) => keywords.includes(k));
      const matchRatio =
        matchedKeywords.length / Math.max(pattern.keywords.length, keywords.length);

      // Combine match ratio with confidence
      const score = matchRatio * pattern.confidence;

      if (score > bestScore && matchedKeywords.length >= 1) {
        bestScore = score;
        bestMatch = {
          agent: pattern.agent,
          confidence: pattern.confidence * matchRatio,
          matchedKeywords,
        };
      }
    }

    return bestMatch;
  }

  /**
   * Prune old/low-confidence patterns if over limit
   */
  private prunePatterns(): void {
    if (this.patterns.size <= MAX_PATTERNS) {
      return;
    }

    // Sort patterns by score (confidence * recency)
    const entries = Array.from(this.patterns.entries()).map(([key, pattern]) => {
      const ageInDays = (Date.now() - pattern.lastUsed) / (1000 * 60 * 60 * 24);
      const recency = Math.exp(-0.1 * ageInDays);
      const score = pattern.confidence * recency;
      return { key, pattern, score };
    });

    entries.sort((a, b) => a.score - b.score);

    // Remove lowest-scoring patterns
    const toRemove = entries.slice(0, entries.length - Math.floor(MAX_PATTERNS * 0.8));
    for (const { key } of toRemove) {
      this.patterns.delete(key);
    }
  }

  /**
   * Load patterns from disk
   */
  private loadFromDisk(): boolean {
    try {
      const fullPath = join(process.cwd(), this.persistencePath);
      if (!existsSync(fullPath)) {
        return false;
      }
      if (statSync(fullPath).size > 50 * 1024 * 1024) return false;

      const data = readFileSync(fullPath, 'utf-8');
      const state: PersistedState = JSON.parse(data);

      // Validate version
      if (!state.version?.startsWith('1.')) {
        console.error('[SONA] Incompatible state version, starting fresh');
        return false;
      }

      // Load patterns — also cap key length so a crafted state file cannot
      // store arbitrarily long keys that bloat the in-memory Map. The key is
      // an agent:keyword string; 512 chars is ample for any real value.
      this.patterns.clear();
      for (const [key, pattern] of Object.entries(state.patterns)) {
        if (typeof key !== 'string' || key.length > 512) continue;
        if (validatePattern(pattern)) {
          this.patterns.set(key, pattern);
        }
      }

      // Load stats
      if (state.stats) {
        this.trajectoriesProcessed = state.stats.trajectoriesProcessed || 0;
        this.successfulRoutings = state.stats.successfulRoutings || 0;
        this.failedRoutings = state.stats.failedRoutings || 0;
        this.lastUpdate = state.stats.lastUpdate || null;
      }

      return true;
    } catch (err) {
      // Strip filesystem paths from error before logging to prevent path disclosure
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[SONA] Failed to load state: ${msg.replace(/\/[^\s:]+(\/|(?=\s|:|$))/g, '<path>/').slice(0, 200)}`,
      );
      return false;
    }
  }

  /**
   * Schedule a debounced disk flush.
   * Multiple calls within SAVE_DEBOUNCE_MS coalesce into a single write,
   * preventing blocking I/O on every trajectory event during swarm bursts.
   */
  private scheduleSave(): void {
    this.dirty = true;
    if (this.saveTimer) return; // already pending
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      if (this.dirty) {
        this.dirty = false;
        this.saveToDisk();
      }
    }, SONAOptimizer.SAVE_DEBOUNCE_MS);
    // Allow the process to exit without waiting for the timer
    if (this.saveTimer.unref) this.saveTimer.unref();
  }

  /**
   * Save patterns to disk
   */
  private saveToDisk(): boolean {
    try {
      const fullPath = join(process.cwd(), this.persistencePath);
      const dir = dirname(fullPath);

      // Ensure directory exists
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      const state: PersistedState = {
        version: PATTERN_VERSION,
        patterns: this.exportPatterns(),
        stats: {
          trajectoriesProcessed: this.trajectoriesProcessed,
          successfulRoutings: this.successfulRoutings,
          failedRoutings: this.failedRoutings,
          lastUpdate: this.lastUpdate,
        },
        metadata: {
          createdAt: new Date().toISOString(),
          savedAt: new Date().toISOString(),
        },
      };

      const tmp = `${fullPath}.tmp`;
      writeFileSync(tmp, JSON.stringify(state, null, 2));
      renameSync(tmp, fullPath);
      return true;
    } catch (err) {
      // Strip filesystem paths from error before logging to prevent path disclosure
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[SONA] Failed to save state: ${msg.replace(/\/[^\s:]+(\/|(?=\s|:|$))/g, '<path>/').slice(0, 200)}`,
      );
      return false;
    }
  }
}

// ============================================================================
// Re-exports (file-size sweep — see module header)
// ============================================================================

export {
  default,
  getSONAOptimizer,
  getSONAStats,
  getSuggestion,
  processTrajectory,
  resetSONAOptimizer,
} from './sona-optimizer-singleton.js';
export type {
  LearnedPattern,
  RoutingSuggestion,
  SONAStats,
  TrajectoryOutcome,
} from './sona-optimizer-types.js';
