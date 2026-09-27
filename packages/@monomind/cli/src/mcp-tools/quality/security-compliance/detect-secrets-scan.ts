/**
 * detect-secrets-scan.ts - Filesystem walking and pattern-matching scan logic
 * for the detect-secrets MCP tool handler.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import type { SecretFinding } from './detect-secrets-types.js';
import { SECRET_PATTERNS } from './detect-secrets-types.js';

const SCANNABLE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.yaml',
  '.yml',
  '.env',
  '.toml',
  '.ini',
  '.sh',
  '.bash',
  '.zsh',
  '.py',
  '.rb',
  '.go',
]);

function collectFiles(targetPath: string, excludePatterns: string[]): string[] {
  if (!existsSync(targetPath)) return [];

  const stat = statSync(targetPath);
  if (stat.isFile()) return [targetPath];

  const results: string[] = [];

  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      const relPath = relative(targetPath, fullPath);
      if (excludePatterns.some((p) => relPath.includes(p.replace('*.', '')) || entry === p))
        continue;
      let entryStat: ReturnType<typeof statSync>;
      try {
        entryStat = statSync(fullPath);
      } catch {
        continue;
      }
      if (entryStat.isDirectory()) {
        walk(fullPath);
      } else if (SCANNABLE_EXTENSIONS.has(extname(entry).toLowerCase())) {
        results.push(fullPath);
      }
    }
  }

  walk(targetPath);
  return results;
}

function shannonEntropy(value: string): number {
  const freq: Record<string, number> = {};
  for (const ch of value) {
    freq[ch] = (freq[ch] ?? 0) + 1;
  }
  let entropy = 0;
  for (const count of Object.values(freq)) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function maskValue(raw: string): string {
  if (raw.length <= 8) return '****';
  return raw.slice(0, 4) + '*'.repeat(Math.max(4, Math.min(raw.length - 8, 20))) + raw.slice(-4);
}

export async function scanForSecrets(
  targetPath: string,
  secretTypes: string[],
  excludePatterns: string[],
  includeEntropy: boolean,
  entropyThreshold: number,
): Promise<{
  findings: SecretFinding[];
  scanStats: { filesScanned: number; linesScanned: number };
}> {
  const findings: SecretFinding[] = [];
  const files = collectFiles(targetPath, excludePatterns);
  let totalLines = 0;
  let findingIndex = 0;

  const activePatterns = secretTypes.map((t) => ({
    type: t,
    ...(SECRET_PATTERNS[t] ?? SECRET_PATTERNS.generic),
  }));

  for (const filePath of files) {
    let content: string;
    try {
      content = readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }

    const lines = content.split('\n');
    totalLines += lines.length;

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx];
      for (const patternInfo of activePatterns) {
        let match: RegExpExecArray | null;
        const regex = new RegExp(patternInfo.pattern.source, patternInfo.pattern.flags);
        while ((match = regex.exec(line)) !== null) {
          const rawValue = match[0];
          const entropy = shannonEntropy(rawValue);
          if (includeEntropy && entropy < entropyThreshold) continue;

          // context must never carry the raw secret — replace every occurrence on
          // this line with its masked form before truncating for display. (Previously
          // this sat right next to the correctly-masked `masked` field below, handing
          // back verbatim exactly what masking exists to hide.)
          const masked = maskValue(rawValue);
          const redactedLine = line.split(rawValue).join(masked);

          findings.push({
            id: `SEC-${patternInfo.type}-${findingIndex++}`,
            type: patternInfo.type,
            severity: patternInfo.severity,
            location: {
              file: filePath,
              line: lineIdx + 1,
              column: match.index + 1,
              context: redactedLine.trim().slice(0, 120),
              masked,
            },
            pattern: patternInfo.description,
            entropy: Math.round(entropy * 100) / 100,
            verified: null,
            active: null,
            exposureRisk: getExposureRisk(patternInfo.severity),
            remediation: getRemediation(patternInfo.type),
          });
        }
      }
    }
  }

  findings.sort((a, b) => {
    const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    return severityOrder[a.severity] - severityOrder[b.severity];
  });

  return { findings, scanStats: { filesScanned: files.length, linesScanned: totalLines } };
}

function getExposureRisk(severity: string): string {
  const risks: Record<string, string> = {
    critical: 'High risk - immediate unauthorized access possible',
    high: 'Significant risk - sensitive data exposure likely',
    medium: 'Moderate risk - potential security issue',
    low: 'Low risk - minor exposure concern',
  };
  return risks[severity] || 'Unknown risk level';
}

function getRemediation(type: string): string {
  const remediations: Record<string, string> = {
    'api-key': 'Move API key to environment variable or secrets manager',
    'aws-key': 'Rotate AWS credentials immediately and use IAM roles',
    'aws-secret': 'Rotate AWS credentials and use AWS Secrets Manager',
    'private-key': 'Remove private key from code, store in secure vault',
    password: 'Use environment variables or secrets manager',
    token: 'Use secure token storage, implement token rotation',
    'connection-string': 'Use environment variables for connection strings',
    'gcp-key': 'Use workload identity instead of service account keys',
    'azure-key': 'Use Azure Key Vault for credential management',
    generic: 'Review and move to secure configuration',
  };
  return remediations[type] || 'Remove secret from code and use secure storage';
}
