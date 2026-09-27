/**
 * detect-secrets-report.ts - Summary, grouping, and recommendation generation
 * for the detect-secrets MCP tool handler.
 */

import type {
  DetectionSummary,
  SecretFinding,
  SecretRecommendation,
  TypeSummary,
} from './detect-secrets-types.js';

export function calculateSummary(findings: SecretFinding[]): DetectionSummary {
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };

  for (const finding of findings) {
    counts[finding.severity]++;
  }

  const files = new Set(findings.map((f) => f.location.file));
  const verifiedCount = findings.filter((f) => f.verified).length;

  // Calculate risk score
  const riskScore = Math.max(
    0,
    100 - (counts.critical * 25 + counts.high * 15 + counts.medium * 5 + counts.low * 2),
  );

  return {
    totalFindings: findings.length,
    criticalCount: counts.critical,
    highCount: counts.high,
    mediumCount: counts.medium,
    lowCount: counts.low,
    verifiedCount,
    filesAffected: files.size,
    riskScore,
  };
}

export function groupByType(findings: SecretFinding[]): TypeSummary[] {
  const groups: Map<string, SecretFinding[]> = new Map();

  for (const finding of findings) {
    if (!groups.has(finding.type)) {
      groups.set(finding.type, []);
    }
    groups.get(finding.type)?.push(finding);
  }

  return Array.from(groups.entries()).map(([type, typeFindings]) => ({
    type,
    count: typeFindings.length,
    severity: typeFindings[0].severity,
    files: [...new Set(typeFindings.map((f) => f.location.file))],
  }));
}

export function generateRecommendations(
  findings: SecretFinding[],
  _byType: TypeSummary[],
): SecretRecommendation[] {
  const recommendations: SecretRecommendation[] = [];
  let priority = 1;

  // Critical secrets first
  const criticalFindings = findings.filter((f) => f.severity === 'critical');
  if (criticalFindings.length > 0) {
    recommendations.push({
      priority: priority++,
      action: 'Immediately rotate all critical credentials (AWS keys, private keys)',
      affectedSecrets: criticalFindings.map((f) => f.id),
      effort: 'high',
      automatable: false,
    });
  }

  // Active secrets
  const activeFindings = findings.filter((f) => f.active);
  if (activeFindings.length > 0) {
    recommendations.push({
      priority: priority++,
      action: 'Revoke active secrets and regenerate with proper storage',
      affectedSecrets: activeFindings.map((f) => f.id),
      effort: 'medium',
      automatable: false,
    });
  }

  // General recommendations
  recommendations.push(
    {
      priority: priority++,
      action: 'Implement pre-commit hooks to prevent future secret commits',
      affectedSecrets: findings.map((f) => f.id),
      effort: 'low',
      automatable: true,
    },
    {
      priority: priority++,
      action: 'Set up secrets management solution (HashiCorp Vault, AWS Secrets Manager)',
      affectedSecrets: findings.map((f) => f.id),
      effort: 'medium',
      automatable: true,
    },
    {
      priority: priority++,
      action: 'Audit git history for exposed secrets using git-secrets or truffleHog',
      affectedSecrets: [],
      effort: 'low',
      automatable: true,
    },
  );

  return recommendations;
}
