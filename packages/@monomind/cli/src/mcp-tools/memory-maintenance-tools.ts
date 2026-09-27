/**
 * Memory MCP tools: memory_consolidate, memory_batch,
 * memory_context_synthesize, memory_semantic_route.
 *
 * Split out of memory-tools.ts, which re-exports these tools and registers them
 * in `memoryTools` in their original order.
 */

import {
  sanitizeError,
  validatePositiveInt,
  validateMcpString as validateString,
} from '../utils/input-guards.js';
import { getBridge, MAX_BATCH_SIZE, MAX_TOP_K } from './memory-tools-shared.js';
import type { MCPTool } from './types.js';

// ===== memory_consolidate — Run memory consolidation =====

export const memoryConsolidate: MCPTool = {
  name: 'memory_consolidate',
  description:
    'Garbage-collect stale, unused memory entries. Weight-aware: entries with high feedback_weight or repeated usage are never collected.',
  inputSchema: {
    type: 'object',
    properties: {
      minAge: {
        type: 'number',
        description: 'Minimum age in hours since last update (optional, default 168 = 7 days)',
      },
      maxEntries: { type: 'number', description: 'Maximum entries to scan (optional)' },
      namespace: {
        type: 'string',
        description: "Namespace to GC, or 'all' for every non-protected namespace (optional)",
      },
    },
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const bridge = await getBridge();
      // Reject NaN and Infinity. typeof === 'number' returns true for both.
      // NaN propagates through arithmetic and corrupts consolidation accounting;
      // Infinity makes `entry.age >= minAge` always false, silently no-op.
      // The bridge expects MILLISECONDS; this param is documented in hours —
      // convert here (previously passed through raw, so 720 hours became 720ms).
      const minAge =
        typeof params.minAge === 'number' && Number.isFinite(params.minAge)
          ? Math.max(0, Math.min(params.minAge, 24 * 365 * 10)) * 3600 * 1000
          : undefined;
      const result = await bridge.bridgeConsolidate({
        minAge,
        maxEntries:
          params.maxEntries !== undefined
            ? validatePositiveInt(params.maxEntries, 1000, 10_000)
            : undefined,
        namespace: validateString(params.namespace, 'namespace', 128) ?? undefined,
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

// ===== memory_batch — Batch operations (insert, update, delete) =====

export const memoryBatch: MCPTool = {
  name: 'memory_batch',
  description: 'Batch operations on memory entries (insert, update, delete)',
  inputSchema: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        description: 'Batch operation type',
        enum: ['insert', 'update', 'delete'],
      },
      entries: {
        type: 'array',
        description: 'Array of {key, value} entries to operate on',
        items: {
          type: 'object',
          properties: {
            key: { type: 'string' },
            value: { type: 'string' },
          },
          required: ['key'],
        },
      },
    },
    required: ['operation', 'entries'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const operation = validateString(params.operation, 'operation', 20);
      if (!operation) return { success: false, error: 'operation is required (string)' };
      if (!['insert', 'update', 'delete'].includes(operation)) {
        return {
          success: false,
          error: `Invalid operation: ${operation}. Must be insert, update, or delete`,
        };
      }
      if (!Array.isArray(params.entries) || params.entries.length === 0) {
        return { success: false, error: 'entries is required (non-empty array)' };
      }
      if (params.entries.length > MAX_BATCH_SIZE) {
        return {
          success: false,
          error: `Too many entries: ${params.entries.length}. Max is ${MAX_BATCH_SIZE}`,
        };
      }
      // Validate each entry. Aggregate-byte cap prevents 500 entries × 100KB
      // values = 50MB single-call payloads from spiking Node heap to ~200MB
      // (UTF-16 doubling + downstream copies in the bridge layer).
      const MAX_BATCH_BYTES = 1_048_576; // 1 MiB total
      let totalBytes = 0;
      const validatedEntries: Array<{
        key: string;
        value?: string;
        metadata?: Record<string, unknown>;
      }> = [];
      for (let i = 0; i < params.entries.length; i++) {
        const entry = params.entries[i];
        if (!entry || typeof entry !== 'object') {
          return { success: false, error: `entries[${i}] must be an object` };
        }
        const key = validateString((entry as any).key, `entries[${i}].key`, 1000);
        if (!key)
          return { success: false, error: `entries[${i}].key is required (non-empty string)` };
        const value = validateString((entry as any).value, `entries[${i}].value`);
        totalBytes += key.length + (value?.length ?? 0);
        if (totalBytes > MAX_BATCH_BYTES) {
          return { success: false, error: `Batch payload exceeds ${MAX_BATCH_BYTES} bytes` };
        }
        validatedEntries.push({ key, value: value ?? undefined });
      }
      const bridge = await getBridge();
      const result = await bridge.bridgeBatchOperation({
        operation,
        entries: validatedEntries,
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

// ===== memory_context_synthesize — Synthesize context from memories =====

export const memoryContextSynthesize: MCPTool = {
  name: 'memory_context-synthesize',
  description:
    'Concatenate top matching memories into a context block for a query (no summarization)',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Query to synthesize context for' },
      maxEntries: { type: 'number', description: 'Maximum entries to include (default: 10)' },
    },
    required: ['query'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const query = validateString(params.query, 'query', 10_000);
      if (!query)
        return { success: false, error: 'query is required (non-empty string, max 10KB)' };

      // validateExternalContent: guard against prompt injection in synthesized context
      // Source: https://arxiv.org/abs/2302.12173, https://arxiv.org/abs/2310.12815
      {
        const { validateExternalContent } = await import('../utils/input-guards.js');
        const check = await validateExternalContent(query, 'memory_context-synthesize query');
        if (!check.safe) {
          return {
            success: false,
            error: `Injection guard: ${check.reason}`,
            injectionDetected: true,
          };
        }
      }

      const bridge = await getBridge();
      const result = await bridge.bridgeContextSynthesize({
        query,
        maxEntries: validatePositiveInt(params.maxEntries, 10, MAX_TOP_K),
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

// ===== memory_semantic_route — Route via SemanticRouter =====

export const memorySemanticRoute: MCPTool = {
  name: 'memory_semantic-route',
  description: 'Route an input via SemanticRouter for intent classification',
  inputSchema: {
    type: 'object',
    properties: {
      input: { type: 'string', description: 'Input text to route' },
    },
    required: ['input'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const input = validateString(params.input, 'input', 10_000);
      if (!input) return { route: null, error: 'input is required (non-empty string, max 10KB)' };
      const bridge = await getBridge();
      const result = await bridge.bridgeSemanticRoute({ input });
      return (
        result ?? { route: null, error: 'Memory bridge not available. Use hooks route instead.' }
      );
    } catch (error) {
      return { route: null, error: sanitizeError(error) };
    }
  },
};
