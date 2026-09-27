/**
 * Memory MCP tools: memory_route, memory_session_start, memory_session_end,
 * memory_hierarchical_store, memory_hierarchical_recall.
 *
 * Split out of memory-tools.ts, which re-exports these tools and registers them
 * in `memoryTools` in their original order.
 */

import {
  sanitizeError,
  validatePositiveInt,
  validateMcpString as validateString,
} from '../utils/input-guards.js';
import { getBridge, MAX_TOP_K } from './memory-tools-shared.js';
import type { MCPTool } from './types.js';

// ===== memory_route — Route via SemanticRouter =====

export const memoryRoute: MCPTool = {
  name: 'memory_route',
  description: 'Suggest agent routing for a task by searching past routing patterns',
  inputSchema: {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'Task description to route' },
      context: { type: 'string', description: 'Additional context' },
    },
    required: ['task'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const task = validateString(params.task, 'task', 10_000);
      if (!task)
        return {
          route: 'general',
          confidence: 0.5,
          agents: ['coder'],
          controller: 'error',
          error: 'task is required (non-empty string)',
        };
      const bridge = await getBridge();
      const result = await bridge.bridgeRouteTask({ task });
      return (
        result ?? { route: 'general', confidence: 0.5, agents: ['coder'], controller: 'fallback' }
      );
    } catch (error) {
      return {
        route: 'general',
        confidence: 0.5,
        agents: ['coder'],
        controller: 'error',
        error: sanitizeError(error),
      };
    }
  },
};

// ===== memory_session_start — Session with ReflexionMemory =====

export const memorySessionStart: MCPTool = {
  name: 'memory_session-start',
  description: 'Record a session start in the sessions namespace',
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: { type: 'string', description: 'Session identifier' },
      context: { type: 'string', description: 'Session context for pattern retrieval' },
    },
    required: ['sessionId'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const sessionId = validateString(params.sessionId, 'sessionId', 500);
      if (!sessionId) return { success: false, error: 'sessionId is required (non-empty string)' };
      const bridge = await getBridge();
      const result = await bridge.bridgeSessionStart({
        sessionId,
        metadata: { context: validateString(params.context, 'context', 10_000) ?? undefined },
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

// ===== memory_session_end — End session + NightlyLearner =====

export const memorySessionEnd: MCPTool = {
  name: 'memory_session-end',
  description: 'Record session end with summary and metrics in the sessions namespace',
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: { type: 'string', description: 'Session identifier' },
      summary: { type: 'string', description: 'Session summary' },
      tasksCompleted: { type: 'number', description: 'Number of tasks completed' },
    },
    required: ['sessionId'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const sessionId = validateString(params.sessionId, 'sessionId', 500);
      if (!sessionId) return { success: false, error: 'sessionId is required (non-empty string)' };
      const bridge = await getBridge();
      const result = await bridge.bridgeSessionEnd({
        sessionId,
        summary: validateString(params.summary, 'summary', 50_000) ?? undefined,
        metrics: { tasksCompleted: validatePositiveInt(params.tasksCompleted, 0, 10_000) },
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

// ===== memory_hierarchical_store — Store to hierarchical memory =====

export const memoryHierarchicalStore: MCPTool = {
  name: 'memory_hierarchical-store',
  description:
    'Store into a tier-labeled namespace (tier_working/episodic/semantic). Note: tiers are labels, not automatic promotion',
  inputSchema: {
    type: 'object',
    properties: {
      key: { type: 'string', description: 'Memory entry key' },
      value: { type: 'string', description: 'Memory entry value' },
      tier: {
        type: 'string',
        description: 'Memory tier (working, episodic, semantic)',
        enum: ['working', 'episodic', 'semantic'],
        default: 'working',
      },
    },
    required: ['key', 'value'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const key = validateString(params.key, 'key', 1000);
      const value = validateString(params.value, 'value');
      if (!key) return { success: false, error: 'key is required (non-empty string, max 1KB)' };
      if (!value)
        return { success: false, error: 'value is required (non-empty string, max 100KB)' };
      const tier = validateString(params.tier, 'tier', 20) ?? 'working';
      if (!['working', 'episodic', 'semantic'].includes(tier)) {
        return {
          success: false,
          error: `Invalid tier: ${tier}. Must be working, episodic, or semantic`,
        };
      }
      const bridge = await getBridge();
      const result = await bridge.bridgeHierarchicalStore({ key, value, tier });
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

// ===== memory_hierarchical_recall — Recall from hierarchical memory =====

export const memoryHierarchicalRecall: MCPTool = {
  name: 'memory_hierarchical-recall',
  description:
    'Search tier-labeled namespaces (tier_working/episodic/semantic), or all when no tier given',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Recall query' },
      tier: { type: 'string', description: 'Filter by tier (working, episodic, semantic)' },
      topK: { type: 'number', description: 'Number of results (default: 5)' },
    },
    required: ['query'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const query = validateString(params.query, 'query', 10_000);
      if (!query) return { results: [], error: 'query is required (non-empty string, max 10KB)' };
      const tier = validateString(params.tier, 'tier', 20);
      if (tier && !['working', 'episodic', 'semantic'].includes(tier)) {
        return {
          results: [],
          error: `Invalid tier: ${tier}. Must be working, episodic, or semantic`,
        };
      }
      const bridge = await getBridge();
      const result = await bridge.bridgeHierarchicalRecall({
        query,
        tier: tier ?? undefined,
        topK: validatePositiveInt(params.topK, 5, MAX_TOP_K),
      });
      // Usage tracking: every recall hit increments the entry's frequency_weight,
      // which feeds both the ranking blend and weight-aware GC protection.
      // Never let this block or fail the recall response.
      if (result?.results?.length) {
        try {
          const ids = result.results
            .map((r: { id: string }) => r.id)
            .filter((id: unknown): id is string => typeof id === 'string' && id.length > 0);
          if (ids.length) await bridge.bridgeRecordUsage({ entryIds: ids });
        } catch {
          /* non-fatal: usage tracking must never break recall */
        }
      }
      return (
        result ?? {
          results: [],
          error: 'Memory bridge not available. Use memory_pattern-search instead.',
        }
      );
    } catch (error) {
      return { results: [], error: sanitizeError(error) };
    }
  },
};
