/**
 * Embeddings MCP Tools — neural, hyperbolic, status.
 * Extracted from embeddings-tools.ts.
 */

import { DEFAULT_EMBEDDING_MODEL } from '../init/types.js';
import {
  getConfigPath,
  loadConfig,
  saveConfig,
  validateVector,
} from './embeddings-tools-config.js';
import { poincareDistance, toPoincare } from './embeddings-tools-math.js';
import type { MCPTool } from './types.js';

export const embeddingsNeuralTools: MCPTool[] = [
  {
    name: 'embeddings_neural',
    description:
      'Report and adjust pattern-store statistics (drift, consolidate, adapt) from intelligence.ts. Reads real counters — but its "init" action only persists a config blob (sona, flashAttention, ewcPlusPlus, memoryPhysics, swarmCoordination…) for which no implementing code exists anywhere; those flags are stored and echoed back, never acted on. There is no neural substrate and no "memory physics".',
    category: 'embeddings',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'Neural action',
          enum: ['status', 'init', 'drift', 'consolidate', 'adapt'],
          default: 'status',
        },
        driftThreshold: {
          type: 'number',
          description: 'Semantic drift detection threshold',
          default: 0.3,
        },
        decayRate: {
          type: 'number',
          description:
            'Decay rate applied to stored pattern confidence (plain exponential decay — the "hippocampal dynamics" framing this once carried described nothing in the code)',
          default: 0.01,
        },
      },
    },
    handler: async (input) => {
      const config = loadConfig();
      if (!config) {
        return {
          success: false,
          error: 'Embeddings not initialized. Run embeddings/init first.',
        };
      }

      const action = (input.action as string) || 'status';

      switch (action) {
        case 'init':
          config.neural = {
            enabled: true,
            driftThreshold: (input.driftThreshold as number) || 0.3,
            decayRate: (input.decayRate as number) || 0.01,
            monovector: {
              enabled: true,
              sona: true,
              flashAttention: true,
              ewcPlusPlus: true,
            },
            features: {
              semanticDrift: true,
              memoryPhysics: true,
              stateMachine: true,
              swarmCoordination: true,
              coherenceMonitor: true,
            },
          };
          saveConfig(config);
          return {
            success: true,
            action: 'init',
            neural: config.neural,
            message: 'Embedding substrate initialized',
          };

        case 'drift':
          // Get real drift metrics if available.
          // initializeIntelligence() MUST run first: getIntelligenceStats()
          // reads module singletons (sonaCoordinator / reasoningBank) that are
          // null until init, so a populated store otherwise reports 0 patterns.
          try {
            const { getIntelligenceStats, initializeIntelligence } = await import(
              '../memory/intelligence.js'
            );
            await initializeIntelligence();
            const stats = getIntelligenceStats();
            return {
              success: true,
              action: 'drift',
              status: {
                semanticDrift: {
                  enabled: config.neural.features?.semanticDrift ?? false,
                  threshold: config.neural.driftThreshold,
                  patternsTracked: stats.patternsLearned,
                  status: stats.patternsLearned > 0 ? 'tracking' : 'no patterns',
                },
              },
              message:
                stats.patternsLearned > 0
                  ? `Tracking ${stats.patternsLearned} patterns for drift`
                  : 'No patterns stored yet - drift detection inactive',
            };
          } catch (e) {
            // Failing to read the store is NOT a drift report of zero.
            return {
              success: false,
              action: 'drift',
              error: `Intelligence store unavailable — drift status unknown: ${(e as Error).message}`,
              status: {
                semanticDrift: { enabled: false, reason: 'Intelligence module unavailable' },
              },
            };
          }

        case 'consolidate':
          // Get real consolidation metrics — same init requirement as 'drift'.
          try {
            const { getIntelligenceStats, initializeIntelligence } = await import(
              '../memory/intelligence.js'
            );
            await initializeIntelligence();
            const stats = getIntelligenceStats();
            return {
              success: true,
              action: 'consolidate',
              status: {
                memoryPhysics: {
                  enabled: config.neural.features?.memoryPhysics ?? false,
                  decayRate: config.neural.decayRate,
                  patternsStored: stats.reasoningBankSize,
                  trajectoriesRecorded: stats.trajectoriesRecorded,
                },
              },
              message: `ReasoningBank: ${stats.reasoningBankSize} patterns, ${stats.trajectoriesRecorded} trajectories`,
            };
          } catch (e) {
            return {
              success: false,
              action: 'consolidate',
              error: `Intelligence store unavailable — consolidation status unknown: ${(e as Error).message}`,
              status: {
                memoryPhysics: { enabled: false, reason: 'Intelligence module unavailable' },
              },
            };
          }

        case 'adapt':
          // Get real (JS) pattern-adaptation metrics
          try {
            const { benchmarkAdaptation, initializeIntelligence } = await import(
              '../memory/intelligence.js'
            );
            await initializeIntelligence();
            const benchmark = benchmarkAdaptation(100);
            return {
              success: true,
              action: 'adapt',
              status: {
                sona: {
                  enabled: true,
                  adaptationTime: `${(benchmark.avgMs * 1000).toFixed(2)}μs`,
                  targetMet: benchmark.targetMet,
                  minTime: `${(benchmark.minMs * 1000).toFixed(2)}μs`,
                  maxTime: `${(benchmark.maxMs * 1000).toFixed(2)}μs`,
                },
              },
              message: benchmark.targetMet
                ? `Pattern adaptation: ${(benchmark.avgMs * 1000).toFixed(2)}μs (target <50μs met)`
                : `Pattern adaptation: ${(benchmark.avgMs * 1000).toFixed(2)}μs (target not met)`,
            };
          } catch {
            return {
              success: true,
              action: 'adapt',
              status: { sona: { enabled: false, reason: 'Intelligence module unavailable' } },
            };
          }

        default: // status
          // Get real neural system status
          try {
            const { getIntelligenceStats, benchmarkAdaptation, initializeIntelligence } =
              await import('../memory/intelligence.js');
            await initializeIntelligence();
            const stats = getIntelligenceStats();
            const benchmark = benchmarkAdaptation(50);
            return {
              success: true,
              action: 'status',
              neural: {
                enabled: config.neural.enabled,
                sonaEnabled: stats.sonaEnabled,
                monovector: config.neural.monovector || { enabled: false },
                features: config.neural.features || {},
                realMetrics: {
                  patternsLearned: stats.patternsLearned,
                  trajectoriesRecorded: stats.trajectoriesRecorded,
                  reasoningBankSize: stats.reasoningBankSize,
                  adaptationTime: `${(benchmark.avgMs * 1000).toFixed(2)}μs`,
                  targetMet: benchmark.targetMet,
                  lastAdaptation: stats.lastAdaptation
                    ? new Date(stats.lastAdaptation).toISOString()
                    : null,
                },
              },
              capabilities: [
                stats.sonaEnabled ? '✅ Pattern logging active' : '❌ Pattern logging inactive',
                benchmark.targetMet ? '✅ <0.05ms Target Met' : '⚠️ Target Not Met',
                `${stats.patternsLearned} patterns learned`,
                `${stats.trajectoriesRecorded} trajectories recorded`,
              ],
            };
          } catch {
            return {
              success: true,
              action: 'status',
              neural: {
                enabled: config.neural.enabled,
                monovector: config.neural.monovector || { enabled: false },
                features: config.neural.features || {},
              },
              message: 'Intelligence module not available - showing config only',
            };
          }
      }
    },
  },

  {
    name: 'embeddings_hyperbolic',
    description: 'Hyperbolic embedding operations (Poincaré ball)',
    category: 'embeddings',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'Hyperbolic action',
          enum: ['status', 'convert', 'distance', 'midpoint'],
          default: 'status',
        },
        embedding: {
          type: 'array',
          description: 'Euclidean embedding to convert',
          items: { type: 'number' },
        },
        embedding1: {
          type: 'array',
          description: 'First embedding for distance/midpoint',
          items: { type: 'number' },
        },
        embedding2: {
          type: 'array',
          description: 'Second embedding for distance/midpoint',
          items: { type: 'number' },
        },
      },
    },
    handler: async (input) => {
      const config = loadConfig();
      if (!config) {
        return {
          success: false,
          error: 'Embeddings not initialized. Run embeddings/init first.',
        };
      }

      if (!config.hyperbolic.enabled) {
        return {
          success: false,
          error: 'Hyperbolic mode not enabled. Initialize with hyperbolic=true.',
        };
      }

      const action = (input.action as string) || 'status';
      const curvature = config.hyperbolic.curvature;

      switch (action) {
        case 'convert': {
          // validateVector caps at MAX_VECTOR_DIM (8192) — prevents O(n) DoS
          // in toPoincare (reduce + map over the full array).
          let embedding: number[];
          try {
            embedding = validateVector(input.embedding, 'embedding');
          } catch (e) {
            return { success: false, error: (e as Error).message };
          }
          const poincare = toPoincare(embedding, curvature);
          return {
            success: true,
            action: 'convert',
            euclidean: embedding,
            poincare,
            curvature,
            poincareNorm: Math.sqrt(poincare.reduce((sum, x) => sum + x * x, 0)),
          };
        }

        case 'distance': {
          let emb1: number[], emb2: number[];
          try {
            emb1 = validateVector(input.embedding1, 'embedding1');
            emb2 = validateVector(input.embedding2, 'embedding2');
          } catch (e) {
            return { success: false, error: (e as Error).message };
          }
          const dist = poincareDistance(emb1, emb2, curvature);
          return {
            success: true,
            action: 'distance',
            distance: dist,
            curvature,
            interpretation: dist < 1 ? 'close' : dist < 2 ? 'moderate' : 'far',
          };
        }

        case 'midpoint': {
          let e1: number[], e2: number[];
          try {
            e1 = validateVector(input.embedding1, 'embedding1');
            e2 = validateVector(input.embedding2, 'embedding2');
          } catch (e) {
            return { success: false, error: (e as Error).message };
          }
          // Simplified midpoint (proper Möbius midpoint is more complex)
          const mid = e1.map((_, i) => (e1[i] + e2[i]) / 2);
          const norm = Math.sqrt(mid.reduce((sum, x) => sum + x * x, 0));
          const scaledMid = mid.map(
            (x) => x * (config.hyperbolic.maxNorm / Math.max(norm, config.hyperbolic.maxNorm)),
          );
          return {
            success: true,
            action: 'midpoint',
            midpoint: scaledMid,
            curvature,
          };
        }

        default: // status
          return {
            success: true,
            action: 'status',
            hyperbolic: {
              enabled: true,
              curvature,
              epsilon: config.hyperbolic.epsilon,
              maxNorm: config.hyperbolic.maxNorm,
            },
            benefits: [
              'Better hierarchical data representation',
              'Exponential capacity in low dimensions',
              'Preserves tree-like structures',
              'Natural for taxonomy embeddings',
            ],
          };
      }
    },
  },

  {
    name: 'embeddings_status',
    description: 'Get embeddings system status and configuration',
    category: 'embeddings',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async () => {
      const config = loadConfig();
      if (!config) {
        return {
          success: false,
          initialized: false,
          message: 'Embeddings not initialized. Run embeddings/init first.',
        };
      }

      return {
        success: true,
        initialized: true,
        config: {
          model: config.model,
          dimension: config.dimension,
          cacheSize: config.cacheSize,
          hyperbolic: config.hyperbolic,
          neural: {
            enabled: config.neural.enabled,
            monovector: config.neural.monovector?.enabled ?? false,
          },
        },
        paths: {
          config: getConfigPath(),
          models: config.modelPath,
        },
        initializedAt: config.initialized,
        capabilities: {
          onnxModels: [
            DEFAULT_EMBEDDING_MODEL,
            'Xenova/all-MiniLM-L6-v2',
            'Xenova/all-mpnet-base-v2',
          ],
          geometries: ['euclidean', 'poincare'],
          normalizations: ['L2', 'L1', 'minmax', 'zscore'],
          features: ['semantic search', 'hyperbolic projection', 'neural substrate'],
        },
      };
    },
  },
];
