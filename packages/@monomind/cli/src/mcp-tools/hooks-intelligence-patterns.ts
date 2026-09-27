import {
  getEWCConsolidator,
  getIntelligenceStatsFromMemory,
  getRealSearchFunction,
  getRealStoreFunction,
  getSONAOptimizer,
} from './hooks-embedding.js';
import type { MCPTool } from './types.js';

// Pattern store/search hooks - REAL implementation using storeEntry
export const hooksPatternStore: MCPTool = {
  name: 'hooks_intelligence_pattern-store',
  description: 'Store pattern in ReasoningBank (HNSW-indexed)',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Pattern description' },
      type: { type: 'string', description: 'Pattern type' },
      confidence: { type: 'number', description: 'Confidence score' },
      metadata: { type: 'object', description: 'Additional metadata' },
    },
    required: ['pattern'],
  },
  handler: async (params: Record<string, unknown>) => {
    // Cap pattern and type lengths to prevent DoS via large embedding generation
    // and unbounded database writes.  16 KB matches the cap in neural_patterns store.
    const MAX_PATTERN_LEN = 16 * 1024; // 16 KB
    const MAX_TYPE_LEN = 256;
    const rawPattern = params.pattern as string;
    const pattern =
      typeof rawPattern === 'string' && rawPattern.length > MAX_PATTERN_LEN
        ? rawPattern.slice(0, MAX_PATTERN_LEN)
        : rawPattern;
    const rawType = (params.type as string) || 'general';
    const type =
      typeof rawType === 'string' && rawType.length > MAX_TYPE_LEN
        ? rawType.slice(0, MAX_TYPE_LEN)
        : rawType;
    const confidence = (params.confidence as number) || 0.8;
    const metadata = params.metadata as Record<string, unknown> | undefined;
    const timestamp = new Date().toISOString();
    const patternId = `pattern-${Date.now()}-${Math.random().toString(36).substring(7)}`;

    // Phase 3: Try ReasoningBank via bridge first
    let reasoningResult: { success: boolean; id?: string; error?: string } | null = null;
    try {
      const bridge = await import('../memory/memory-bridge.js');
      reasoningResult = await bridge.bridgeStorePattern({ pattern, taskType: type, confidence });
    } catch {
      // Bridge not available
    }

    // Fallback: persist using memory-initializer store
    let storeResult: {
      success: boolean;
      id?: string;
      embedding?: { dimensions: number; model: string };
      error?: string;
    } = { success: false };
    if (!reasoningResult) {
      const storeFn = await getRealStoreFunction();
      if (storeFn) {
        try {
          storeResult = await storeFn({
            key: patternId,
            value: JSON.stringify({ pattern, type, confidence, metadata, timestamp }),
            namespace: 'pattern',
            generateEmbeddingFlag: true,
            tags: [type, `confidence-${Math.round(confidence * 100)}`, 'reasoning-pattern'],
          });
        } catch (error) {
          storeResult = {
            success: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }
    }

    const success = reasoningResult?.success || storeResult.success;
    const controller = reasoningResult?.success
      ? 'sqlite'
      : storeResult.success
        ? 'bridge-store'
        : 'none';

    return {
      patternId: reasoningResult?.id || storeResult.id || patternId,
      pattern,
      type,
      confidence,
      indexed: success,
      hnswIndexed: success && (!!storeResult.embedding || controller === 'sqlite'),
      embedding: storeResult.embedding,
      timestamp,
      controller,
      implementation:
        controller === 'sqlite'
          ? 'sqlite-controller'
          : storeResult.success
            ? 'real-hnsw-indexed'
            : 'memory-only',
      note:
        controller === 'sqlite'
          ? 'Pattern stored via SQLite-backed memory bridge with HNSW indexing'
          : storeResult.success
            ? 'Pattern stored with vector embedding for semantic search'
            : storeResult.error || 'Store function unavailable',
    };
  },
};

export const hooksPatternSearch: MCPTool = {
  name: 'hooks_intelligence_pattern-search',
  description:
    'Search patterns using REAL vector search (HNSW when available, brute-force fallback)',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      topK: { type: 'number', description: 'Number of results' },
      minConfidence: { type: 'number', description: 'Minimum similarity threshold (0-1)' },
      namespace: { type: 'string', description: 'Namespace to search (default: pattern)' },
    },
    required: ['query'],
  },
  handler: async (params: Record<string, unknown>) => {
    // Cap query length to prevent DoS via large embedding generation (same
    // class of bug fixed in neural_patterns search and hooksPatternStore).
    const MAX_SEARCH_QUERY_LEN = 16 * 1024; // 16 KB — matches neural_patterns cap
    const MAX_TOP_K = 100;
    const rawQuery = params.query as string;
    const query =
      typeof rawQuery === 'string' && rawQuery.length > MAX_SEARCH_QUERY_LEN
        ? rawQuery.slice(0, MAX_SEARCH_QUERY_LEN)
        : rawQuery;
    const rawTopK = params.topK as number;
    const topK =
      Number.isFinite(rawTopK) && rawTopK > 0 ? Math.min(Math.floor(rawTopK), MAX_TOP_K) : 5;
    const minConfidence = (params.minConfidence as number) || 0.3;
    const namespace = (params.namespace as string) || 'pattern';

    // Phase 3: Try ReasoningBank search via bridge first
    try {
      const bridge = await import('../memory/memory-bridge.js');
      const rbResult = await bridge.bridgeSearchPatterns({ query, limit: topK });
      if (rbResult && rbResult.patterns.length > 0) {
        return {
          query,
          results: rbResult.patterns
            .filter((r: { score: number }) => r.score >= minConfidence)
            .map((r: { id: string; pattern: string; score: number }) => ({
              patternId: r.id,
              pattern: r.pattern,
              similarity: r.score,
              confidence: r.score,
              namespace,
            })),
          searchTimeMs: 0,
          backend: 'sqlite',
          note: 'Results from SQLite-backed memory bridge',
        };
      }
    } catch {
      // Bridge not available — fall through
    }

    // Fallback: Try real vector search via memory-initializer
    const searchFn = await getRealSearchFunction();

    if (searchFn) {
      try {
        const searchResult = await searchFn({
          query,
          namespace,
          limit: topK,
          threshold: minConfidence,
        });

        if (searchResult.success && searchResult.results.length > 0) {
          return {
            query,
            results: searchResult.results.map((r) => ({
              patternId: r.id,
              pattern: r.content,
              similarity: r.score,
              confidence: r.score,
              namespace: r.namespace,
              key: r.key,
            })),
            searchTimeMs: searchResult.searchTime,
            backend: 'real-vector-search',
            note: 'Results from HNSW/SQLite vector search (BM25 hybrid)',
          };
        }

        // No results found
        return {
          query,
          results: [],
          searchTimeMs: searchResult.searchTime,
          backend: 'real-vector-search',
          note:
            searchResult.error ||
            'No matching patterns found. Store patterns first using memory/store with namespace "pattern".',
        };
      } catch (error) {
        // Fall through to empty response with error
        return {
          query,
          results: [],
          searchTimeMs: 0,
          backend: 'error',
          error: String(error),
          note: 'Vector search failed. Ensure memory database is initialized.',
        };
      }
    }

    // No search function available
    return {
      query,
      results: [],
      searchTimeMs: 0,
      backend: 'unavailable',
      note: 'Real vector search not available. Initialize memory database with: monomind memory init',
    };
  },
};

