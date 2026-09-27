/**
 * monofence-ai — MonoDefence facade (config, interface, factory)
 * Split out of index.ts (file-size sweep). Pure move.
 */

import type {
  AllowlistRule,
  ContextState,
  OutputScanResult,
  ThreatDetectionResult,
  ThreatType,
} from './domain/entities/threat.js';
import { Allowlist } from './domain/services/allowlist.js';
import { ContextTracker } from './domain/services/context-tracker.js';
import { OutputScanner } from './domain/services/output-scanner.js';
// Import for internal use
import { createThreatDetectionService } from './domain/services/threat-detection-service.js';
import type {
  LearnedThreatPattern,
  MitigationStrategy,
  VectorStore,
} from './domain/services/threat-learning-service.js';
import { createThreatLearningService } from './domain/services/threat-learning-service.js';

/**
 * Configuration for MonoDefence
 */
export interface MonoDefenceConfig {
  /** Enable self-learning from detections */
  enableLearning?: boolean;
  /** Custom vector store (defaults to in-memory, use LanceDB for production) */
  vectorStore?: VectorStore;
  /** Minimum confidence threshold for threats */
  confidenceThreshold?: number;
  /** Enable PII detection */
  enablePIIDetection?: boolean;
  /** Allowlist rules to bypass detection */
  allowlistRules?: AllowlistRule[];
  /** Whether to use context tracking across turns (default: true) */
  trackContext?: boolean;
}

/**
 * MonoDefence - Unified threat detection and learning facade
 */
export interface MonoDefence {
  /**
   * Detect threats in input text
   */
  detect(input: string): Promise<ThreatDetectionResult>;

  /**
   * Quick scan for threats (faster, less detailed)
   */
  quickScan(input: string): { threat: boolean; confidence: number };

  /**
   * Check if input contains PII
   */
  hasPII(input: string): boolean;

  /**
   * Search for similar threat patterns using HNSW
   */
  searchSimilarThreats(
    query: string,
    options?: { k?: number; minSimilarity?: number },
  ): Promise<LearnedThreatPattern[]>;

  /**
   * Learn from a detection result (ReasoningBank pattern)
   */
  learnFromDetection(
    input: string,
    result: ThreatDetectionResult,
    feedback?: { wasAccurate: boolean; userVerdict?: string },
  ): Promise<void>;

  /**
   * Record mitigation effectiveness for meta-learning
   */
  recordMitigation(
    threatType: ThreatType,
    strategy: 'block' | 'sanitize' | 'warn' | 'log' | 'escalate' | 'transform' | 'redirect',
    success: boolean,
  ): Promise<void>;

  /**
   * Get best mitigation strategy based on learned effectiveness
   */
  getBestMitigation(threatType: ThreatType): Promise<MitigationStrategy | null>;

  /**
   * Start a learning trajectory session
   */
  startTrajectory(sessionId: string, task: string): void;

  /**
   * End a learning trajectory and store for future learning
   */
  endTrajectory(sessionId: string, verdict: 'success' | 'failure' | 'partial'): Promise<void>;

  /**
   * Get detection and learning statistics
   */
  getStats(): Promise<{
    detectionCount: number;
    avgDetectionTimeMs: number;
    learnedPatterns: number;
    mitigationStrategies: number;
    avgMitigationEffectiveness: number;
  }>;

  // ── New facade methods (Task 11) ──────────────────────────────────────────

  /**
   * Scan LLM output for leakage, echo, policy violations
   */
  scanOutput(output: string, originalPrompt?: string): Promise<OutputScanResult>;

  /**
   * Get current multi-turn context state
   */
  getContextState(): ContextState;

  /**
   * Reset multi-turn context (e.g., new conversation)
   */
  resetContext(): void;

  /**
   * Check whether an input is in the allowlist (bypasses detection)
   */
  isAllowed(input: string): boolean;

  /**
   * Add an allowlist rule at runtime
   */
  addAllowlistRule(rule: AllowlistRule): void;
}

/**
 * Create a MonoDefence instance
 */
