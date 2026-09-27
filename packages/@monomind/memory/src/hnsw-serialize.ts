/**
 * V1 HNSW Vector Index — graph (de)serialization
 *
 * Split out of hnsw-index.ts (file-size sweep). Pure move: the method bodies
 * are unchanged; the node map, config, entry point and max level previously
 * reached via `this` are now passed in explicitly by the caller.
 *
 * @module v1/memory/hnsw-serialize
 */

import { normalizeVector } from './hnsw-distance.js';
import type { HNSWNode } from './hnsw-index.js';
import type { HNSWConfig } from './types.js';

/**
 * On-disk representation produced by HNSWIndex.serialize() / consumed by
 * HNSWIndex.deserialize(). `version` guards against loading a shape from a
 * future/incompatible format.
 */
export interface HNSWSerialized {
  version: 1;
  config: HNSWConfig;
  entryPoint: string | null;
  maxLevel: number;
  nodes: Array<{
    id: string;
    vectorB64: string;
    level: number;
    connections: Array<[number, string[]]>;
  }>;
}

/**
 * Serialize the built graph (config, entry point, and every node's vector +
 * per-level connections) so a caller can persist it to disk and reconstruct
 * an identical index later without re-inserting every point. Vectors are
 * base64-encoded Float32 bytes rather than JSON number arrays to keep the
 * serialized size and parse cost down for large indexes.
 */
export function serializeGraph(
  nodes: Map<string, HNSWNode>,
  config: HNSWConfig,
  entryPoint: string | null,
  maxLevel: number,
): HNSWSerialized {
  const nodesOut: HNSWSerialized['nodes'] = [];
  for (const node of nodes.values()) {
    const buf = Buffer.from(node.vector.buffer, node.vector.byteOffset, node.vector.byteLength);
    nodesOut.push({
      id: node.id,
      vectorB64: buf.toString('base64'),
      level: node.level,
      connections: Array.from(node.connections.entries()).map(([lvl, set]) => [
        lvl,
        Array.from(set),
      ]),
    });
  }
  return {
    version: 1,
    config,
    entryPoint,
    maxLevel,
    nodes: nodesOut,
  };
}

/** Reconstruct the node map from data previously produced by serializeGraph(). */
export function deserializeNodes(data: HNSWSerialized): Map<string, HNSWNode> {
  const nodes = new Map<string, HNSWNode>();
  for (const n of data.nodes) {
    const buf = Buffer.from(n.vectorB64, 'base64');
    const vector = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    const normalizedVector = data.config.metric === 'cosine' ? normalizeVector(vector) : null;
    const connections = new Map<number, Set<string>>();
    for (const [lvl, ids] of n.connections) connections.set(lvl, new Set(ids));
    nodes.set(n.id, { id: n.id, vector, normalizedVector, connections, level: n.level });
  }
  return nodes;
}
