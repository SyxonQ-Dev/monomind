/**
 * Embeddings MCP Tools — configuration store and input validation.
 * Extracted from embeddings-tools.ts.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Configuration paths
export const CONFIG_DIR = '.monomind';
const EMBEDDINGS_CONFIG = 'embeddings.json';
export const MODELS_DIR = 'models';

// Input validation caps — embeddings handlers operate on caller-supplied text and
// vectors. Without these caps an attacker can pass a 100M-entry array and OOM the
// process, or a 50MB string and saturate the hash-fallback embedding loop.
const MAX_TEXT_LENGTH = 64 * 1024;
const MAX_VECTOR_DIM = 8192;

export function validateText(t: unknown, field: string): string {
  if (typeof t !== 'string') throw new Error(`${field}: must be a string`);
  if (t.length > MAX_TEXT_LENGTH)
    throw new Error(`${field}: text too long (max ${MAX_TEXT_LENGTH})`);
  return t;
}

export function validateVector(v: unknown, field: string): number[] {
  if (!Array.isArray(v)) throw new Error(`${field}: must be a number[]`);
  if (v.length === 0) throw new Error(`${field}: empty vector`);
  if (v.length > MAX_VECTOR_DIM)
    throw new Error(`${field}: vector too large (max ${MAX_VECTOR_DIM})`);
  for (let i = 0; i < v.length; i++) {
    if (typeof v[i] !== 'number' || !Number.isFinite(v[i])) {
      throw new Error(`${field}: contains non-finite value at index ${i}`);
    }
  }
  return v as number[];
}

export interface EmbeddingsConfig {
  model: string;
  modelPath: string;
  dimension: number;
  cacheSize: number;
  hyperbolic: {
    enabled: boolean;
    curvature: number;
    epsilon: number;
    maxNorm: number;
  };
  neural: {
    enabled: boolean;
    driftThreshold: number;
    decayRate: number;
    monovector?: {
      enabled: boolean;
      sona: boolean;
      flashAttention: boolean;
      ewcPlusPlus: boolean;
    };
    features?: {
      semanticDrift: boolean;
      memoryPhysics: boolean;
      stateMachine: boolean;
      swarmCoordination: boolean;
      coherenceMonitor: boolean;
    };
  };
  initialized: string;
}

export function getConfigPath(): string {
  return resolve(join(CONFIG_DIR, EMBEDDINGS_CONFIG));
}

export function ensureConfigDir(): void {
  const dir = resolve(CONFIG_DIR);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

const MAX_EMBEDDINGS_CONFIG_BYTES = 10 * 1024 * 1024; // 10 MB

export function loadConfig(): EmbeddingsConfig | null {
  try {
    const path = getConfigPath();
    if (existsSync(path) && statSync(path).size <= MAX_EMBEDDINGS_CONFIG_BYTES) {
      return JSON.parse(readFileSync(path, 'utf-8'));
    }
  } catch (e) {
    // Return null on error
    if (process.env.DEBUG || process.env.MONOMIND_DEBUG)
      console.error('[embeddings-tools] config read/parse failed:', e);
  }
  return null;
}

export function saveConfig(config: EmbeddingsConfig): void {
  ensureConfigDir();
  const dest = getConfigPath();
  const tmp = `${dest}.tmp`;
  writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf-8');
  renameSync(tmp, dest);
}
