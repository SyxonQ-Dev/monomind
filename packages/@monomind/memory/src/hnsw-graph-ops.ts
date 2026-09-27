/**
 * V1 HNSW Vector Index — graph search/maintenance operations
 *
 * Split out of hnsw-index.ts (file-size sweep). Pure move: the method bodies
 * are unchanged; the node map and configured metric previously reached via
 * `this` are now passed in explicitly by the caller.
 *
 * @module v1/memory/hnsw-graph-ops
 */

import { distance, distanceOptimized } from './hnsw-distance.js';
import { BinaryMaxHeap, BinaryMinHeap } from './hnsw-heap.js';
import type { HNSWNode } from './hnsw-index.js';
import type { DistanceMetric } from './types.js';

/**
 * OPTIMIZED searchLayer using heap-based priority queues
 * Performance: O(log n) per operation vs O(n log n) for Array.sort()
 * Expected speedup: 3-5x for large result sets
 */
export function searchLayerOptimized(
  nodes: Map<string, HNSWNode>,
  metric: DistanceMetric,
  query: Float32Array,
  normalizedQuery: Float32Array | null,
  entryPoint: string,
  ef: number,
  level: number,
): Array<{ id: string; distance: number }> {
  const visited = new Set<string>([entryPoint]);

  // Min-heap for candidates (closest first for expansion)
  const candidates = new BinaryMinHeap<string>();

  // Max-heap for results (bounded size, tracks worst distance efficiently)
  const results = new BinaryMaxHeap<string>(ef);

  const entryNode = nodes.get(entryPoint)!;
  const entryDist = distanceOptimized(metric, query, normalizedQuery, entryNode);

  candidates.insert(entryPoint, entryDist);
  results.insert(entryPoint, entryDist);

  while (!candidates.isEmpty()) {
    // Get closest candidate - O(log n)
    const currentDist = candidates.peekPriority()!;
    const currentId = candidates.extractMin()!;

    // Check termination: if closest candidate is worse than worst result, stop
    const worstResultDist = results.peekMaxPriority();
    if (currentDist > worstResultDist && results.size >= ef) {
      break;
    }

    // Explore neighbors
    const node = nodes.get(currentId);
    if (!node) continue;

    const connections = node.connections.get(level);
    if (!connections) continue;

    for (const neighborId of connections) {
      if (visited.has(neighborId)) continue;
      visited.add(neighborId);

      const neighborNode = nodes.get(neighborId);
      if (!neighborNode) continue;

      const dist = distanceOptimized(metric, query, normalizedQuery, neighborNode);

      // Only add if within threshold or results not full
      if (results.size < ef || dist < worstResultDist) {
        candidates.insert(neighborId, dist);
        // Max-heap handles size bounding automatically - O(log n)
        results.insert(neighborId, dist);
      }
    }
  }

  // Return sorted results
  return results.toSortedArray().map(({ item, priority }) => ({
    id: item,
    distance: priority,
  }));
}

export function selectNeighbors(
  nodeId: string,
  _query: Float32Array,
  candidates: Array<{ id: string; distance: number }>,
  M: number,
): Array<{ id: string; distance: number }> {
  // candidates arrive distance-ascending from searchLayerOptimized/toSortedArray;
  // filter preserves that order, so no additional sort is needed.
  return candidates.filter((c) => c.id !== nodeId).slice(0, M);
}

export function pruneConnections(
  nodes: Map<string, HNSWNode>,
  metric: DistanceMetric,
  node: HNSWNode,
  level: number,
  maxConnections: number,
): void {
  const connections = node.connections.get(level);
  if (!connections || connections.size <= maxConnections) return;

  // Calculate distances to all connections
  const distances: Array<{ id: string; distance: number }> = [];
  for (const connId of connections) {
    const connNode = nodes.get(connId);
    if (connNode) {
      distances.push({
        id: connId,
        distance: distance(metric, node.vector, connNode.vector),
      });
    }
  }

  // Keep only the closest ones
  distances.sort((a, b) => a.distance - b.distance);
  const toKeep = new Set(distances.slice(0, maxConnections).map((d) => d.id));

  // Remove excess connections
  for (const connId of connections) {
    if (!toKeep.has(connId)) {
      connections.delete(connId);
      nodes.get(connId)?.connections.get(level)?.delete(node.id);
    }
  }
}
