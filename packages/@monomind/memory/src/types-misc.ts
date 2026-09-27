/**
 * V1 Unified Memory Types — migration, events, SONA, and utility types
 * Split out of types.ts (file-size sweep). Pure move.
 *
 * @module v1/memory/types
 */

import type { MemoryEntry, MemoryEntryInput, MemoryType } from './types-core.js';

// ===== Migration Types =====

/**
 * Migration source type
 */
export type MigrationSource =
  | 'sqlite'
  | 'markdown'
  | 'json'
  | 'memory-manager'
  | 'monoswarm-memory'
  | 'distributed-memory';

/**
 * Migration configuration
 */
export interface MigrationConfig {
  /** Source backend type */
  source: MigrationSource;

  /** Source path or connection string */
  sourcePath: string;

  /** Batch size for migration */
  batchSize: number;

  /** Generate embeddings during migration */
  generateEmbeddings: boolean;

  /** Validate data during migration */
  validateData: boolean;

  /** Continue on error */
  continueOnError: boolean;

  /** Namespace mapping */
  namespaceMapping?: Record<string, string>;

  /** Type mapping */
  typeMapping?: Record<string, MemoryType>;
}

/**
 * Migration progress
 */
export interface MigrationProgress {
  /** Total entries to migrate */
  total: number;

  /** Entries migrated so far */
  migrated: number;

  /** Entries failed */
  failed: number;

  /** Entries skipped */
  skipped: number;

  /** Current batch number */
  currentBatch: number;

  /** Total batches */
  totalBatches: number;

  /** Progress percentage (0-100) */
  percentage: number;

  /** Estimated time remaining in milliseconds */
  estimatedTimeRemaining: number;

  /** Errors encountered */
  errors: MigrationError[];
}

/**
 * Migration error
 */
export interface MigrationError {
  /** Entry ID or key that failed */
  entryId: string;

  /** Error message */
  message: string;

  /** Error code */
  code: string;

  /** Whether the error is recoverable */
  recoverable: boolean;
}

/**
 * Migration result
 */
export interface MigrationResult {
  /** Whether migration completed successfully */
  success: boolean;

  /** Final progress state */
  progress: MigrationProgress;

  /** Total time taken in milliseconds */
  duration: number;

  /** Summary message */
  summary: string;
}

// ===== Event Types =====

/**
 * Memory event types
 */
export type MemoryEventType =
  | 'entry:created'
  | 'entry:updated'
  | 'entry:deleted'
  | 'entry:accessed'
  | 'entry:expired'
  | 'cache:hit'
  | 'cache:miss'
  | 'cache:eviction'
  | 'index:rebuilt'
  | 'migration:started'
  | 'migration:progress'
  | 'migration:completed'
  | 'migration:failed';

/**
 * Memory event payload
 */
export interface MemoryEvent {
  type: MemoryEventType;
  timestamp: number;
  data: Record<string, unknown>;
}

/**
 * Memory event handler
 */
export type MemoryEventHandler = (event: MemoryEvent) => void | Promise<void>;

// ===== SONA Integration Types =====

/**
 * SONA learning mode for adaptive memory
 */
export type SONAMode =
  | 'real-time' // <0.05ms adaptation
  | 'balanced' // Balance between speed and accuracy
  | 'research' // Maximum accuracy, slower
  | 'edge' // Optimized for edge devices
  | 'batch'; // Batch processing mode

/**
 * Learning pattern from SONA integration
 */
export interface LearningPattern {
  /** Pattern ID */
  id: string;

  /** Pattern data */
  data: Record<string, unknown>;

  /** SONA mode used */
  mode: SONAMode;

  /** Reward signal */
  reward: number;

  /** Trajectory data */
  trajectory: unknown[];

  /** Adaptation time in milliseconds */
  adaptationTime: number;

  /** Creation timestamp */
  createdAt: number;
}

// ===== Utility Types =====

/**
 * Embedding generator function type
 */
export type EmbeddingGenerator = (content: string) => Promise<Float32Array>;

/**
 * Generates a unique memory ID
 */
export function generateMemoryId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 10);
  return `mem_${timestamp}_${random}`;
}

/**
 * Creates a default memory entry
 */
export function createDefaultEntry(input: MemoryEntryInput): MemoryEntry {
  const now = Date.now();
  return {
    id: generateMemoryId(),
    key: input.key,
    content: input.content,
    type: input.type || 'semantic',
    namespace: input.namespace || 'default',
    tags: input.tags || [],
    metadata: input.metadata || {},
    ownerId: input.ownerId,
    accessLevel: input.accessLevel || 'private',
    createdAt: now,
    updatedAt: now,
    expiresAt: input.expiresAt,
    version: 1,
    references: input.references || [],
    accessCount: 0,
    lastAccessedAt: now,
  };
}

/**
 * Performance targets for V1 memory system
 */
export const PERFORMANCE_TARGETS = {
  /** Maximum vector search time for 100k vectors */
  MAX_SEARCH_TIME_100K: 1, // ms

  /** Maximum write time per entry */
  MAX_WRITE_TIME: 5, // ms

  /** Maximum batch insert time per entry */
  MAX_BATCH_INSERT_TIME: 1, // ms

  /** Target memory reduction from legacy systems */
  MEMORY_REDUCTION_TARGET: 0.5, // 50%

  /** Minimum search improvement over brute force */
  MIN_SEARCH_IMPROVEMENT: 150, // design target, not a measured result

  /** Maximum search improvement over brute force */
  MAX_SEARCH_IMPROVEMENT: 12500, // design target, not a measured result
} as const;

// ===== Multi-Tier Memory Config (Task 09) =====

export interface TierManagerConfig {
  shortTermCapacity: number; // default: 500
  entityStorePath: string; // e.g. './data/memory/entities.jsonl'
  contextualNamespace: string; // default: 'contextual-summaries'
  autoFlushOnSessionEnd: boolean; // default: true
}

// ===== Episodic Memory (Task 11) =====

export interface Episode {
  episodeId: string;
  sessionId: string;
  runIds: string[];
  summary: string;
  startedAt: number; // epoch ms
  endedAt: number; // epoch ms
  agentSlugs: string[];
  taskTypes: string[];
  tokenEstimate: number;
}

export interface EpisodicStoreConfig {
  filePath: string; // JSON-lines file path
  maxRunsPerEpisode: number; // close episode after this many runs (default: 20)
  summarizer?: (content: string) => Promise<string>; // optional injected summarizer
}
