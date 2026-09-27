/**
 * Hooks embedding — lazy-loaded real search/store functions and neural module loaders.
 * Extracted from hooks-embedding.ts.
 */

import { join } from 'node:path';
import { getProjectCwd } from './types.js';

// Base dir for per-route outcome records — sits alongside routing-outcomes.json
export function getRouteOutcomesBaseDir(): string {
  return join(getProjectCwd(), '.monomind');
}

// Real vector search functions - lazy loaded to avoid circular imports
let searchEntriesFn:
  | ((options: {
      query: string;
      namespace?: string;
      limit?: number;
      threshold?: number;
    }) => Promise<{
      success: boolean;
      results: { id: string; key: string; content: string; score: number; namespace: string }[];
      searchTime: number;
      error?: string;
    }>)
  | null = null;

export async function getRealSearchFunction() {
  if (!searchEntriesFn) {
    try {
      const { searchEntries } = await import('../memory/memory-initializer.js');
      searchEntriesFn = searchEntries;
    } catch {
      searchEntriesFn = null;
    }
  }
  return searchEntriesFn;
}

// Real store function - lazy loaded
let storeEntryFn:
  | ((options: {
      key: string;
      value: string;
      namespace?: string;
      generateEmbeddingFlag?: boolean;
      tags?: string[];
      ttl?: number;
    }) => Promise<{
      success: boolean;
      id: string;
      embedding?: { dimensions: number; model: string };
      error?: string;
    }>)
  | null = null;

export async function getRealStoreFunction() {
  if (!storeEntryFn) {
    try {
      const { storeEntry } = await import('../memory/memory-initializer.js');
      storeEntryFn = storeEntry;
    } catch {
      storeEntryFn = null;
    }
  }
  return storeEntryFn;
}

// =============================================================================
// Neural Module Lazy Loaders (SONA, EWC++, MoE, LoRA, Flash Attention)
// =============================================================================

// SONA Optimizer - lazy loaded
let sonaOptimizer: Awaited<
  ReturnType<typeof import('../memory/sona-optimizer.js').getSONAOptimizer>
> | null = null;
export async function getSONAOptimizer() {
  if (!sonaOptimizer) {
    try {
      const { getSONAOptimizer: getSona } = await import('../memory/sona-optimizer.js');
      sonaOptimizer = await getSona();
    } catch {
      sonaOptimizer = null;
    }
  }
  return sonaOptimizer;
}

// EWC++ Consolidator - lazy loaded
let ewcConsolidator: Awaited<
  ReturnType<typeof import('../memory/ewc-consolidation.js').getEWCConsolidator>
> | null = null;
export async function getEWCConsolidator() {
  if (!ewcConsolidator) {
    try {
      const { getEWCConsolidator: getEWC } = await import('../memory/ewc-consolidation.js');
      ewcConsolidator = await getEWC();
    } catch {
      ewcConsolidator = null;
    }
  }
  return ewcConsolidator;
}

export function generateSimpleEmbedding(text: string, dimension: number = 384): Float32Array {
  // Simple deterministic embedding based on character codes
  // This is for routing purposes where we need consistent, fast embeddings
  const embedding = new Float32Array(dimension);
  const normalized = text.toLowerCase().replace(/[^a-z0-9\s]/g, '');
  const words = normalized.split(/\s+/).filter((w) => w.length > 0);

  // Combine word-level and character-level features
  for (let i = 0; i < dimension; i++) {
    let value = 0;

    // Word-level features
    for (let w = 0; w < words.length; w++) {
      const word = words[w];
      for (let c = 0; c < word.length; c++) {
        const charCode = word.charCodeAt(c);
        value += Math.sin((charCode * (i + 1) + w * 17 + c * 23) * 0.0137);
      }
    }

    // Character-level features
    for (let c = 0; c < text.length; c++) {
      value += Math.cos((text.charCodeAt(c) * (i + 1) + c * 7) * 0.0073);
    }

    embedding[i] = value / Math.max(1, text.length);
  }

  // Normalize
  let norm = 0;
  for (let i = 0; i < dimension; i++) {
    norm += embedding[i] * embedding[i];
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < dimension; i++) {
      embedding[i] /= norm;
    }
  }

  return embedding;
}
