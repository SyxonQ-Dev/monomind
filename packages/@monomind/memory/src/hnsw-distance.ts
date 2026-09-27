/**
 * V1 HNSW Vector Index — distance metrics
 *
 * Split out of hnsw-index.ts (file-size sweep). Pure move: the method bodies
 * are unchanged; state previously reached via `this` (the configured metric,
 * a node's normalized vector) is now passed in explicitly by the caller.
 *
 * @module v1/memory/hnsw-distance
 */

import type { HNSWNode } from './hnsw-index.js';
import type { DistanceMetric } from './types.js';

export function distance(metric: DistanceMetric, a: Float32Array, b: Float32Array): number {
  switch (metric) {
    case 'cosine':
      return cosineDistance(a, b);
    case 'euclidean':
      return euclideanDistance(a, b);
    case 'dot':
      return dotProductDistance(a, b);
    case 'manhattan':
      return manhattanDistance(a, b);
    default:
      return cosineDistance(a, b);
  }
}

export function cosineDistance(a: Float32Array, b: Float32Array): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 1; // zero vector has maximum distance
  const similarity = dotProduct / denom;
  return 1 - similarity; // Convert to distance
}

/**
 * OPTIMIZED: Cosine distance using pre-normalized vectors
 * Only requires dot product (no sqrt operations)
 * Performance: O(n) with ~2x speedup over standard cosine
 */
export function cosineDistanceNormalized(a: Float32Array, b: Float32Array): number {
  let dotProduct = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
  }
  // For normalized vectors: cosine_similarity = dot_product
  // Return distance (1 - similarity)
  return 1 - dotProduct;
}

/**
 * Normalize a vector to unit length for O(1) cosine similarity
 */
export function normalizeVector(vector: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < vector.length; i++) {
    const v = Number.isFinite(vector[i]) ? vector[i] : 0;
    norm += v * v;
  }
  norm = Math.sqrt(norm);

  if (norm === 0 || !Number.isFinite(norm)) {
    return new Float32Array(vector.length); // safe zero vector for non-finite input
  }

  const normalized = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i++) {
    normalized[i] = (Number.isFinite(vector[i]) ? vector[i] : 0) / norm;
  }
  return normalized;
}

/**
 * OPTIMIZED distance calculation that uses pre-normalized vectors when available
 */
export function distanceOptimized(
  metric: DistanceMetric,
  query: Float32Array,
  normalizedQuery: Float32Array | null,
  node: HNSWNode,
): number {
  // Use optimized path for cosine with pre-normalized vectors
  if (metric === 'cosine' && normalizedQuery !== null && node.normalizedVector !== null) {
    return cosineDistanceNormalized(normalizedQuery, node.normalizedVector);
  }

  // Fall back to standard distance calculation
  return distance(metric, query, node.vector);
}

export function euclideanDistance(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

export function dotProductDistance(a: Float32Array, b: Float32Array): number {
  let dotProduct = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
  }
  // Negative because higher dot product = more similar
  return -dotProduct;
}

export function manhattanDistance(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += Math.abs(a[i] - b[i]);
  }
  return sum;
}
