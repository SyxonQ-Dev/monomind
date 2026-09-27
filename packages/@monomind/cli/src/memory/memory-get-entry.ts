/**
 * Get a specific entry from the memory database.
 *
 * Split out of memory-read.ts (file-size sweep). Pure move: no behaviour change.
 *
 * @module v1/cli/memory-get-entry
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ensureSchemaColumns } from './memory-migrations.js';
import { getBridge, MAX_DB_FILE_BYTES } from './memory-read-bridge.js';

/**
 * Get a specific entry from the memory database
 */
export async function getEntry(options: {
  key: string;
  namespace?: string;
  dbPath?: string;
  /** Agent ID for collaborative memory promotion tracking */
  agentId?: string;
}): Promise<{
  success: boolean;
  found: boolean;
  entry?: {
    id: string;
    key: string;
    namespace: string;
    content: string;
    accessCount: number;
    createdAt: string;
    updatedAt: string;
    hasEmbedding: boolean;
    tags: string[];
  };
  error?: string;
}> {
  // ADR-053: Try SQLite-backed memory bridge first
  const bridge = await getBridge();
  if (bridge) {
    const bridgeResult = await bridge.bridgeGetEntry(options);
    if (bridgeResult) return bridgeResult;
  }

  // Fallback: raw sql.js
  const { key, namespace = 'default', dbPath: customPath } = options;

  const swarmDir = path.join(process.cwd(), '.swarm');
  const dbPath = customPath || path.join(swarmDir, 'memory.db');

  try {
    if (!fs.existsSync(dbPath)) {
      return { success: false, found: false, error: 'Database not found' };
    }

    await ensureSchemaColumns(dbPath);

    const initSqlJs = (await import('sql.js')).default;
    const SQL = await initSqlJs();

    const getStat = fs.statSync(dbPath);
    if (getStat.size > MAX_DB_FILE_BYTES) {
      return {
        success: false,
        found: false,
        error: `Database file too large: ${getStat.size} bytes`,
      };
    }

    const fileBuffer = fs.readFileSync(dbPath);
    const db = new SQL.Database(fileBuffer);

    const getStmt = db.prepare(`
      SELECT id, key, namespace, content, embedding, access_count, created_at, updated_at, tags
      FROM memory_entries
      WHERE status = 'active'
        AND key = ?
        AND namespace = ?
      LIMIT 1
    `);
    getStmt.bind([key, namespace]);
    const getRows: unknown[][] = [];
    while (getStmt.step()) {
      getRows.push(getStmt.get());
    }
    getStmt.free();
    const result = getRows.length > 0 ? [{ values: getRows }] : [];

    if (!result[0]?.values?.[0]) {
      db.close();
      return { success: true, found: false };
    }

    const [id, entryKey, ns, content, embedding, accessCount, createdAt, updatedAt, tagsJson] =
      result[0].values[0] as [
        string,
        string,
        string,
        string,
        string | null,
        number,
        string,
        string,
        string | null,
      ];

    db.close();

    let tags: string[] = [];
    if (tagsJson) {
      try {
        tags = JSON.parse(tagsJson);
      } catch {
        // Invalid JSON
      }
    }

    return {
      success: true,
      found: true,
      entry: {
        id: String(id),
        key: entryKey || String(id),
        namespace: ns || 'default',
        content: content || '',
        accessCount: (accessCount || 0) + 1,
        createdAt: createdAt || new Date().toISOString(),
        updatedAt: updatedAt || new Date().toISOString(),
        hasEmbedding: !!embedding && embedding.length > 10,
        tags,
      },
    };
  } catch (error) {
    return {
      success: false,
      found: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
