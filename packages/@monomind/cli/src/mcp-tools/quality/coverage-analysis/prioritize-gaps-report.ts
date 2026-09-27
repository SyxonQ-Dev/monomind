/**
 * prioritize-gaps-report.ts - Grouping, statistics, and recommendations.
 * Extracted from prioritize-gaps.ts.
 */

import type {
  GapGroup,
  PrioritizationStatistics,
  PrioritizedGap,
  Recommendation,
} from './prioritize-gaps-types.js';

export function groupGaps(gaps: PrioritizedGap[], groupBy: string): GapGroup[] {
  const groups: Map<string, PrioritizedGap[]> = new Map();

  for (const gap of gaps) {
    let key: string;
    switch (groupBy) {
      case 'risk':
        key = gap.risk;
        break;
      case 'file':
        key = gap.file;
        break;
      case 'type':
        key = gap.type;
        break;
      default:
        key = 'all';
    }

    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key)?.push(gap);
  }

  return Array.from(groups.entries()).map(([name, gapList]) => ({
    name,
    count: gapList.length,
    avgPriorityScore:
      Math.round((gapList.reduce((sum, g) => sum + g.priorityScore, 0) / gapList.length) * 100) /
      100,
    gaps: gapList,
  }));
}

export function calculateStatistics(gaps: PrioritizedGap[]): PrioritizationStatistics {
  const total = gaps.length;
  if (total === 0) {
    return {
      totalGaps: 0,
      criticalCount: 0,
      highCount: 0,
      mediumCount: 0,
      lowCount: 0,
      avgPriorityScore: 0,
      avgEffort: 'unknown',
      estimatedTestingEffort: '0 hours',
    };
  }

  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  const efforts = { low: 0, medium: 0, high: 0 };

  for (const gap of gaps) {
    counts[gap.risk]++;
    efforts[gap.effort]++;
  }

  const avgScore = gaps.reduce((sum, g) => sum + g.priorityScore, 0) / total;

  // Estimate testing effort
  const hours = efforts.low * 0.5 + efforts.medium * 2 + efforts.high * 5;

  return {
    totalGaps: total,
    criticalCount: counts.critical,
    highCount: counts.high,
    mediumCount: counts.medium,
    lowCount: counts.low,
    avgPriorityScore: Math.round(avgScore * 100) / 100,
    avgEffort:
      efforts.high > efforts.medium && efforts.high > efforts.low
        ? 'high'
        : efforts.medium > efforts.low
          ? 'medium'
          : 'low',
    estimatedTestingEffort: `${Math.round(hours)} hours`,
  };
}

export function generateRecommendations(
  gaps: PrioritizedGap[],
  _stats: PrioritizationStatistics,
): Recommendation[] {
  const recommendations: Recommendation[] = [];

  // Immediate action for critical gaps
  const criticalGaps = gaps.filter((g) => g.risk === 'critical');
  if (criticalGaps.length > 0) {
    recommendations.push({
      type: 'immediate-action',
      priority: 1,
      description: `Address ${criticalGaps.length} critical coverage gaps immediately`,
      affectedGaps: criticalGaps.map((g) => g.id),
      expectedImpact: 'Significant risk reduction',
    });
  }

  // High ROI opportunities
  const highROI = gaps.filter((g) => g.roi > 1).slice(0, 5);
  if (highROI.length > 0) {
    recommendations.push({
      type: 'short-term',
      priority: 2,
      description: `Focus on ${highROI.length} high-ROI gaps for maximum coverage impact`,
      affectedGaps: highROI.map((g) => g.id),
      expectedImpact: 'Best coverage improvement per effort invested',
    });
  }

  // Long-term refactoring
  const complexGaps = gaps.filter((g) => g.effort === 'high');
  if (complexGaps.length > 3) {
    recommendations.push({
      type: 'long-term',
      priority: 3,
      description: `Consider refactoring ${complexGaps.length} complex areas before testing`,
      affectedGaps: complexGaps.slice(0, 5).map((g) => g.id),
      expectedImpact: 'Improved testability and maintainability',
    });
  }

  return recommendations;
}
