import {
  capSecurityInput,
  getMonoFence,
  MAX_SECURITY_MITIGATION_STRATEGY_LEN,
  MAX_SECURITY_THREAT_TYPE_LEN,
  MAX_SECURITY_VERDICT_LEN,
} from './security-tools-core.js';
import type { MCPTool, MCPToolResult } from './types.js';

/**
 * Get detection statistics
 */
export const monofenceStatsTool: MCPTool = {
  name: 'monofence_stats',
  description: 'Get MonoFence detection and learning statistics.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: async (): Promise<MCPToolResult> => {
    try {
      const defender = await getMonoFence();
      const stats = await defender.getStats();

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                detectionCount: stats.detectionCount,
                avgDetectionTimeMs: stats.avgDetectionTimeMs,
                learnedPatterns: stats.learnedPatterns,
                mitigationStrategies: stats.mitigationStrategies,
                avgMitigationEffectiveness: stats.avgMitigationEffectiveness,
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: String(error) }),
          },
        ],
        isError: true,
      };
    }
  },
};

/**
 * Record detection feedback for learning
 */
export const monofenceLearnTool: MCPTool = {
  name: 'monofence_learn',
  description:
    'Record detection feedback for pattern learning. Improves future detection accuracy.',
  inputSchema: {
    type: 'object',
    properties: {
      input: {
        type: 'string',
        description: 'Original input that was scanned',
      },
      wasAccurate: {
        type: 'boolean',
        description: 'Whether the detection was accurate',
      },
      verdict: {
        type: 'string',
        description: 'User verdict or correction',
      },
      threatType: {
        type: 'string',
        description: 'Threat type for mitigation recording',
      },
      mitigationStrategy: {
        type: 'string',
        description: 'Mitigation strategy used',
        enum: ['block', 'sanitize', 'warn', 'log', 'escalate', 'transform', 'redirect'],
      },
      mitigationSuccess: {
        type: 'boolean',
        description: 'Whether the mitigation was successful',
      },
    },
    required: ['input', 'wasAccurate'],
  },
  handler: async (args: Record<string, unknown>): Promise<MCPToolResult> => {
    let input: string;
    try {
      input = capSecurityInput(args.input);
    } catch (e) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: (e as Error).message }) }],
        isError: true,
      };
    }
    const wasAccurate = args.wasAccurate as boolean;
    const rawVerdict = args.verdict as string | undefined;
    const verdict =
      typeof rawVerdict === 'string' && rawVerdict.length > MAX_SECURITY_VERDICT_LEN
        ? rawVerdict.slice(0, MAX_SECURITY_VERDICT_LEN)
        : rawVerdict;
    const rawThreatType = args.threatType as string | undefined;
    const threatType =
      typeof rawThreatType === 'string' && rawThreatType.length > MAX_SECURITY_THREAT_TYPE_LEN
        ? rawThreatType.slice(0, MAX_SECURITY_THREAT_TYPE_LEN)
        : rawThreatType;
    const rawMitigationStrategy = args.mitigationStrategy as string | undefined;
    const mitigationStrategy =
      typeof rawMitigationStrategy === 'string' &&
      rawMitigationStrategy.length > MAX_SECURITY_MITIGATION_STRATEGY_LEN
        ? rawMitigationStrategy.slice(0, MAX_SECURITY_MITIGATION_STRATEGY_LEN)
        : rawMitigationStrategy;
    const mitigationSuccess = args.mitigationSuccess as boolean | undefined;

    try {
      const defender = await getMonoFence();

      // Re-detect to get result for learning
      const result = await defender.detect(input);

      // Learn from detection
      await defender.learnFromDetection(input, result, {
        wasAccurate,
        userVerdict: verdict,
      });

      // Record mitigation if provided
      if (threatType && mitigationStrategy && mitigationSuccess !== undefined) {
        await defender.recordMitigation(
          threatType as Parameters<typeof defender.recordMitigation>[0],
          mitigationStrategy as Parameters<typeof defender.recordMitigation>[1],
          mitigationSuccess,
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                message: 'Feedback recorded for pattern learning',
                learnedFrom: {
                  input: input.slice(0, 50) + (input.length > 50 ? '...' : ''),
                  wasAccurate,
                  threatCount: result.threats.length,
                },
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: String(error) }),
          },
        ],
        isError: true,
      };
    }
  },
};
