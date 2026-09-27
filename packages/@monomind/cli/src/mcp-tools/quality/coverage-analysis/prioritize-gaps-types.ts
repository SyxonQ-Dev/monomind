/**
 * prioritize-gaps-types.ts - Input/output schema and types for prioritize-gaps.
 * Extracted from prioritize-gaps.ts.
 */

import { z } from 'zod';

// Input schema for prioritize-gaps tool
export const PrioritizeGapsInputSchema = z.object({
  gaps: z
    .array(
      z.object({
        id: z.string(),
        type: z.enum(['line', 'branch', 'function']),
        file: z.string(),
        startLine: z.number(),
        endLine: z.number(),
      }),
    )
    .optional()
    .describe('Pre-analyzed gaps (or will analyze from targetPath)'),
  targetPath: z.string().optional().describe('Path to analyze if gaps not provided'),
  factors: z
    .array(
      z.enum([
        'complexity',
        'change-frequency',
        'defect-history',
        'business-critical',
        'dependency-count',
        'test-difficulty',
      ]),
    )
    .default(['complexity', 'change-frequency', 'defect-history'])
    .describe('Prioritization factors'),
  weights: z
    .object({
      complexity: z.number().min(0).max(1).default(0.25),
      changeFrequency: z.number().min(0).max(1).default(0.25),
      defectHistory: z.number().min(0).max(1).default(0.2),
      businessCritical: z.number().min(0).max(1).default(0.15),
      dependencyCount: z.number().min(0).max(1).default(0.1),
      testDifficulty: z.number().min(0).max(1).default(0.05),
    })
    .optional()
    .describe('Custom weights for prioritization factors'),
  limit: z.number().min(1).max(100).default(20).describe('Maximum gaps to return'),
  groupBy: z
    .enum(['risk', 'file', 'type', 'none'])
    .default('risk')
    .describe('How to group the results'),
});

export type PrioritizeGapsInput = z.infer<typeof PrioritizeGapsInputSchema>;

// Output structures
export interface PrioritizeGapsOutput {
  success: boolean;
  prioritizedGaps: PrioritizedGap[];
  groups: GapGroup[];
  statistics: PrioritizationStatistics;
  recommendations: Recommendation[];
  metadata: PrioritizationMetadata;
}

export interface PrioritizedGap {
  id: string;
  type: 'line' | 'branch' | 'function';
  file: string;
  location: { startLine: number; endLine: number };
  risk: 'critical' | 'high' | 'medium' | 'low';
  priorityScore: number;
  factors: FactorScore[];
  effort: 'low' | 'medium' | 'high';
  roi: number; // Return on investment for testing this gap
}

export interface FactorScore {
  factor: string;
  score: number;
  weight: number;
  contribution: number;
  details: string;
}

export interface GapGroup {
  name: string;
  count: number;
  avgPriorityScore: number;
  gaps: PrioritizedGap[];
}

export interface PrioritizationStatistics {
  totalGaps: number;
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  avgPriorityScore: number;
  avgEffort: string;
  estimatedTestingEffort: string;
}

export interface Recommendation {
  type: 'immediate-action' | 'short-term' | 'long-term';
  priority: number;
  description: string;
  affectedGaps: string[];
  expectedImpact: string;
}

export interface PrioritizationMetadata {
  analyzedAt: string;
  durationMs: number;
  factorsUsed: string[];
  weightsApplied: Record<string, number>;
}

// Tool context interface
export interface ToolContext {
  get<T>(key: string): T | undefined;
}

// Input gap type
export interface InputGap {
  id: string;
  type: 'line' | 'branch' | 'function';
  file: string;
  startLine: number;
  endLine: number;
}

// Default weights
export const DEFAULT_WEIGHTS = {
  complexity: 0.25,
  changeFrequency: 0.25,
  defectHistory: 0.2,
  businessCritical: 0.15,
  dependencyCount: 0.1,
  testDifficulty: 0.05,
};
