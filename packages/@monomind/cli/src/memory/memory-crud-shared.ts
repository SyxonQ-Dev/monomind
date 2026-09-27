/**
 * Memory Write Operations — shared helpers
 * Split out of memory-crud.ts (file-size sweep). Pure move.
 *
 * @module v1/cli/memory-crud
 */

/** Maximum SQLite database file size accepted before read (256 MB). */
export const MAX_DB_FILE_BYTES = 256 * 1024 * 1024;

// ADR-053: Lazy import of memory bridge
let _bridge: typeof import('./memory-bridge.js') | null | undefined;
export async function getBridge(): Promise<typeof import('./memory-bridge.js') | null> {
  if (_bridge === null) return null;
  if (_bridge) return _bridge;
  try {
    _bridge = await import('./memory-bridge.js');
    return _bridge;
  } catch {
    _bridge = null;
    return null;
  }
}
