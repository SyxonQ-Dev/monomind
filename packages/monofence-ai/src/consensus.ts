/**
 * monofence-ai — multi-agent security consensus (Monomind attention integration)
 * Split out of index.ts (file-size sweep). Pure move.
 */

import type { Threat, ThreatDetectionResult } from './domain/entities/threat.js';

/**
 * Integration with Monomind attention mechanisms
 * Use for multi-agent security consensus
 */
export interface AttentionContext {
  agentId: string;
  threatAssessment: ThreatDetectionResult;
  weight: number;
}

/**
 * Calculate security consensus from multiple agent assessments
 * Uses attention-based weighting for Monomind flash attention integration
 */
export function calculateSecurityConsensus(assessments: AttentionContext[]): {
  consensus: 'safe' | 'threat' | 'uncertain';
  confidence: number;
  criticalThreats: Threat[];
} {
  if (assessments.length === 0) {
    return { consensus: 'uncertain', confidence: 0, criticalThreats: [] };
  }

  // Normalize weights — guard against all-zero weights
  const totalWeight = assessments.reduce((sum, a) => sum + a.weight, 0);
  if (totalWeight === 0) {
    return { consensus: 'uncertain', confidence: 0, criticalThreats: [] };
  }
  const normalized = assessments.map((a) => ({
    ...a,
    weight: a.weight / totalWeight,
  }));

  // Calculate weighted threat score
  let threatScore = 0;
  const allThreats: Threat[] = [];

  for (const assessment of normalized) {
    if (!assessment.threatAssessment.safe) {
      threatScore += assessment.weight;
      allThreats.push(...assessment.threatAssessment.threats);
    }
  }

  // Determine consensus
  const criticalThreats = allThreats.filter((t) => t.severity === 'critical');

  // Critical threats short-circuit weighted scoring intentionally (fail-secure).
  // A single critical threat — regardless of that agent's weight — means we cannot
  // declare the input safe. Weight only governs uncertain/borderline cases.
  if (criticalThreats.length > 0) {
    return {
      consensus: 'threat',
      confidence: Math.max(...criticalThreats.map((t) => t.confidence)),
      criticalThreats,
    };
  }

  if (threatScore > 0.5) {
    return { consensus: 'threat', confidence: threatScore, criticalThreats: [] };
  }

  if (threatScore < 0.2) {
    return { consensus: 'safe', confidence: 1 - threatScore, criticalThreats: [] };
  }

  return { consensus: 'uncertain', confidence: 0.5, criticalThreats: [] };
}
