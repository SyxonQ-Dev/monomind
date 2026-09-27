/**
 * SONA Optimizer — shared types
 * Split out of sona-optimizer.ts (file-size sweep). Pure move.
 *
 * @module v1/cli/memory/sona-optimizer
 */

/**
 * Trajectory outcome from hooks/intelligence/trajectory-end
 */
export interface TrajectoryOutcome {
  trajectoryId: string;
  task: string;
  agent: string;
  success: boolean;
  steps?: Array<{
    action: string;
    result: string;
    quality: number;
    timestamp: string;
  }>;
  feedback?: string;
  duration?: number;
}

/**
 * Learned routing pattern
 */
export interface LearnedPattern {
  /** Keywords extracted from task descriptions */
  keywords: string[];
  /** Agent that handled the task */
  agent: string;
  /** Confidence score (0-1) */
  confidence: number;
  /** Number of successful uses */
  successCount: number;
  /** Number of failed uses */
  failureCount: number;
  /** Last time pattern was used */
  lastUsed: number;
  /** Pattern creation time */
  createdAt: number;
}

/**
 * Routing suggestion result
 */
export interface RoutingSuggestion {
  /** Recommended agent */
  agent: string;
  /** Confidence in recommendation (0-1) */
  confidence: number;
  /** Source of recommendation */
  source: 'sona-pattern' | 'keyword-match' | 'default';
  /** Alternative agents with scores */
  alternatives: Array<{ agent: string; score: number }>;
  /** Matched keywords */
  matchedKeywords?: string[];
}

/**
 * SONA optimizer statistics
 */
export interface SONAStats {
  /** Total patterns learned */
  totalPatterns: number;
  /** Successful routing decisions */
  successfulRoutings: number;
  /** Failed routing decisions */
  failedRoutings: number;
  /** Total trajectories processed */
  trajectoriesProcessed: number;
  /** Average confidence of patterns */
  avgConfidence: number;
  /** Time of last learning update */
  lastUpdate: number | null;
}

/**
 * Persisted state structure
 */
export interface PersistedState {
  version: string;
  patterns: Record<string, LearnedPattern>;
  stats: {
    trajectoriesProcessed: number;
    successfulRoutings: number;
    failedRoutings: number;
    lastUpdate: number | null;
  };
  metadata: {
    createdAt: string;
    savedAt: string;
  };
}
