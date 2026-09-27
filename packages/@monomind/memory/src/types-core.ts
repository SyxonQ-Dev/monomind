/**
 * V1 Unified Memory Types — core entry and query types
 * Split out of types.ts (file-size sweep). Pure move.
 *
 * @module v1/memory/types
 */

// ===== Core Memory Entry Types =====

/**
 * Memory entry type classification
 */
export type MemoryType =
  | 'episodic' // Time-based experiences and events
  | 'semantic' // Facts, concepts, and knowledge
  | 'working' // Short-term operational memory
  | 'cache'; // Temporary cached data

/** Which memory tier this entry belongs to */
export type MemoryTier =
  | 'short-term' // In-memory buffer, current run only
  | 'long-term' // Persistent HNSW, cross-run
  | 'entity' // Named-entity KV facts
  | 'contextual'; // Compressed session summaries

/**
 * Access level for memory entries
 */
export type AccessLevel =
  | 'private' // Only owner can access
  | 'team' // Team members can access
  | 'monoswarm' // All monoswarm agents can access
  | 'public' // Publicly accessible
  | 'system'; // System-level access

/**
 * Consistency level for distributed memory operations
 */
export type ConsistencyLevel =
  | 'strong' // Strong consistency (all nodes agree)
  | 'eventual' // Eventual consistency (propagates over time)
  | 'session' // Session-scoped consistency
  | 'weak'; // Weak consistency (best effort)

/**
 * Distance metrics for vector similarity search
 */
export type DistanceMetric =
  | 'cosine' // Cosine similarity (default)
  | 'euclidean' // Euclidean distance (L2)
  | 'dot' // Dot product
  | 'manhattan'; // Manhattan distance (L1)

// ===== Memory Entry =====

/**
 * Core memory entry structure with vector embedding support
 */
export interface MemoryEntry {
  /** Unique identifier */
  id: string;

  /** Human-readable key for retrieval */
  key: string;

  /** Actual content of the memory */
  content: string;

  /** Vector embedding for semantic search (Float32Array for efficiency) */
  embedding?: Float32Array;

  /** Type of memory */
  type: MemoryType;

  /** Namespace for organization */
  namespace: string;

  /** Tags for categorization and filtering */
  tags: string[];

  /** Additional metadata */
  metadata: Record<string, unknown>;

  /** Owner agent ID */
  ownerId?: string;

  /** Access level */
  accessLevel: AccessLevel;

  /** Creation timestamp */
  createdAt: number;

  /** Last update timestamp */
  updatedAt: number;

  /** Expiration timestamp (optional) */
  expiresAt?: number;

  /** Event time — when the event occurred (vs createdAt = ingestion time).
   *  Bi-temporal model: separates T (event) from T' (record).
   *  Source: https://arxiv.org/abs/2501.13956 (Zep/Graphiti) */
  eventAt?: number;

  /** Version number for optimistic locking */
  version: number;

  /** References to other memory entries */
  references: string[];

  /** Access count for usage tracking */
  accessCount: number;

  /** Importance score for FOREVER forgetting-curve replay (default 1.0) */
  importanceScore?: number;

  /** Last access timestamp */
  lastAccessedAt: number;
}

/**
 * Input for creating a new memory entry
 */
export interface MemoryEntryInput {
  key: string;
  content: string;
  type?: MemoryType;
  namespace?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  ownerId?: string;
  accessLevel?: AccessLevel;
  expiresAt?: number;
  references?: string[];
  tier?: MemoryTier;
}

/**
 * Partial update for a memory entry
 */
export interface MemoryEntryUpdate {
  content?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  accessLevel?: AccessLevel;
  expiresAt?: number;
  references?: string[];
}

// ===== Query Types =====

/**
 * Query type for memory retrieval
 */
export type QueryType =
  | 'semantic' // Vector similarity search
  | 'exact' // Exact key match
  | 'prefix' // Key prefix match
  | 'tag' // Tag-based search
  | 'hybrid'; // Combined semantic + filters

/**
 * Memory query specification
 */
export interface MemoryQuery {
  /** Type of query to perform */
  type: QueryType;

  /** Content for semantic search (will be embedded) */
  content?: string;

  /** Pre-computed embedding for semantic search */
  embedding?: Float32Array;

  /** Exact key to match */
  key?: string;

  /** Key prefix to match */
  keyPrefix?: string;

  /** Namespace filter */
  namespace?: string;

  /** Tag filters (entries must have all specified tags) */
  tags?: string[];

  /** Memory type filter */
  memoryType?: MemoryType;

  /** Access level filter */
  accessLevel?: AccessLevel;

  /** Owner filter */
  ownerId?: string;

  /** Metadata filters */
  metadata?: Record<string, unknown>;

  /** Time range filters (ingestion time) */
  createdAfter?: number;
  createdBefore?: number;
  updatedAfter?: number;
  updatedBefore?: number;

  /**
   * Bi-temporal event-time filters (T vs T').
   * Use these to query by WHEN THE EVENT OCCURRED rather than when it was recorded.
   * Source: arXiv:2501.13956 — Zep/Graphiti bi-temporal knowledge graph.
   */
  eventAfter?: number;
  eventBefore?: number;

  /** Maximum number of results */
  limit: number;

  /** Offset for pagination */
  offset?: number;

  /** Minimum similarity threshold (0-1) for semantic search */
  threshold?: number;

  /** Include expired entries */
  includeExpired?: boolean;

  /** Distance metric for semantic search */
  distanceMetric?: DistanceMetric;

  /** Field to sort results by (backends that support it) */
  sortField?: 'createdAt' | 'updatedAt' | 'lastAccessedAt' | 'accessCount' | 'key' | 'score';

  /** Sort direction — 'desc' (default) or 'asc' */
  sortDirection?: 'asc' | 'desc';
}

/**
 * Search result with similarity score
 */
export interface SearchResult {
  /** The memory entry */
  entry: MemoryEntry;

  /** Similarity score (0-1, higher is better) */
  score: number;

  /** Distance from query vector */
  distance: number;
}

/**
 * Search options for HNSW vector search
 */
export interface SearchOptions {
  /** Number of results to return */
  k: number;

  /** Search expansion factor (higher = more accurate, slower) */
  ef?: number;

  /** Minimum similarity threshold (0-1) */
  threshold?: number;

  /** Distance metric */
  metric?: DistanceMetric;

  /** Additional filters to apply post-search */
  filters?: MemoryQuery;
}
