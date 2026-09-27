// Split out of index.ts (file-size sweep). Pure move: no behaviour change.

// =============================================================================
// Module Exports
// =============================================================================

// Commands (internal use)
export * from './commands/index.js';
// MCP Server management
export {
  createMCPServerManager,
  getMCPServerStatus,
  getServerManager,
  MCPServerManager,
  type MCPServerOptions,
  type MCPServerStatus,
  startMCPServer,
  stopMCPServer,
} from './mcp-server.js';
export {
  benchmarkAdaptation,
  clearAllPatterns,
  clearIntelligence,
  deletePattern,
  distillLearning,
  // RL loop API
  endTrajectoryWithVerdict,
  findSimilarPatterns,
  flushPatterns,
  // Pattern persistence API
  getAllPatterns,
  getIntelligenceStats,
  getNeuralDataDir,
  getPatternsByType,
  getPersistenceStatus,
  getReasoningBank,
  getSonaCoordinator,
  type IntelligenceStats,
  initializeIntelligence,
  type Pattern,
  recordStep,
  recordTrajectory,
  type SonaConfig,
  type TrajectoryStep,
} from './memory/intelligence.js';
// Memory & Intelligence (V1 Performance Features)
export {
  // Batched cosine similarity operations
  batchCosineSim,
  dequantizeInt8,
  flashAttentionSearch,
  forceBuildHNSWIndex,
  generateBatchEmbeddings,
  generateEmbedding,
  getHNSWStatus,
  getQuantizationStats,
  initializeMemoryDatabase,
  type MemoryInitResult,
  quantizedCosineSim,
  quantizeInt8,
  searchEntries,
  softmaxAttention,
  storeEntry,
  topKIndices,
} from './memory/memory-initializer.js';
// Output
export { OutputFormatter, output, Progress, Spinner, type VerbosityLevel } from './output.js';
// Parser
export { CommandParser, commandParser } from './parser.js';
// Prompt
export * from './prompt.js';
// Types
export * from './types.js';
