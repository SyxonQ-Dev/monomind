/**
 * Security MCP Tools — MonoFence Integration (shared core)
 *
 * Lazy-loading, input bounds, and the getMonoFence()/capSecurityInput() helpers
 * shared by the monofence_* tool modules.
 *
 * github.com/monoes/monomind
 */

import { createRequire } from 'node:module';
import { tryImportOrInstall } from './auto-install.js';

// Create require for resolving module paths
const _require = createRequire(import.meta.url);

// monolean: local shape instead of static import of optional dep monofence-ai
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type MonoFenceInstance = Record<string, (...args: any[]) => any>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MonoFenceModule = Record<string, (...args: any[]) => any>;

// Lazy-loaded MonoFence module and instance
let monofenceModule: MonoFenceModule | null = null;
let monofenceInstance: MonoFenceInstance | null = null;

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
 * Load the monofence-ai module, installing it into monomind's deps directory
 * on first use (never into the user's project, #519). Callers must use the
 * returned module rather than `import('monofence-ai')`, which does not see
 * that directory.
 */
export async function loadMonoFenceModule(): Promise<MonoFenceModule> {
  if (monofenceModule) return monofenceModule;
  const mod = await tryImportOrInstall<MonoFenceModule>('monofence-ai');
  if (!mod) {
    throw new Error('MonoFence package not available. Install with: npm install monofence-ai');
  }
  monofenceModule = mod;
  return mod;
}

/**
 * Get or create MonoFence instance (throws if unavailable)
 */
export async function getMonoFence(): Promise<MonoFenceInstance> {
  if (monofenceInstance) {
    return monofenceInstance;
  }

  const monofence = await loadMonoFenceModule();
  const instance = monofence.createMonoDefence({ enableLearning: true });
  if (!instance) {
    throw new Error('MonoFence failed to load: createMonoDefence returned null');
  }
  monofenceInstance = instance;
  return instance;
}
