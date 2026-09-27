/**
 * Hooks embedding — legacy JSON memory store and intelligence stats.
 * Extracted from hooks-embedding.ts.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getProjectCwd } from './types.js';

// Memory store types and helpers
export interface MemoryEntry {
  key: string;
  value: unknown;
  metadata?: Record<string, unknown>;
  storedAt: string;
  accessCount: number;
  lastAccessed: string;
}

export interface MemoryStore {
  entries: Record<string, MemoryEntry>;
  version: string;
}

export const MEMORY_DIR = '.monomind/memory';
export const MEMORY_FILE = 'store.json';

export function getMemoryPath(): string {
  return join(getProjectCwd(), MEMORY_DIR, MEMORY_FILE);
}

// Maximum size of the legacy JSON memory store before reads are skipped.
// Matches the guard in memory-tools.ts (loadLegacyStore) which loads the same file.
export const MAX_MEMORY_STORE_BYTES = 50 * 1024 * 1024; // 50 MB

export function loadMemoryStore(): MemoryStore {
  try {
    const path = getMemoryPath();
    if (existsSync(path) && statSync(path).size <= MAX_MEMORY_STORE_BYTES) {
      const data = readFileSync(path, 'utf-8');
      return JSON.parse(data);
    }
  } catch (e) {
    // Return empty store on error
    if (process.env.DEBUG || process.env.MONOMIND_DEBUG)
      console.error('[hooks-embedding] memory store.json read/parse failed:', e);
  }
  return { entries: {}, version: '3.0.0' };
}

/**
 * Get real intelligence statistics from memory store
 */
export function getIntelligenceStatsFromMemory(): {
  trajectories: { total: number; successful: number };
  patterns: { learned: number; categories: Record<string, number> };
  memory: { indexSize: number; totalAccessCount: number; memorySizeBytes: number };
  routing: { decisions: number; avgConfidence: number };
} {
  const store = loadMemoryStore();
  const entries = Object.values(store.entries);

  // Count trajectories (keys starting with "trajectory-" or containing trajectory data)
  const trajectoryEntries = entries.filter(
    (e) => e.key.includes('trajectory') || e.metadata?.type === 'trajectory',
  );
  const successfulTrajectories = trajectoryEntries.filter(
    (e) =>
      e.metadata?.success === true ||
      (typeof e.value === 'object' &&
        e.value !== null &&
        (e.value as Record<string, unknown>).success === true),
  );

  // Count patterns
  const patternEntries = entries.filter(
    (e) =>
      e.key.includes('pattern') || e.metadata?.type === 'pattern' || e.key.startsWith('learned-'),
  );

  // Categorize patterns
  const categories: Record<string, number> = {};
  patternEntries.forEach((e) => {
    const category = (e.metadata?.category as string) || 'general';
    categories[category] = (categories[category] || 0) + 1;
  });

  // Count routing decisions
  const routingEntries = entries.filter(
    (e) => e.key.includes('routing') || e.metadata?.type === 'routing-decision',
  );

  // Calculate average confidence from routing decisions
  let totalConfidence = 0;
  let confidenceCount = 0;
  routingEntries.forEach((e) => {
    const confidence = e.metadata?.confidence as number;
    if (typeof confidence === 'number') {
      totalConfidence += confidence;
      confidenceCount++;
    }
  });

  // Calculate total access count
  const totalAccessCount = entries.reduce((sum, e) => sum + (e.accessCount || 0), 0);

  // Calculate memory file size
  let memorySizeBytes = 0;
  try {
    const memPath = getMemoryPath();
    if (existsSync(memPath)) {
      memorySizeBytes = statSync(memPath).size;
    }
  } catch {
    // Ignore
  }

  return {
    trajectories: {
      total: trajectoryEntries.length,
      successful: successfulTrajectories.length,
    },
    patterns: {
      learned: patternEntries.length,
      categories,
    },
    memory: {
      indexSize: entries.length,
      totalAccessCount,
      memorySizeBytes,
    },
    routing: {
      decisions: routingEntries.length,
      avgConfidence: confidenceCount > 0 ? totalConfidence / confidenceCount : 0,
    },
  };
}
