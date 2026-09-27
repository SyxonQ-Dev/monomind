/**
 * Memory MCP Tools — Phase 6 of ADR-053
 *
 * Exposes Memory backend operations as MCP tools: pattern store/search,
 * usage-weighted feedback (EWMA), the conversation knowledge graph
 * (memory_kg_*), session records, weight-aware GC, and bridge health.
 *
 * Security: All handlers validate input types, enforce length bounds,
 * and sanitize error messages before returning to MCP callers.
 *
 * The tools live in family modules (memory-core-tools.ts, memory-kg-tools.ts,
 * memory-session-tools.ts, memory-maintenance-tools.ts, with shared helpers in
 * memory-tools-shared.ts); this module re-exports them and registers them in
 * `memoryTools` in their original order.
 *
 * @module v1/cli/mcp-tools/memory-tools
 */

import {
  memoryControllers,
  memoryFeedback,
  memoryHealth,
  memoryPatternSearch,
  memoryPatternStore,
} from './memory-core-tools.js';
import {
  causalEdgeOriginRef,
  memoryCausalEdge,
  memoryKgConsolidate,
  memoryKgIngest,
  memoryKgRollback,
  memoryKgSearch,
  memoryKgStats,
} from './memory-kg-tools.js';
import {
  memoryBatch,
  memoryConsolidate,
  memoryContextSynthesize,
  memorySemanticRoute,
} from './memory-maintenance-tools.js';
import {
  memoryHierarchicalRecall,
  memoryHierarchicalStore,
  memoryRoute,
  memorySessionEnd,
  memorySessionStart,
} from './memory-session-tools.js';
import type { MCPTool } from './types.js';

export {
  causalEdgeOriginRef,
  memoryBatch,
  memoryCausalEdge,
  memoryConsolidate,
  memoryContextSynthesize,
  memoryControllers,
  memoryFeedback,
  memoryHealth,
  memoryHierarchicalRecall,
  memoryHierarchicalStore,
  memoryKgConsolidate,
  memoryKgIngest,
  memoryKgRollback,
  memoryKgSearch,
  memoryKgStats,
  memoryPatternSearch,
  memoryPatternStore,
  memoryRoute,
  memorySemanticRoute,
  memorySessionEnd,
  memorySessionStart,
};

// ===== Export all tools =====

export const memoryTools: MCPTool[] = [
  memoryHealth,
  memoryControllers,
  memoryPatternStore,
  memoryPatternSearch,
  memoryFeedback,
  memoryCausalEdge,
  memoryKgIngest,
  memoryKgSearch,
  memoryKgRollback,
  memoryKgConsolidate,
  memoryKgStats,
  memoryRoute,
  memorySessionStart,
  memorySessionEnd,
  memoryHierarchicalStore,
  memoryHierarchicalRecall,
  memoryConsolidate,
  memoryBatch,
  memoryContextSynthesize,
  memorySemanticRoute,
];
