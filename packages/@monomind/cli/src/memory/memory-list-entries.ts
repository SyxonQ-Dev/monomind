/**
 * List all entries from the memory database.
 *
 * Split out of memory-read.ts (file-size sweep). Pure move: no behaviour change.
 *
 * @module v1/cli/memory-list-entries
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ensureSchemaColumns } from './memory-migrations.js';
import { getBridge, MAX_DB_FILE_BYTES } from './memory-read-bridge.js';

/**
 * List all entries from the memory database
 */
export async function listEntries(options: {
  namespace?: string;
  limit?: number;
  offset?: number;
  dbPath?: string;
}): Promise<{
  success: boolean;
  entries: {
    id: string;
    key: string;
    namespace: string;
    size: number;
    accessCount: number;
    createdAt: string;
    updatedAt: string;
    hasEmbedding: boolean;
  }[];
  total: number;
  error?: string;
}> {
  // ADR-053: Try SQLite-backed memory bridge first
  const bridge = await getBridge();
  if (bridge) {
    const bridgeResult = await bridge.bridgeListEntries(options);
    if (bridgeResult)
      return {
        success: bridgeResult.success,
        total: bridgeResult.total,
        error: bridgeResult.error,
        entries: bridgeResult.entries.map(
          (e: {
            id: string;
            key: string;
            namespace: string;
            content?: string;
            accessCount: number;
            createdAt: string;
            updatedAt: string;
            hasEmbedding: boolean;
          }) => ({
            id: e.id,
            key: e.key,
            namespace: e.namespace,
            size: typeof e.content === 'string' ? e.content.length : 0,
            accessCount: e.accessCount,
            createdAt: e.createdAt,
            updatedAt: e.updatedAt,
            hasEmbedding: e.hasEmbedding,
          }),
        ),
      };
  }

  // Fallback: raw sql.js
  const { namespace, limit = 20, offset = 0, dbPath: customPath } = options;

  const swarmDir = path.join(process.cwd(), '.swarm');
  const dbPath = customPath || path.join(swarmDir, 'memory.db');

  try {
    if (!fs.existsSync(dbPath)) {
      return { success: false, entries: [], total: 0, error: 'Database not found' };
    }

    await ensureSchemaColumns(dbPath);

    const initSqlJs = (await import('sql.js')).default;
    const SQL = await initSqlJs();

    const listStat = fs.statSync(dbPath);
    if (listStat.size > MAX_DB_FILE_BYTES) {
      return {
        success: false,
        entries: [],
        total: 0,
        error: `Database file too large: ${listStat.size} bytes`,
      };
    }

    const fileBuffer = fs.readFileSync(dbPath);
    const db = new SQL.Database(fileBuffer);

    const countStmt = namespace
      ? db.prepare(
          `SELECT COUNT(*) as cnt FROM memory_entries WHERE status = 'active' AND namespace = ?`,
        )
      : db.prepare(`SELECT COUNT(*) as cnt FROM memory_entries WHERE status = 'active'`);
    if (namespace) {
      countStmt.bind([namespace]);
    }
    const countRows: unknown[][] = [];
    while (countStmt.step()) {
      countRows.push(countStmt.get());
    }
    countStmt.free();
    const countResult = countRows.length > 0 ? [{ values: countRows }] : [];
    const total = (countResult[0]?.values?.[0]?.[0] as number) || 0;

    const MAX_LIST_LIMIT = 10_000;
    const rawLimit = parseInt(String(limit), 10);
    const safeLimit =
      Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, MAX_LIST_LIMIT) : 100;
    const rawOffset = parseInt(String(offset), 10);
    const safeOffset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
    const listStmt = namespace
      ? db.prepare(
          `SELECT id, key, namespace, content, embedding, access_count, created_at, updated_at FROM memory_entries WHERE status = 'active' AND namespace = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
        )
      : db.prepare(
          `SELECT id, key, namespace, content, embedding, access_count, created_at, updated_at FROM memory_entries WHERE status = 'active' ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
        );
    if (namespace) {
      listStmt.bind([namespace, safeLimit, safeOffset]);
    } else {
      listStmt.bind([safeLimit, safeOffset]);
    }
    const listRows: unknown[][] = [];
    while (listStmt.step()) {
      listRows.push(listStmt.get());
    }
    listStmt.free();
    const result = listRows.length > 0 ? [{ values: listRows }] : [];
    const entries: {
      id: string;
      key: string;
      namespace: string;
      size: number;
      accessCount: number;
      createdAt: string;
      updatedAt: string;
      hasEmbedding: boolean;
    }[] = [];

    if (result[0]?.values) {
      for (const row of result[0].values) {
        const [id, key, ns, content, embedding, accessCount, createdAt, updatedAt] = row as [
          string,
          string,
          string,
          string,
          string | null,
          number,
          string,
          string,
        ];
        entries.push({
          id: String(id).substring(0, 20),
          key: key || String(id).substring(0, 15),
          namespace: ns || 'default',
          size: (content || '').length,
          accessCount: accessCount || 0,
          createdAt: createdAt || new Date().toISOString(),
          updatedAt: updatedAt || new Date().toISOString(),
          hasEmbedding: !!embedding && embedding.length > 10,
        });
      }
    }

    db.close();

    return { success: true, entries, total };
  } catch (error) {
    return {
      success: false,
      entries: [],
      total: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