// Intelligence stats hook
export const hooksIntelligenceStats: MCPTool = {
  name: 'hooks_intelligence_stats',
  description: 'Get intelligence-layer statistics (pattern/trajectory logging)',
  inputSchema: {
    type: 'object',
    properties: {
      detailed: { type: 'boolean', description: 'Include detailed stats' },
    },
  },
  handler: async (params: Record<string, unknown>) => {
    const detailed = params.detailed as boolean;

    // Get REAL statistics from actual implementations
    const sona = await getSONAOptimizer();
    const ewc = await getEWCConsolidator();
    // Fallback to memory store for legacy data
    const memoryStats = getIntelligenceStatsFromMemory();
    // Real measured adaptation latency, tracked from actual wall-clock timings
    // in LocalSonaCoordinator (memory/intelligence.ts), not a theoretical constant.
    const { getIntelligenceStats: getLocalIntelligenceStats } = await import(
      '../memory/intelligence.js'
    );
    const avgLearningTimeMs = getLocalIntelligenceStats().avgAdaptationTime;

    // SONA stats from real implementation
    let sonaStats = {
      trajectoriesTotal: memoryStats.trajectories.total,
      trajectoriesSuccessful: memoryStats.trajectories.successful,
      avgLearningTimeMs,
      patternsLearned: memoryStats.patterns.learned,
      patternCategories: memoryStats.patterns.categories,
      successRate: 0,
      implementation: 'memory-fallback' as string,
    };
    if (sona) {
      const realSona = sona.getStats();
      const totalRoutes = realSona.successfulRoutings + realSona.failedRoutings;
      sonaStats = {
        trajectoriesTotal: realSona.trajectoriesProcessed,
        trajectoriesSuccessful: realSona.successfulRoutings,
        avgLearningTimeMs,
        patternsLearned: realSona.totalPatterns,
        patternCategories: { learned: realSona.totalPatterns }, // Simplified
        successRate:
          totalRoutes > 0 ? Math.round((realSona.successfulRoutings / totalRoutes) * 100) / 100 : 0,
        implementation: 'real-sona',
      };
    }

    // EWC++ stats from real implementation
    let ewcStats = {
      consolidations: 0,
      catastrophicForgettingPrevented: 0,
      fisherUpdates: 0,
      avgPenalty: 0,
      totalPatterns: 0,
      implementation: 'not-loaded' as string,
    };
    if (ewc) {
      const realEwc = ewc.getConsolidationStats();
      ewcStats = {
        consolidations: realEwc.consolidationCount,
        catastrophicForgettingPrevented: realEwc.highImportancePatterns,
        fisherUpdates: realEwc.consolidationCount,
        avgPenalty: Math.round(realEwc.avgPenalty * 1000) / 1000,
        totalPatterns: realEwc.totalPatterns,
        implementation: 'ewc-inspired-heuristic',
      };
    }

    // MoE stats from real implementation
    const moeStats = {
      expertsActive: 0,
      routingDecisions: memoryStats.routing.decisions,
      avgRoutingTimeMs: 0,
      avgConfidence: memoryStats.routing.avgConfidence,
      loadBalance: null as {
        giniCoefficient: number;
        coefficientOfVariation: number;
        expertUsage: Record<string, number>;
      } | null,
      implementation: 'not-loaded' as string,
    };

    // Flash Attention stats (native MoE/Flash removed in lean build — defaults only)
    const flashStats = {
      speedup: 1.0,
      avgComputeTimeMs: 0,
      blockSize: 64,
      implementation: 'not-loaded' as string,
    };

    // LoRA Adapter removed — superseded by SONA instant adaptation
    const loraStats = {
      alpha: 16,
      adaptations: 0,
      avgLoss: 0,
      implementation: 'not-loaded' as string,
    };

    const stats = {
      sona: sonaStats,
      moe: moeStats,
      ewc: ewcStats,
      flash: flashStats,
      lora: loraStats,
      hnsw: {
        indexSize: memoryStats.memory.indexSize,
        memoryUsageMb: Math.round((memoryStats.memory.memorySizeBytes / 1024 / 1024) * 100) / 100,
      },
      dataSource: sona ? 'real-implementations' : 'memory-fallback',
      lastUpdated: new Date().toISOString(),
    };

    if (detailed) {
      return {
        ...stats,
        implementationStatus: {
          sona: sona ? 'loaded' : 'not-loaded',
          ewc: ewc ? 'loaded' : 'not-loaded',
          moe: 'not-loaded',
          flash: 'not-loaded',
          lora: 'not-loaded',
        },
        performance: {
          sonaLearningMs: sonaStats.avgLearningTimeMs,
          moeRoutingMs: moeStats.avgRoutingTimeMs,
          flashSpeedup: flashStats.speedup,
          ewcPenalty: ewcStats.avgPenalty,
        },
      };
    }

    return stats;
  },
};

