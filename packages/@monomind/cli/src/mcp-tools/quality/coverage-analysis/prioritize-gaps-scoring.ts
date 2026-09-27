/**
 * prioritize-gaps-scoring.ts - Per-factor scoring and priority calculation.
 * Extracted from prioritize-gaps.ts.
 */

import type { FactorScore, InputGap, PrioritizedGap } from './prioritize-gaps-types.js';

export async function generateGapsFromPath(_targetPath: string): Promise<InputGap[]> {
  // Cannot derive real coverage gaps without running the test suite and collecting
  // an lcov/json report. Pass a coverage report via the `gaps` input instead, or
  // run `npx vitest --coverage` and feed the output to `analyze-coverage` first.
  return [];
}

export async function calculatePriorities(
  gaps: InputGap[],
  factors: string[],
  weights: Record<string, number>,
  bridge?: { searchSimilarPatterns: (q: string, k: number) => Promise<unknown[]> },
): Promise<PrioritizedGap[]> {
  const prioritizedGaps: PrioritizedGap[] = [];

  for (const gap of gaps) {
    const factorScores: FactorScore[] = [];
    let totalScore = 0;

    // Calculate each factor
    if (factors.includes('complexity')) {
      const score = calculateComplexityScore(gap);
      const contribution = score * weights.complexity;
      factorScores.push({
        factor: 'complexity',
        score,
        weight: weights.complexity,
        contribution,
        details: `Estimated complexity (line-based proxy, not McCabe): ${Math.round(score * 20)}`,
      });
      totalScore += contribution;
    }

    if (factors.includes('change-frequency')) {
      const score = calculateChangeFrequency(gap);
      const contribution = score * weights.changeFrequency;
      factorScores.push({
        factor: 'change-frequency',
        score,
        weight: weights.changeFrequency,
        contribution,
        details: `Changes in last 90 days: ${Math.round(score * 10)}`,
      });
      totalScore += contribution;
    }

    if (factors.includes('defect-history')) {
      const score = await calculateDefectHistory(gap, bridge);
      const contribution = score * weights.defectHistory;
      factorScores.push({
        factor: 'defect-history',
        score,
        weight: weights.defectHistory,
        contribution,
        details: `Historical defects: ${Math.round(score * 5)}`,
      });
      totalScore += contribution;
    }

    if (factors.includes('business-critical')) {
      const score = calculateBusinessCriticality(gap);
      const contribution = score * weights.businessCritical;
      factorScores.push({
        factor: 'business-critical',
        score,
        weight: weights.businessCritical,
        contribution,
        details: `Business impact: ${score > 0.7 ? 'high' : score > 0.4 ? 'medium' : 'low'}`,
      });
      totalScore += contribution;
    }

    if (factors.includes('dependency-count')) {
      const score = calculateDependencyScore(gap);
      const contribution = score * weights.dependencyCount;
      factorScores.push({
        factor: 'dependency-count',
        score,
        weight: weights.dependencyCount,
        contribution,
        details: `Dependents: ${Math.round(score * 15)}`,
      });
      totalScore += contribution;
    }

    if (factors.includes('test-difficulty')) {
      const score = calculateTestDifficulty(gap);
      const contribution = score * weights.testDifficulty;
      factorScores.push({
        factor: 'test-difficulty',
        score,
        weight: weights.testDifficulty,
        contribution,
        details: `Test complexity: ${score > 0.7 ? 'hard' : score > 0.4 ? 'medium' : 'easy'}`,
      });
      totalScore += contribution;
    }

    // Normalize score
    const priorityScore = Math.round(totalScore * 100) / 100;

    // Determine risk level
    const risk = scoreToRisk(priorityScore);

    // Calculate effort and ROI
    const effort = calculateEffort(gap, factorScores);
    const roi = calculateROI(priorityScore, effort);

    prioritizedGaps.push({
      id: gap.id,
      type: gap.type,
      file: gap.file,
      location: { startLine: gap.startLine, endLine: gap.endLine },
      risk,
      priorityScore,
      factors: factorScores,
      effort,
      roi,
    });
  }

  return prioritizedGaps;
}

function calculateComplexityScore(gap: InputGap): number {
  const lines = gap.endLine - gap.startLine;
  // Line-based proxy — not real McCabe cyclomatic complexity
  const estimatedComplexity = lines / 5;
  return Math.min(estimatedComplexity / 10, 1);
}

function calculateChangeFrequency(gap: InputGap): number {
  // Proxy: deeper paths in the tree tend to be more stable, shallower paths change more.
  // A real implementation would query `git log --follow -n 30 -- <file>`.
  const pathDepth = gap.file.split('/').length;
  return Math.min(pathDepth / 10, 1) * 0.8;
}

async function calculateDefectHistory(
  gap: InputGap,
  bridge?: { searchSimilarPatterns: (q: string, k: number) => Promise<unknown[]> },
): Promise<number> {
  if (bridge) {
    try {
      const patterns = await bridge.searchSimilarPatterns(`defect ${gap.file}`, 3);
      return Math.min(patterns.length / 5, 1);
    } catch {
      // Fall through to neutral score
    }
  }
  // No bridge and no historical data available — return neutral score.
  return 0;
}

function calculateBusinessCriticality(gap: InputGap): number {
  // Determine criticality based on file path
  const criticalPaths = ['auth', 'payment', 'security', 'core', 'api'];
  const pathLower = gap.file.toLowerCase();
  for (const path of criticalPaths) {
    if (pathLower.includes(path)) {
      return 0.9;
    }
  }
  return 0.3;
}

function calculateDependencyScore(gap: InputGap): number {
  // Proxy: larger code blocks tend to have more callers. Real implementation would
  // query the monograph dependency graph for actual dependent count.
  const lines = gap.endLine - gap.startLine;
  return Math.min(lines / 50, 1);
}

function calculateTestDifficulty(gap: InputGap): number {
  // Estimate test difficulty
  const lines = gap.endLine - gap.startLine;
  if (lines > 30) return 0.8;
  if (lines > 15) return 0.5;
  return 0.2;
}

function scoreToRisk(score: number): 'critical' | 'high' | 'medium' | 'low' {
  if (score >= 0.75) return 'critical';
  if (score >= 0.5) return 'high';
  if (score >= 0.25) return 'medium';
  return 'low';
}

function calculateEffort(gap: InputGap, factors: FactorScore[]): 'low' | 'medium' | 'high' {
  const lines = gap.endLine - gap.startLine;
  const difficultyFactor = factors.find((f) => f.factor === 'test-difficulty');
  const difficulty = difficultyFactor?.score ?? 0.5;

  const effortScore = (lines / 50) * 0.5 + difficulty * 0.5;
  if (effortScore > 0.7) return 'high';
  if (effortScore > 0.3) return 'medium';
  return 'low';
}

function calculateROI(priorityScore: number, effort: 'low' | 'medium' | 'high'): number {
  const effortMultiplier = { low: 3, medium: 2, high: 1 };
  return Math.round(priorityScore * effortMultiplier[effort] * 100) / 100;
}
