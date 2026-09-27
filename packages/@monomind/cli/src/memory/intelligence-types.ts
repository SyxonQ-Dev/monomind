/**
 * V1 Intelligence Module — shared types
 * Split out of intelligence.ts (file-size sweep). Pure move.
 *
 * @module v1/cli/intelligence
 */

// ============================================================================
// Types
// ============================================================================

export interface SonaConfig {
  instantLoopEnabled: boolean;
  backgroundLoopEnabled: boolean;
  confidenceLearningRate: number;
  ewcLambda: number;
  maxTrajectorySize: number;
  patternThreshold: number;
  maxSignals: number;
  maxPatterns: number;
}

export interface TrajectoryStep {
  type: 'observation' | 'thought' | 'action' | 'result';
  content: string;
  embedding?: number[];
  metadata?: Record<string, unknown>;
  timestamp?: number;
}

export interface Pattern {
  id: string;
  type: string;
  embedding: number[];
  content: string;
  confidence: number;
  usageCount: number;
  createdAt: number;
  lastUsedAt: number;
}

export interface IntelligenceStats {
  sonaEnabled: boolean;
  reasoningBankSize: number;
  patternsLearned: number;
  trajectoriesRecorded: number;
  lastAdaptation: number | null;
  avgAdaptationTime: number;
}

export interface Signal {
  type: string;
  content: string;
  embedding: number[];
  metadata?: Record<string, unknown>;
  timestamp: number;
}

export interface StoredPattern {
  id: string;
  type: string;
  embedding: number[];
  content: string;
  confidence: number;
  usageCount: number;
  createdAt: number;
  lastUsedAt: number;
  metadata?: Record<string, unknown>;
}
