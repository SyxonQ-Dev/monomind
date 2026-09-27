/**
 * detect-secrets-types.ts - Input schema, output types, and secret patterns
 * for the detect-secrets MCP tool handler.
 */

import { z } from 'zod';

// Input schema for detect-secrets tool
export const DetectSecretsInputSchema = z.object({
  targetPath: z.string().describe('Path to scan for secrets'),
  secretTypes: z
    .array(
      z.enum([
        'api-key',
        'password',
        'private-key',
        'token',
        'connection-string',
        'certificate',
        'aws-key',
        'aws-secret',
        'gcp-key',
        'azure-key',
        'generic',
      ]),
    )
    .default(['api-key', 'password', 'private-key', 'token', 'aws-key', 'aws-secret'])
    .describe('Types of secrets to detect'),
  excludePatterns: z
    .array(z.string())
    .default(['*.test.ts', '*.spec.ts', 'node_modules', '.git'])
    .describe('File patterns to exclude'),
  includeEntropy: z.boolean().default(true).describe('Use entropy analysis for detection'),
  entropyThreshold: z
    .number()
    .min(0)
    .max(8)
    .default(4.5)
    .describe('Entropy threshold (higher = stricter)'),
  verifySecrets: z.boolean().default(false).describe('Attempt to verify if secrets are active'),
  scanHistory: z.boolean().default(false).describe('Scan git history for secrets'),
});

export type DetectSecretsInput = z.infer<typeof DetectSecretsInputSchema>;

// Output structures
export interface DetectSecretsOutput {
  success: boolean;
  summary: DetectionSummary;
  findings: SecretFinding[];
  byType: TypeSummary[];
  recommendations: SecretRecommendation[];
  metadata: DetectionMetadata;
}

export interface DetectionSummary {
  totalFindings: number;
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  verifiedCount: number;
  filesAffected: number;
  riskScore: number;
}

export interface SecretFinding {
  id: string;
  type: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  location: SecretLocation;
  pattern: string;
  entropy: number;
  verified: boolean | null;
  active: boolean | null;
  exposureRisk: string;
  remediation: string;
}

export interface SecretLocation {
  file: string;
  line: number;
  column: number;
  context: string;
  masked: string;
}

export interface TypeSummary {
  type: string;
  count: number;
  severity: 'critical' | 'high' | 'medium' | 'low';
  files: string[];
}

export interface SecretRecommendation {
  priority: number;
  action: string;
  affectedSecrets: string[];
  effort: 'low' | 'medium' | 'high';
  automatable: boolean;
}

export interface DetectionMetadata {
  scannedAt: string;
  durationMs: number;
  filesScanned: number;
  linesScanned: number;
  patternsUsed: number;
  entropyEnabled: boolean;
}

// Tool context interface
export interface ToolContext {
  get<T>(key: string): T | undefined;
}

// Secret patterns
export const SECRET_PATTERNS: Record<
  string,
  { pattern: RegExp; severity: 'critical' | 'high' | 'medium' | 'low'; description: string }
> = {
  'api-key': {
    pattern: /(?:api[_-]?key|apikey)\s*[:=]\s*['"][a-zA-Z0-9_-]{16,}['"]/gi,
    severity: 'high',
    description: 'API key detected',
  },
  'aws-key': {
    pattern: /(?:AKIA|ABIA|ACCA|ASIA)[0-9A-Z]{16}/g,
    severity: 'critical',
    description: 'AWS access key detected',
  },
  'aws-secret': {
    pattern: /(?:aws[_-]?secret|secret[_-]?access)\s*[:=]\s*['"][a-zA-Z0-9/+=]{40}['"]/gi,
    severity: 'critical',
    description: 'AWS secret key detected',
  },
  'private-key': {
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
    severity: 'critical',
    description: 'Private key detected',
  },
  password: {
    pattern: /(?:password|passwd|pwd)\s*[:=]\s*['"][^'"]{4,}['"]/gi,
    severity: 'high',
    description: 'Hardcoded password detected',
  },
  token: {
    pattern: /(?:bearer|token|auth|jwt)\s*[:=]\s*['"][a-zA-Z0-9_\-.]{20,}['"]/gi,
    severity: 'high',
    description: 'Authentication token detected',
  },
  'connection-string': {
    pattern: /(?:mongodb|postgres|mysql|redis):\/\/[^'"\\s]+:[^'"\\s]+@/gi,
    severity: 'critical',
    description: 'Database connection string with credentials',
  },
  'gcp-key': {
    pattern: /"type":\s*"service_account"/g,
    severity: 'critical',
    description: 'GCP service account key detected',
  },
  'azure-key': {
    pattern: /(?:azure|microsoft)[_-]?(?:key|secret|token)\s*[:=]\s*['"][a-zA-Z0-9_-]{32,}['"]/gi,
    severity: 'critical',
    description: 'Azure credential detected',
  },
  generic: {
    pattern: /(?:secret|credential|key)\s*[:=]\s*['"][a-zA-Z0-9_-]{12,}['"]/gi,
    severity: 'medium',
    description: 'Potential secret detected',
  },
};
