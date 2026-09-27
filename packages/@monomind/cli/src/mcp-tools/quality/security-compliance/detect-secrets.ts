/**
 * detect-secrets.ts - Secret detection MCP tool handler
 *
 * Detects secrets, API keys, passwords, and other sensitive data in code
 * using pattern matching and entropy analysis.
 */

import { validateInput } from '../../../utils/input-guards.js';
import { calculateSummary, generateRecommendations, groupByType } from './detect-secrets-report.js';
import { scanForSecrets } from './detect-secrets-scan.js';
import type {
  DetectSecretsInput,
  DetectSecretsOutput,
  ToolContext,
} from './detect-secrets-types.js';
import { DetectSecretsInputSchema } from './detect-secrets-types.js';

export type {
  DetectionMetadata,
  DetectionSummary,
  DetectSecretsInput,
  DetectSecretsOutput,
  SecretFinding,
  SecretLocation,
  SecretRecommendation,
  ToolContext,
  TypeSummary,
} from './detect-secrets-types.js';
// Schema, output types, and secret patterns live in detect-secrets-types.ts;
// scanning logic in detect-secrets-scan.ts; summary/recommendation logic in
// detect-secrets-report.ts — split out to keep each file readable.
export {
  DetectSecretsInputSchema,
  SECRET_PATTERNS,
} from './detect-secrets-types.js';

/**
 * MCP Tool Handler for detect-secrets
 */
export async function handler(
  input: DetectSecretsInput,
  _context: ToolContext,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const startTime = Date.now();

  try {
    // Validate input
    const validatedInput = DetectSecretsInputSchema.parse(input);

    // targetPath reaches the filesystem walker below with no other gate — without
    // this, a caller (or an agent following injected instructions) can point it at
    // ~/.aws, /etc, or any other readable path on disk.
    const pathCheck = validateInput(validatedInput.targetPath, { type: 'path' });
    if (!pathCheck.valid) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: false,
                error: `Invalid targetPath: ${pathCheck.error}`,
                findings: [],
                metadata: {
                  scannedAt: new Date().toISOString(),
                  durationMs: Date.now() - startTime,
                },
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    // Scan for secrets
    const { findings, scanStats } = await scanForSecrets(
      validatedInput.targetPath,
      validatedInput.secretTypes,
      validatedInput.excludePatterns,
      validatedInput.includeEntropy,
      validatedInput.entropyThreshold,
    );

    // Calculate summary
    const summary = calculateSummary(findings);

    // Group by type
    const byType = groupByType(findings);

    // Generate recommendations
    const recommendations = generateRecommendations(findings, byType);

    // Build result
    const result: DetectSecretsOutput = {
      success: true,
      summary,
      findings,
      byType,
      recommendations,
      metadata: {
        scannedAt: new Date().toISOString(),
        durationMs: Date.now() - startTime,
        filesScanned: scanStats.filesScanned,
        linesScanned: scanStats.linesScanned,
        patternsUsed: validatedInput.secretTypes.length,
        entropyEnabled: validatedInput.includeEntropy,
      },
    };

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              success: false,
              error: errorMessage,
              findings: [],
              metadata: {
                scannedAt: new Date().toISOString(),
                durationMs: Date.now() - startTime,
              },
            },
            null,
            2,
          ),
        },
      ],
    };
  }
}

// Export tool definition for MCP registration
export const toolDefinition = {
  name: 'aqe/detect-secrets',
  description: 'Detect secrets, API keys, and sensitive data in code',
  category: 'security-compliance',
  version: '3.2.3',
  inputSchema: DetectSecretsInputSchema,
  handler,
};

export default toolDefinition;
