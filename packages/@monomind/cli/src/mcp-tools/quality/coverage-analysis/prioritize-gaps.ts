/**
 * prioritize-gaps.ts - Risk-based gap prioritization MCP tool handler
 *
 * Prioritizes coverage gaps based on multiple risk factors including
 * code complexity, change frequency, business criticality, and defect history.
 */

import {
  calculateStatistics,
  generateRecommendations,
  groupGaps,
} from './prioritize-gaps-report.js';
import { calculatePriorities, generateGapsFromPath } from './prioritize-gaps-scoring.js';
import {
  DEFAULT_WEIGHTS,
  type PrioritizeGapsInput,
  PrioritizeGapsInputSchema,
  type PrioritizeGapsOutput,
  type ToolContext,
} from './prioritize-gaps-types.js';

export {
  type FactorScore,
  type GapGroup,
  type PrioritizationMetadata,
  type PrioritizationStatistics,
  type PrioritizedGap,
  type PrioritizeGapsInput,
  PrioritizeGapsInputSchema,
  type PrioritizeGapsOutput,
  type Recommendation,
  type ToolContext,
} from './prioritize-gaps-types.js';

/**
 * MCP Tool Handler for prioritize-gaps
 */
export async function handler(
  input: PrioritizeGapsInput,
  context: ToolContext,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const startTime = Date.now();

  try {
    // Validate input
    const validatedInput = PrioritizeGapsInputSchema.parse(input);

    // Get bridge for defect history lookup
    const bridge = context.get<{
      searchSimilarPatterns: (q: string, k: number) => Promise<unknown[]>;
    }>('aqe.bridge');

    // Get or generate gaps
    let gaps = validatedInput.gaps;
    if (!gaps || gaps.length === 0) {
      if (!validatedInput.targetPath) {
        throw new Error('Either gaps or targetPath must be provided');
      }
      gaps = await generateGapsFromPath(validatedInput.targetPath);
    }

    // Apply weights
    const weights = { ...DEFAULT_WEIGHTS, ...validatedInput.weights };

    // Calculate priority scores for each gap
    const prioritizedGaps = await calculatePriorities(
      gaps,
      validatedInput.factors,
      weights,
      bridge,
    );

    // Sort by priority score
    prioritizedGaps.sort((a, b) => b.priorityScore - a.priorityScore);

    // Limit results
    const limitedGaps = prioritizedGaps.slice(0, validatedInput.limit);

    // Group results
    const groups = groupGaps(limitedGaps, validatedInput.groupBy);

    // Calculate statistics
    const statistics = calculateStatistics(prioritizedGaps);

    // Generate recommendations
    const recommendations = generateRecommendations(limitedGaps, statistics);

    // Build result
    const result: PrioritizeGapsOutput = {
      success: true,
      prioritizedGaps: limitedGaps,
      groups,
      statistics,
      recommendations,
      metadata: {
        analyzedAt: new Date().toISOString(),
        durationMs: Date.now() - startTime,
        factorsUsed: validatedInput.factors,
        weightsApplied: weights,
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
              prioritizedGaps: [],
              metadata: {
                analyzedAt: new Date().toISOString(),
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
  name: 'aqe/prioritize-gaps',
  description: 'Prioritize coverage gaps by risk score using multiple weighted factors',
  category: 'coverage-analysis',
  version: '3.2.3',
  inputSchema: PrioritizeGapsInputSchema,
  handler,
};

export default toolDefinition;
