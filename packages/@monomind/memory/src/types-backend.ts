/**
 * V1 Unified Memory Types — HNSW index, backend interface, and cache types
 * Split out of types.ts (file-size sweep). Pure move.
 *
 * @module v1/memory/types
 */

import type {
  DistanceMetric,
  MemoryEntry,
  MemoryEntryUpdate,
  MemoryQuery,
  MemoryType,
  SearchOptions,
  SearchResult,
} from './types-core.js';

// ===== HNSW Index Types =====

/**
 * HNSW index configuration
 */
export interface HNSWConfig {
  /** Vector dimensions (e.g., 1536 for OpenAI embeddings) */
  dimensions: number;

  /** Maximum number of connections per layer (default: 16) */
  M: number;

  /** Size of the dynamic candidate list during construction (default: 200) */
  efConstruction: number;

  /** Maximum elements the index can hold */
  maxElements: number;

  /** Distance metric */
  metric: DistanceMetric;

  /** Enable quantization for memory efficiency */
  quantization?: QuantizationConfig;
}

/**
 * Quantization configuration for memory reduction
 */
export interface QuantizationConfig {
  /** Quantization type */
  type: 'binary' | 'scalar' | 'product';

  /** Number of bits for scalar quantization */
  bits?: 4 | 8 | 16;

  /** Number of subquantizers for product quantization */
  subquantizers?: number;

  /** Codebook size for product quantization */
  codebookSize?: number;
}

/**
 * HNSW index statistics
 */
export interface HNSWStats {
  /** Total number of vectors in the index */
  vectorCount: number;

  /** Memory usage in bytes */
  memoryUsage: number;

  /** Average search time in milliseconds */
  avgSearchTime: number;

  /** Index build time in milliseconds */
  buildTime: number;

  /** Compression ratio if quantization is enabled */
  compressionRatio?: number;
}

// ===== Backend Interface =====

/**
 * Memory backend interface for storage and retrieval
 */
export interface IMemoryBackend {
  /** Initialize the backend */
  initialize(): Promise<void>;

  /** Shutdown the backend */
  shutdown(): Promise<void>;

  /** Store a memory entry */
  store(entry: MemoryEntry): Promise<void>;

  /** Retrieve a memory entry by ID */
  get(id: string): Promise<MemoryEntry | null>;

  /** Retrieve a memory entry by key within a namespace */
  getByKey(namespace: string, key: string): Promise<MemoryEntry | null>;

  /** Update a memory entry */
  update(id: string, update: MemoryEntryUpdate): Promise<MemoryEntry | null>;

  /** Delete a memory entry */
  delete(id: string): Promise<boolean>;

  /** Query memory entries */
  query(query: MemoryQuery): Promise<MemoryEntry[]>;

  /** Semantic vector search */
  search(embedding: Float32Array, options: SearchOptions): Promise<SearchResult[]>;

  /** Bulk insert entries */
  bulkInsert(entries: MemoryEntry[]): Promise<void>;

  /** Bulk delete entries */
  bulkDelete(ids: string[]): Promise<number>;

  /** Get entry count */
  count(namespace?: string): Promise<number>;

  /** List all namespaces */
  listNamespaces(): Promise<string[]>;

  /** Clear all entries in a namespace */
  clearNamespace(namespace: string): Promise<number>;

  /** Get backend statistics */
  getStats(): Promise<BackendStats>;

  /** Perform health check */
  healthCheck(): Promise<HealthCheckResult>;
}

/**
 * Backend statistics
 */
export interface BackendStats {
  /** Total number of entries */
  totalEntries: number;

  /** Entries by namespace */
  entriesByNamespace: Record<string, number>;

  /** Entries by type */
  entriesByType: Record<MemoryType, number>;

  /** Total memory usage in bytes */
  memoryUsage: number;

  /** HNSW index statistics */
  hnswStats?: HNSWStats;

  /** Cache statistics */
  cacheStats?: CacheStats;

  /** Average query time in milliseconds */
  avgQueryTime: number;

  /** Average search time in milliseconds */
  avgSearchTime: number;
}

/**
 * Health check result
 */
export interface HealthCheckResult {
  /** Overall health status */
  status: 'healthy' | 'degraded' | 'unhealthy';

  /** Backend mode in use */
  mode?: 'pure-ts-fallback';

  /** Individual component health */
  components: {
    storage: ComponentHealth;
    index: ComponentHealth;
    cache: ComponentHealth;
  };

  /** Health check timestamp */
  timestamp: number;

  /** Any issues detected */
  issues: string[];

  /** Recommendations for improvement */
  recommendations: string[];
}

/**
 * Individual component health status
 */
export interface ComponentHealth {
  status: 'healthy' | 'degraded' | 'unhealthy';
  latency: number;
  message?: string;
}

// ===== Cache Types =====

/**
 * Cache configuration
 */
export interface CacheConfig {
  /** Maximum number of entries in the cache */
  maxSize: number;

  /** Default TTL in milliseconds */
  ttl: number;

  /** Enable LRU eviction */
  lruEnabled: boolean;

  /** Maximum memory usage in bytes */
  maxMemory?: number;

  /** Enable write-through caching */
  writeThrough: boolean;
}

/**
 * Cache statistics
 */
export interface CacheStats {
  /** Number of entries in cache */
  size: number;

  /** Cache hit rate (0-1) */
  hitRate: number;

  /** Total cache hits */
  hits: number;

  /** Total cache misses */
  misses: number;

  /** Total evictions */
  evictions: number;

  /** Memory usage in bytes */
  memoryUsage: number;
}

/**
 * Cached entry wrapper
 */
export interface CachedEntry<T> {
  /** The cached data */
  data: T;

  /** When the entry was cached */
  cachedAt: number;

  /** When the entry expires */
  expiresAt: number;

  /** Last access timestamp */
  lastAccessedAt: number;

  /** Access count */
  accessCount: number;
}
