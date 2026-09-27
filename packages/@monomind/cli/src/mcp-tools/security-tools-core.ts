/**
 * Security MCP Tools — MonoFence Integration (shared core)
 *
 * Lazy-loading, input bounds, and the getMonoFence()/capSecurityInput() helpers
 * shared by the monofence_* tool modules.
 *
 * github.com/monoes/monomind
 */

import { createRequire } from 'node:module';
import { autoInstallPackage } from './auto-install.js';

// Create require for resolving module paths
const _require = createRequire(import.meta.url);

// monolean: local shape instead of static import of optional dep monofence-ai
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type MonoFenceInstance = Record<string, (...args: any[]) => any>;

// Lazy-loaded MonoFence instance
let monofenceInstance: MonoFenceInstance | null = null;

// Track if we've attempted install this session
let installAttempted = false;

// ── Security input bounds ─────────────────────────────────────────────────────
// MonoFence runs multiple regex patterns over the entire input string (O(n × P)
// complexity where P is the pattern count).  Uncapped input enables ReDoS-style
// denial-of-service.  64 KB is more than enough for any real threat-scan
// payload while preventing CPU exhaustion from megabyte-scale inputs.
export const MAX_SECURITY_INPUT_LEN = 64 * 1024; // 64 KB
export const MAX_SECURITY_K = 100;
export const MAX_SECURITY_VERDICT_LEN = 512;
export const MAX_SECURITY_THREAT_TYPE_LEN = 256;
export const MAX_SECURITY_MITIGATION_STRATEGY_LEN = 512;

export function capSecurityInput(raw: unknown, fieldName = 'input'): string {
  if (typeof raw !== 'string') throw new Error(`${fieldName} must be a string`);
  return raw.length > MAX_SECURITY_INPUT_LEN ? raw.slice(0, MAX_SECURITY_INPUT_LEN) : raw;
}

/**
 * Get or create MonoFence instance (throws if unavailable)
 */
export async function getMonoFence(): Promise<MonoFenceInstance> {
  if (monofenceInstance) {
    return monofenceInstance;
  }

  const packageName = 'monofence-ai';

  // First attempt - try to load via dynamic import (ESM)
  try {
    const monofence = await import(packageName);
    const instance = monofence.createMonoDefence({ enableLearning: true });
    if (!instance) {
      throw new Error('createMonoDefence returned null');
    }
    monofenceInstance = instance;
    return instance;
  } catch (e) {
    // Package not found or failed to load
    const error = e as Error;
    if (
      !error.message?.includes('Cannot find package') &&
      !error.message?.includes('ERR_MODULE_NOT_FOUND')
    ) {
      // Different error - might be a real issue
      throw new Error(`MonoFence failed to load: ${error.message}`);
    }
  }

  // Don't attempt install more than once per session
  if (installAttempted) {
    throw new Error('MonoFence package not available. Install with: npm install monofence-ai');
  }
  installAttempted = true;

  // Second attempt - auto-install and retry
  console.error(`[monomind] ${packageName} not found, attempting auto-install...`);
  const installed = await autoInstallPackage(packageName);

  if (!installed) {
    throw new Error('MonoFence package not available. Install with: npm install monofence-ai');
  }

  // The in-process ESM module cache cannot be invalidated after install; require a server restart.
  throw new Error(
    `MonoFence installed successfully. Restart the MCP server to load it: npx monomind mcp start`,
  );
}
