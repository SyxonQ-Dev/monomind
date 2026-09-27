/**
 * Memory MCP tools: memory_health, memory_controllers, memory_pattern_store,
 * memory_pattern_search, memory_feedback.
 *
 * Split out of memory-tools.ts, which re-exports these tools and registers them
 * in `memoryTools` in their original order.
 */

import {
  sanitizeError,
  validatePositiveInt,
  validateScore,
  validateMcpString as validateString,
} from '../utils/input-guards.js';
import { getBridge, MAX_TOP_K } from './memory-tools-shared.js';
import type { MCPTool } from './types.js';

// ===== memory_health — Controller health check =====

export const memoryHealth: MCPTool = {
  name: 'memory_health',
  description: 'Get Memory backend health status including cache stats and attestation count',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: async () => {
    try {
      const bridge = await getBridge();
      const health = await bridge.bridgeHealthCheck();
      if (!health) return { available: false, error: 'Memory bridge not available' };
      return health;
    } catch (error) {
      return { available: false, error: sanitizeError(error) };
    }
  },
};

// ===== memory_controllers — List all controllers =====

export const memoryControllers: MCPTool = {
  name: 'memory_controllers',
  description: 'List all Memory backends and their initialization status',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: async () => {
    return {
      available: false,
      controllers: [],
      total: 0,
      active: 0,
      note: 'Memory operations use the SQLite bridge directly via memory_pattern-store/memory_pattern-search tools.',
    };
  },
};

// ===== memory_pattern_store — Store via ReasoningBank =====

export const memoryPatternStore: MCPTool = {
  name: 'memory_pattern-store',
  description:
    'Store a reusable pattern (embedded, semantically searchable) in the patterns namespace',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Pattern description' },
      type: { type: 'string', description: 'Pattern type (e.g., task-routing, error-recovery)' },
      confidence: { type: 'number', description: 'Confidence score (0-1)' },
    },
    required: ['pattern'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const pattern = validateString(params.pattern, 'pattern');
      if (!pattern)
        return { success: false, error: 'pattern is required (non-empty string, max 100KB)' };

      // validateExternalContent: guard against prompt injection in stored patterns.
      // This is a WRITE to persistent memory, so it fails CLOSED: if
      // validation throws, the write is blocked rather than silently
      // persisted unvalidated.
      {
        const { validateExternalContent } = await import('../utils/input-guards.js');
        const check = await validateExternalContent(pattern, 'memory_pattern-store pattern');
        if (!check.safe) {
          return {
            success: false,
            error: `Injection guard: ${check.reason}`,
            injectionDetected: true,
          };
        }
      }

      const bridge = await getBridge();
      const result = await bridge.bridgeStorePattern({
        pattern,
        taskType: validateString(params.type, 'type', 200) ?? 'general',
        confidence: validateScore(params.confidence, 0.8),
      });
      return (
        result ?? {
          success: false,
          error:
            'Memory bridge not available. Use memory_pattern-store/memory_pattern-search instead.',
        }
      );
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};

// ===== memory_pattern_search — Search via ReasoningBank =====

export const memoryPatternSearch: MCPTool = {
  name: 'memory_pattern-search',
  description:
    'Search stored patterns — semantic when the local embedding model is available, keyword otherwise',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      topK: { type: 'number', description: 'Number of results (default: 5)' },
      minConfidence: { type: 'number', description: 'Minimum score threshold (0-1)' },
    },
    required: ['query'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const query = validateString(params.query, 'query', 10_000);
      if (!query) return { results: [], error: 'query is required (non-empty string, max 10KB)' };

      // validateExternalContent: guard against prompt injection in search queries.
      {
        const { validateExternalContent } = await import('../utils/input-guards.js');
        const check = await validateExternalContent(query, 'memory_pattern-search query');
        if (!check.safe) {
          return {
            results: [],
            error: `Injection guard: ${check.reason}`,
            injectionDetected: true,
          };
        }
      }

      const bridge = await getBridge();
      const minConfidence = validateScore(params.minConfidence, 0.3);
      const result = await bridge.bridgeSearchPatterns({
        query,
        limit: validatePositiveInt(params.topK, 5, MAX_TOP_K),
      });
      if (!result) return { results: [], controller: 'unavailable' };
      const patterns = result.patterns.filter((p: { score: number }) => p.score >= minConfidence);
      // Usage tracking: every recall hit increments the entry's frequency_weight,
      // which feeds both the ranking blend and weight-aware GC protection.
      // Never let this block or fail the search response.
      if (patterns.length) {
        try {
          const ids = patterns
            .map((p: { id: string }) => p.id)
            .filter((id: unknown): id is string => typeof id === 'string' && id.length > 0);
          if (ids.length) await bridge.bridgeRecordUsage({ entryIds: ids });
        } catch {
          /* non-fatal: usage tracking must never break search */
        }
      }
      return { ...result, patterns };
    } catch (error) {
      return { results: [], error: sanitizeError(error) };
    }
  },
};

// ===== memory_feedback — Record task feedback =====

export const memoryFeedback: MCPTool = {
  name: 'memory_feedback',
  description:
    'Rate memory entries used in an answer (pass entryIds from a prior search). Updates feedback_weight; idempotent per taskId.',
  inputSchema: {
    type: 'object',
    properties: {
      taskId: {
        type: 'string',
        description:
          'Task identifier (also the idempotency key — the same taskId never double-applies)',
      },
      entryIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Memory entry IDs (from search results) that were used for this task',
      },
      success: { type: 'boolean', description: 'Whether task succeeded' },
      quality: {
        type: 'number',
        description: 'Quality score (0-1); defaults from success (0.9/0.2)',
      },
      agent: { type: 'string', description: 'Agent that performed the task' },
    },
    required: ['taskId'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const taskId = validateString(params.taskId, 'taskId', 500);
      if (!taskId)
        return { success: false, error: 'taskId is required (non-empty string, max 500 chars)' };
      const bridge = await getBridge();

      // Closed loop: apply the rating to the entries that were actually used.
      const entryIds = Array.isArray(params.entryIds)
        ? (params.entryIds as unknown[])
            .filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 500)
            .slice(0, 100)
        : [];
      let weighting: unknown = null;
      if (entryIds.length) {
        const score =
          typeof params.quality === 'number' && Number.isFinite(params.quality)
            ? Math.max(0, Math.min(1, params.quality))
            : params.success === true
              ? 0.9
              : 0.2;
        weighting = await bridge.bridgeApplyFeedback({ entryIds, score, ledgerKey: taskId });
      }

      // Keep the historical feedback-event record alongside the weighting.
      const result = await bridge.bridgeRecordFeedback({
        taskType: validateString(params.agent, 'agent', 200) ?? 'task',
        action: taskId,
        outcome: params.success === true ? 'success' : 'failure',
        confidence: validateScore(params.quality, 0.85),
        metadata: { taskId, entryIds },
      });
      if (!result)
        return {
          success: false,
          error:
            'Memory bridge not available. Use memory_pattern-store/memory_pattern-search instead.',
        };
      return { ...result, weighting };
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};
