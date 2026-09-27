/**
 * Shared constants and the lazily cached memory-bridge loader for the
 * memory_* MCP tool modules.
 *
 * Split out of memory-tools.ts, which re-exports these tools and registers them
 * in `memoryTools` in their original order.
 */

// ===== MCP-specific constants =====

export const MAX_BATCH_SIZE = 500; // Max entries per batch operation
export const MAX_TOP_K = 100; // Max results per query

// Lazy-cached bridge module
let bridgeModule: typeof import('../memory/memory-bridge.js') | null = null;
export async function getBridge() {
  if (!bridgeModule) {
    bridgeModule = await import('../memory/memory-bridge.js');
  }
  return bridgeModule;
}
