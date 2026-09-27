/**
 * V1 Unified Memory Types
 *
 * Type definitions for the unified memory system, backend-agnostic (SQLite via
 * better-sqlite3/sql.js as of 2026-07; LanceDB support was fully removed).
 * SQLiteBackend.search() is brute-force cosine similarity by design; the
 * standalone pure-JS HNSWIndex exists for ANN search but isn't wired into
 * the default search path (see the honesty review's HNSW growth plan).
 *
 * File-size sweep: split into sibling modules (types-core.ts, types-backend.ts,
 * types-misc.ts). This file remains the entry point and re-exports everything
 * that used to live here so every existing import keeps working.
 *
 * @module v1/memory/types
 */

export type {
  BackendStats,
  CacheConfig,
  CachedEntry,
  CacheStats,
  ComponentHealth,
  HealthCheckResult,
  HNSWConfig,
  HNSWStats,
  IMemoryBackend,
  QuantizationConfig,
} from './types-backend.js';
export type {
  AccessLevel,
  ConsistencyLevel,
  DistanceMetric,
  MemoryEntry,
  MemoryEntryInput,
  MemoryEntryUpdate,
  MemoryQuery,
  MemoryTier,
  MemoryType,
  QueryType,
  SearchOptions,
  SearchResult,
} from './types-core.js';
export type {
  EmbeddingGenerator,
  Episode,
  EpisodicStoreConfig,
  LearningPattern,
  MemoryEvent,
  MemoryEventHandler,
  MemoryEventType,
  MigrationConfig,
  MigrationError,
  MigrationProgress,
  MigrationResult,
  MigrationSource,
  SONAMode,
  TierManagerConfig,
} from './types-misc.js';
export {
  createDefaultEntry,
  generateMemoryId,
  PERFORMANCE_TARGETS,
} from './types-misc.js';
