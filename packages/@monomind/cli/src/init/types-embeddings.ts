/**
 * V1 Init System Types — embeddings configuration.
 * File-size sweep: split out of types.ts.
 */

/**
 * The embedding model and dimensions the memory bridge embeds with
 * (BRIDGE_EMBEDDING_MODEL / BRIDGE_EMBEDDING_DIMS in memory/memory-bridge-core.ts —
 * a test keeps them equal). Duplicated here, not imported, because many tests
 * mock memory-bridge and these values are read at module load.
 */
export const DEFAULT_EMBEDDING_MODEL = 'Alibaba-NLP/gte-modernbert-base';
export const DEFAULT_EMBEDDING_DIMS = 768;

/**
 * Embeddings configuration
 */
export interface EmbeddingsConfig {
  /** Enable embedding subsystem */
  enabled: boolean;
  /** ONNX model ID — defaults to the model the memory bridge embeds with */
  model:
    | 'Alibaba-NLP/gte-modernbert-base'
    | 'Xenova/all-MiniLM-L6-v2'
    | 'Xenova/all-mpnet-base-v2'
    | 'Xenova/bge-small-en-v1.5'
    | string;
  /** Enable hyperbolic (Poincaré ball) embeddings */
  hyperbolic: boolean;
  /** Poincaré ball curvature (negative value, typically -1) */
  curvature: number;
  /** Pre-download model during init */
  predownload: boolean;
  /** LRU cache size (number of embeddings) */
  cacheSize: number;
  /** Enable neural substrate integration */
  neuralSubstrate: boolean;
}
