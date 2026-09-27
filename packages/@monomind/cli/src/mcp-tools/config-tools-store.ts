/**
 * Config MCP Tools — persistent store and key-safety helpers.
 * Extracted from config-tools.ts.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getProjectCwd } from './types.js';

// Storage paths
const STORAGE_DIR = '.monomind';
const CONFIG_FILE = 'config.json';

export interface ConfigStore {
  values: Record<string, unknown>;
  scopes: Record<string, Record<string, unknown>>;
  version: string;
  updatedAt: string;
}

export const DEFAULT_CONFIG: Record<string, unknown> = {
  'swarm.topology': 'mesh',
  'swarm.maxAgents': 10,
  'swarm.autoScale': true,
  'memory.persistInterval': 60000,
  'memory.maxEntries': 10000,
  'session.autoSave': true,
  'session.saveInterval': 300000,
  'logging.level': 'info',
  'logging.format': 'json',
  'security.sandboxEnabled': true,
  'security.pathValidation': true,
};

function getConfigDir(): string {
  return join(getProjectCwd(), STORAGE_DIR);
}

export function getConfigPath(): string {
  return join(getConfigDir(), CONFIG_FILE);
}

function ensureConfigDir(): void {
  const dir = getConfigDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

const MAX_CONFIG_STORE_BYTES = 5 * 1024 * 1024; // 5 MB

export function loadConfigStore(): ConfigStore {
  try {
    const path = getConfigPath();
    if (existsSync(path)) {
      if (statSync(path).size > MAX_CONFIG_STORE_BYTES) {
        return {
          values: { ...DEFAULT_CONFIG },
          scopes: {},
          version: '3.0.0',
          updatedAt: new Date().toISOString(),
        };
      }
      const data = readFileSync(path, 'utf-8');
      const parsed = JSON.parse(data) as ConfigStore;
      return {
        values: filterDangerousKeys(parsed.values ?? {}),
        scopes: filterDangerousKeys(parsed.scopes ?? {}) as Record<string, Record<string, unknown>>,
        version: typeof parsed.version === 'string' ? parsed.version : '3.0.0',
        updatedAt:
          typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
      };
    }
  } catch (e) {
    if (process.env.DEBUG || process.env.MONOMIND_DEBUG)
      console.error('[config-tools] failed to load config store, using defaults:', e);
  }
  return {
    values: { ...DEFAULT_CONFIG },
    scopes: {},
    version: '3.0.0',
    updatedAt: new Date().toISOString(),
  };
}

export function saveConfigStore(store: ConfigStore): void {
  ensureConfigDir();
  store.updatedAt = new Date().toISOString();
  const dest = getConfigPath();
  const tmpPath = `${dest}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(store, null, 2), 'utf-8');
  renameSync(tmpPath, dest);
}

export function _getNestedValue(obj: Record<string, unknown>, key: string): unknown {
  const parts = key.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current && typeof current === 'object' && part in (current as Record<string, unknown>)) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return current;
}

export const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function filterDangerousKeys(
  obj: Record<string, unknown>,
  depth = 0,
): Record<string, unknown> {
  const filtered: Record<string, unknown> = {};
  if (depth > 20) return filtered;
  for (const [key, value] of Object.entries(obj)) {
    if (!DANGEROUS_KEYS.has(key)) {
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        filtered[key] = filterDangerousKeys(value as Record<string, unknown>, depth + 1);
      } else {
        filtered[key] = value;
      }
    }
  }
  return filtered;
}

export function _setNestedValue(obj: Record<string, unknown>, key: string, value: unknown): void {
  const MAX_NESTING_DEPTH = 10;
  const parts = key.split('.');
  if (parts.length > MAX_NESTING_DEPTH) {
    throw new Error(`Key exceeds maximum nesting depth of ${MAX_NESTING_DEPTH}`);
  }
  for (const part of parts) {
    if (DANGEROUS_KEYS.has(part)) {
      throw new Error(`Dangerous key segment rejected: ${part}`);
    }
  }
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!(part in current) || typeof current[part] !== 'object') {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}