// Intelligence learn hook
export const hooksIntelligenceLearn: MCPTool = {
  name: 'hooks_intelligence_learn',
  description:
    'Run a real consolidation pass over the local pattern store via compactPatterns(): dedupes patterns above a cosine-similarity threshold and reports the actual before/after/removed counts. There are no gradients and no model — no ML training occurs.',
  inputSchema: {
    type: 'object',
    properties: {
      trajectoryIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Specific trajectories to learn from',
      },
      consolidate: { type: 'boolean', description: 'Run pattern consolidation (compactPatterns)' },
    },
  },
  handler: async (params: Record<string, unknown>) => {
    const consolidate = params.consolidate !== false;
    const startTime = Date.now();

    // Get SONA statistics
    let sonaStats = {
      totalPatterns: 0,
      successfulRoutings: 0,
      failedRoutings: 0,
      trajectoriesProcessed: 0,
      avgConfidence: 0,
    };
    const sona = await getSONAOptimizer();
    if (sona) {
      const stats = sona.getStats();
      sonaStats = {
        totalPatterns: stats.totalPatterns,
        successfulRoutings: stats.successfulRoutings,
        failedRoutings: stats.failedRoutings,
        trajectoriesProcessed: stats.trajectoriesProcessed,
        avgConfidence: stats.avgConfidence,
      };
    }

    // Run the real consolidation pass (dedupes similar patterns by cosine
    // similarity) and report the actual before/after/removed counts —
    // the same function and reporting shape used by `hooks intelligence --train`.
    let consolidation: { before: number; after: number; removed: number } | null = null;
    if (consolidate) {
      const { compactPatterns } = await import('../memory/intelligence.js');
      consolidation = await compactPatterns(0.95);
    }

    return {
      learned: sonaStats.totalPatterns > 0,
      duration: Date.now() - startTime,
      updates: {
        trajectoriesProcessed: sonaStats.trajectoriesProcessed,
        patternsLearned: sonaStats.totalPatterns,
        successRate:
          sonaStats.trajectoriesProcessed > 0
            ? `${(
                (sonaStats.successfulRoutings /
                  (sonaStats.successfulRoutings + sonaStats.failedRoutings)) *
                  100
              ).toFixed(1)}%`
            : '0%',
      },
      consolidation,
      confidence: {
        average: sonaStats.avgConfidence,
        implementation: sona ? 'real-sona' : 'not-available',
      },
      implementation: sona ? 'real-sona-learning' : 'placeholder',
    };
  },
};
