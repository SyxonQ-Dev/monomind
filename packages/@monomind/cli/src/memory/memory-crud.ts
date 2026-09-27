/**
 * Memory Write Operations
 * Verify initialization, store, and delete entries.
 * Read operations (search, list, get) live in memory-read.ts (ARCH-4b split).
 *
 * File-size sweep: verifyMemoryInit and storeEntry split into
 * memory-crud-verify.ts and memory-crud-store.ts, with shared helpers in
 * memory-crud-shared.ts. This file remains the entry point and re-exports
 * everything that used to live here so every existing import keeps working.
 *
 * @module v1/cli/memory-crud
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { withDbLock } from '../utils/db-mutex.js';
import { secureDbFilePermissions } from './file-permissions.js';
import { getBridge, MAX_DB_FILE_BYTES } from './memory-crud-shared.js';
import { ensureSchemaColumns } from './memory-migrations.js';

export { storeEntry } from './memory-crud-store.js';
export { verifyMemoryInit } from './memory-crud-verify.js';
// Re-export read operations so existing callers keep working without changes.
export { getEntry, listEntries, searchEntries } from './memory-read.js';

/**
 * Delete a memory entry by key and namespace
 * Issue #980: Properly supports namespaced entries
 */
export async function deleteEntry(options: {
  key: string;
  namespace?: string;
  dbPath?: string;
}): Promise<{
  success: boolean;
  deleted: boolean;
  key: string;
  namespace: string;
  remainingEntries: number;
  error?: string;
}> {
  // ADR-053: Try SQLite-backed memory bridge first
  const bridge = await getBridge();
  if (bridge) {
    const bridgeResult = await bridge.bridgeDeleteEntry(options);
    if (bridgeResult) {
      // Count what is actually left rather than asserting zero. This returned a
      // hardcoded 0 on the default bridge path (the sql.js fallback below always
      // computed it), so every successful delete printed "Remaining entries: 0"
      // — telling the user their namespace was empty when it was not, and
      // handing any script reading data.remainingEntries a false "done".
      const ns = options.namespace ?? 'default';
      let remainingEntries = 0;
      try {
        const listed = await bridge.bridgeListEntries({
          namespace: ns,
          limit: 100_000,
          dbPath: options.dbPath,
        });
        remainingEntries = listed?.entries?.length ?? 0;
      } catch {
        // Counting is best-effort; a failed count must not fail the delete that
        // already succeeded. 0 here means "unknown", same as before this fix.
      }
      return { ...bridgeResult, key: options.key, namespace: ns, remainingEntries };
    }
  }

  // Fallback: raw sql.js
  const { key, namespace = 'default', dbPath: customPath } = options;

  const swarmDir = path.join(process.cwd(), '.swarm');
  const dbPath = customPath || path.join(swarmDir, 'memory.db');

  try {
    if (!fs.existsSync(dbPath)) {
      return {
        success: false,
        deleted: false,
        key,
        namespace,
        remainingEntries: 0,
        error: 'Database not found',
      };
    }

    await ensureSchemaColumns(dbPath);

    return await withDbLock(dbPath, async () => {
      const initSqlJs = (await import('sql.js')).default;
      const SQL = await initSqlJs();

      const deleteStat = fs.statSync(dbPath);
      if (deleteStat.size > MAX_DB_FILE_BYTES) {
        return {
          success: false,
          deleted: false,
          key,
          namespace,
          remainingEntries: 0,
          error: `Database file too large: ${deleteStat.size} bytes`,
        };
      }

      const fileBuffer = fs.readFileSync(dbPath);
      const db = new SQL.Database(fileBuffer);

      const checkStmt = db.prepare(`
      SELECT id FROM memory_entries
      WHERE status = 'active'
        AND key = ?
        AND namespace = ?
      LIMIT 1
    `);
      checkStmt.bind([key, namespace]);
      const checkRows: unknown[][] = [];
      while (checkStmt.step()) {
        checkRows.push(checkStmt.get());
      }
      checkStmt.free();
      const checkResult = checkRows.length > 0 ? [{ values: checkRows }] : [];

      if (!checkResult[0]?.values?.[0]) {
        const countResult = db.exec(`SELECT COUNT(*) FROM memory_entries WHERE status = 'active'`);
        const remainingEntries = (countResult[0]?.values?.[0]?.[0] as number) || 0;
        db.close();
        return {
          success: true,
          deleted: false,
          key,
          namespace,
          remainingEntries,
          error: `Key '${key}' not found in namespace '${namespace}'`,
        };
      }

      db.run(
        `
      UPDATE memory_entries
      SET status = 'deleted',
          embedding = NULL,
          updated_at = strftime('%s', 'now') * 1000
      WHERE key = ?
        AND namespace = ?
        AND status = 'active'
    `,
        [key, namespace],
      );

      const countResult = db.exec(`SELECT COUNT(*) FROM memory_entries WHERE status = 'active'`);
      const remainingEntries = (countResult[0]?.values?.[0]?.[0] as number) || 0;

      // Save updated database atomically
      const data = db.export();
      const dbTmpDelete = `${dbPath}.tmp`;
      fs.writeFileSync(dbTmpDelete, Buffer.from(data));
      fs.renameSync(dbTmpDelete, dbPath);
      secureDbFilePermissions(dbPath);

      db.close();

      return {
        success: true,
        deleted: true,
        key,
        namespace,
        remainingEntries,
      };
    });
  } catch (error) {
    return {
      success: false,
      deleted: false,
      key,
      namespace,
      remainingEntries: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