export function createMonoDefence(config: MonoDefenceConfig = {}): MonoDefence {
  const detectionService = createThreatDetectionService();
  const learningService = config.enableLearning
    ? createThreatLearningService(config.vectorStore)
    : null;
  const contextTracker = new ContextTracker();
  const outputScanner = new OutputScanner();
  const allowlist = new Allowlist(config.allowlistRules);

  return {
    async detect(input: string) {
      // Short-circuit only for full-bypass rules (types: []) so that
      // rules with a types array still allow detection to run.
      if (allowlist.getMatchingRules(input).some((r) => r.types.length === 0)) {
        const safeResult: ThreatDetectionResult = {
          safe: true,
          threats: [],
          overallRisk: 0,
          detectionTimeMs: 0,
          inputHash: '',
          piiFound: false,
          wasObfuscated: false,
        };
        if (config.trackContext !== false) {
          contextTracker.recordTurn(input, safeResult);
        }
        return safeResult;
      }

      let result = detectionService.detect(input);

      // Apply per-type suppression from allowlist rules with non-empty types arrays.
      // Rules with types: [] already caused full bypass above; here we handle the selective case:
      // for each matching rule whose types is non-empty, remove detected threats of those types.
      const selectiveRules = allowlist.getMatchingRules(input).filter((r) => r.types.length > 0);
      if (selectiveRules.length > 0) {
        const suppressedTypes = new Set(selectiveRules.flatMap((r) => r.types));
        const filtered = result.threats.filter((t) => !suppressedTypes.has(t.type));
        if (filtered.length !== result.threats.length) {
          const newRisk = filtered.length > 0 ? Math.max(...filtered.map((t) => t.confidence)) : 0;
          result = {
            ...result,
            threats: filtered,
            overallRisk: newRisk,
            safe: filtered.length === 0,
          };
        }
      }

      // Apply confidence threshold — filter out threats below threshold
      if (config.confidenceThreshold != null) {
        const filtered = result.threats.filter((t) => t.confidence >= config.confidenceThreshold!);
        if (filtered.length !== result.threats.length) {
          const newRisk = filtered.length > 0 ? Math.max(...filtered.map((t) => t.confidence)) : 0;
          result = {
            ...result,
            threats: filtered,
            overallRisk: newRisk,
            safe: filtered.length === 0,
          };
        }
      }

      // Strip PII fields when PII detection is disabled
      if (config.enablePIIDetection === false) {
        const nonPiiThreats = result.threats.filter((t) => t.type !== 'pii_exposure');
        const newRisk =
          nonPiiThreats.length > 0 ? Math.max(...nonPiiThreats.map((t) => t.confidence)) : 0;
        result = {
          ...result,
          threats: nonPiiThreats,
          piiFound: false,
          overallRisk: newRisk,
          safe: nonPiiThreats.length === 0,
        };
      }

      if (config.trackContext !== false) {
        contextTracker.recordTurn(input, result);
        const ctxState = contextTracker.getState();
        if (ctxState.escalationState === 'attack' && result.safe) {
          // Soft suspicion signal: input is individually clean but session is in attack state.
          // Raises overallRisk to 0.5 while leaving safe=true and threats=[].
          // Consumers should check both safe AND overallRisk when using context tracking.
          result = { ...result, overallRisk: Math.max(result.overallRisk, 0.5) };
        }
      }

      // Auto-learn if enabled
      if (learningService && result.threats.length > 0) {
        await learningService.learnFromDetection(input, result);
      }

      return result;
    },

    quickScan(input: string) {
      return detectionService.quickScan(input);
    },

    hasPII(input: string) {
      return detectionService.detectPII(input);
    },

    async searchSimilarThreats(query, options) {
      if (!learningService) {
        return [];
      }
      return learningService.searchSimilarThreats(query, options);
    },

    async learnFromDetection(input, result, feedback) {
      if (!learningService) {
        console.warn('Learning not enabled. Pass { enableLearning: true } to createMonoDefence()');
        return;
      }
      await learningService.learnFromDetection(input, result, feedback);
    },

    async recordMitigation(threatType, strategy, success) {
      if (!learningService) return;
      await learningService.recordMitigation(threatType, strategy, success);
    },

    async getBestMitigation(threatType) {
      if (!learningService) return null;
      return learningService.getBestMitigation(threatType);
    },

    startTrajectory(sessionId, task) {
      learningService?.startTrajectory(sessionId, task);
    },

    async endTrajectory(sessionId, verdict) {
      await learningService?.endTrajectory(sessionId, verdict);
    },

    async getStats() {
      const detectionStats = detectionService.getStats();
      const learningStats = learningService
        ? await learningService.getStats()
        : { learnedPatterns: 0, mitigationStrategies: 0, avgEffectiveness: 0 };

      return {
        detectionCount: detectionStats.detectionCount,
        avgDetectionTimeMs: detectionStats.avgDetectionTimeMs,
        learnedPatterns: learningStats.learnedPatterns,
        mitigationStrategies: learningStats.mitigationStrategies,
        avgMitigationEffectiveness: learningStats.avgEffectiveness,
      };
    },

    async scanOutput(output: string, originalPrompt?: string): Promise<OutputScanResult> {
      return outputScanner.scan({ output, originalPrompt });
    },

    getContextState(): ContextState {
      return contextTracker.getState() as ContextState;
    },

    resetContext(): void {
      contextTracker.reset();
    },

    isAllowed(input: string): boolean {
      return allowlist.isAllowed(input);
    },

    addAllowlistRule(rule: AllowlistRule): void {
      allowlist.addRule(rule);
    },
  };
}
