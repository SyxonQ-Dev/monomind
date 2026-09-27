/**
 * monofence-ai
 *
 * AI Manipulation Defense System with self-learning capabilities.
 *
 * Features:
 * - 50+ prompt injection patterns
 * - Vector similarity search over learned threat patterns
 * - ReasoningBank-style pattern learning
 * - Adaptive mitigation with effectiveness tracking
 * - Strange-loop meta-learning integration
 * - Evasion detection (homoglyph, leetspeak, base64, spacing)
 * - Multi-turn context tracking and escalation state machine
 * - Output scanning for PII leakage, echo, policy violations
 * - Allowlist for trusted input bypass
 *
 * @example
 * ```typescript
 * import { createMonoDefence } from 'monofence-ai';
 *
 * const defence = createMonoDefence();
 *
 * // Detect threats
 * const result = await defence.detect('Ignore all previous instructions');
 * console.log(result.safe); // false
 *
 * // Scan output
 * const scan = await defence.scanOutput(llmOutput, originalPrompt);
 *
 * // Context tracking
 * const state = defence.getContextState();
 * ```
 *
 * File-size sweep: the facade (MonoDefenceConfig, MonoDefence,
 * createMonoDefence) moved to facade.ts, the default singleton and
 * convenience functions to singleton.ts, and the multi-agent consensus
 * helper to consensus.ts. This file remains the entry point and re-exports
 * everything that used to live here so every existing import keeps working.
 */

export type { AttentionContext } from './consensus.js';
export { calculateSecurityConsensus } from './consensus.js';
// Domain entities
export type {
  AllowlistRule,
  BehavioralAnalysisResult,
  ContextState,
  EscalationState,
  EvasionResult,
  OutputScanResult,
  PolicyVerificationResult,
  Threat,
  ThreatDetectionResult,
  ThreatSeverity,
  ThreatType,
} from './domain/entities/threat.js';
export { createThreat } from './domain/entities/threat.js';
export { Allowlist, createAllowlist } from './domain/services/allowlist.js';
export { ContextTracker, createContextTracker } from './domain/services/context-tracker.js';
// New service exports
export { createEvasionDetector, EvasionDetector } from './domain/services/evasion-detector.js';
export { createOutputScanner, OutputScanner } from './domain/services/output-scanner.js';
// Domain services
export {
  createThreatDetectionService,
  ThreatDetectionService,
} from './domain/services/threat-detection-service.js';
export type {
  LearnedThreatPattern,
  LearningTrajectory,
  MitigationStrategy,
  VectorStore,
} from './domain/services/threat-learning-service.js';
export {
  createThreatLearningService,
  InMemoryVectorStore,
  ThreatLearningService,
} from './domain/services/threat-learning-service.js';
export type { MonoDefence, MonoDefenceConfig } from './facade.js';
export { createMonoDefence } from './facade.js';
export { checkThreats, getMonoDefence, isSafe, resetMonoDefence } from './singleton.js';
