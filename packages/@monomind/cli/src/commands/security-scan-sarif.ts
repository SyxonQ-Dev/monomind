import * as monograph from '@monoes/monograph';

// ─── SARIF adapter ───────────────────────────────────────────────────────────

export interface SarifHealthFinding {
  filePath: string;
  functionName: string;
  startLine: number;
  endLine: number;
  ruleId: string;
  message: string;
  severity: 'error' | 'warning' | 'note';
}

export interface SarifRule {
  id: string;
  name: string;
  shortDescription: { text: string };
  fullDescription: { text: string };
  helpUri?: string;
}

export interface SarifResult {
  ruleId: string;
  level: 'error' | 'warning' | 'note';
  message: { text: string };
  locations: Array<{
    physicalLocation: {
      artifactLocation: { uri: string };
      region?: { startLine: number; endLine?: number };
    };
  }>;
}

export interface SarifDocument {
  $schema: string;
  version: '2.1.0';
  runs: [
    {
      tool: { driver: { name: string; version: string; rules: SarifRule[] } };
      results: SarifResult[];
    },
  ];
}

const SARIF_HEALTH_RULES: SarifRule[] = [
  {
    id: 'complexity/cyclomatic',
    name: 'High Cyclomatic Complexity',
    shortDescription: { text: 'Function exceeds cyclomatic complexity threshold' },
    fullDescription: {
      text: 'Cyclomatic complexity indicates the number of linearly independent paths through a function.',
    },
  },
  {
    id: 'complexity/cognitive',
    name: 'High Cognitive Complexity',
    shortDescription: { text: 'Function exceeds cognitive complexity threshold' },
    fullDescription: {
      text: 'Cognitive complexity measures how difficult a function is to understand.',
    },
  },
  {
    id: 'complexity/crap',
    name: 'High CRAP Score',
    shortDescription: {
      text: 'Function has a high CRAP score due to complexity and low coverage',
    },
    fullDescription: { text: 'CRAP = cyclomatic^2 * (1 - coverage/100)^3 + cyclomatic' },
  },
];

/**
 * Fallback SARIF generator when @monoes/monograph does not export exportHealthSarif
 * (e.g. published @monoes/monograph@1.5.8 packaging bug).
 */
export function exportHealthSarifFallback(
  findings: SarifHealthFinding[],
  root?: string,
): SarifDocument {
  const results: SarifResult[] = findings.map((f) => ({
    ruleId: f.ruleId,
    message: { text: f.message },
    level: f.severity === 'error' ? 'error' : f.severity === 'warning' ? 'warning' : 'note',
    locations: [
      {
        physicalLocation: {
          artifactLocation: {
            uri: root ? f.filePath.replace(root, '').replace(/^\//, '') : f.filePath,
          },
          region: { startLine: f.startLine, endLine: f.endLine },
        },
      },
    ],
  }));

  return {
    $schema:
      'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'monograph-health',
            version: '1.5.8',
            rules: SARIF_HEALTH_RULES,
          },
        },
        results,
      },
    ],
  };
}

/**
 * Formats findings into a SARIF 2.1.0 document. Delegates to @monoes/monograph's
 * real exporter when available, otherwise safely falls back to built-in exporter.
 */
export function exportHealthSarif(findings: SarifHealthFinding[], root?: string): SarifDocument {
  const maybeExporter = (monograph as Record<string, unknown>).exportHealthSarif;
  if (typeof maybeExporter === 'function') {
    return (maybeExporter as (f: SarifHealthFinding[], r?: string) => SarifDocument)(
      findings,
      root,
    );
  }
  return exportHealthSarifFallback(findings, root);
}

/**
 * Adapts security-scan findings (file:line-ish locations, flat rawSeverity) into
 * the shape monograph's SARIF exporter expects. Reused rather than reimplemented —
 * see doc/commands/security.md.
 */
export function findingsToSarif(
  findings: Array<{
    type: string;
    location: string;
    description: string;
    rawSeverity: 'critical' | 'high' | 'medium' | 'low';
  }>,
): SarifHealthFinding[] {
  const slug = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');
  return findings.map((f) => {
    const lastColon = f.location.lastIndexOf(':');
    const maybeLine = lastColon >= 0 ? Number(f.location.slice(lastColon + 1)) : NaN;
    const hasLine = Number.isFinite(maybeLine) && maybeLine > 0;
    const filePath = hasLine ? f.location.slice(0, lastColon) : f.location;
    const line = hasLine ? maybeLine : 0;
    return {
      filePath,
      functionName: f.type,
      startLine: line,
      endLine: line,
      ruleId: `security-scan/${slug(f.type)}`,
      message: f.description,
      severity:
        f.rawSeverity === 'critical' || f.rawSeverity === 'high'
          ? 'error'
          : f.rawSeverity === 'medium'
            ? 'warning'
            : 'note',
    };
  });
}
