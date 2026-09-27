/**
 * Memory Write Operations — storeEntry
 * Split out of memory-crud.ts (file-size sweep). Pure move.
 *
 * @module v1/cli/memory-crud
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { withDbLock } from '../utils/db-mutex.js';
import { generateEmbedding } from './embedding-operations.js';
import { secureDbFilePermissions } from './file-permissions.js';
import { getBridge, MAX_DB_FILE_BYTES } from './memory-crud-shared.js';
import { ensureSchemaColumns } from './memory-migrations.js';

/**
 * Store an entry directly using sql.js
 * This bypasses MCP and writes directly to the database
 */
export async function storeEntry(options: {
  key: string;
  value: string;
  namespace?: string;
  generateEmbeddingFlag?: boolean;
  tags?: string[];
  ttl?: number;
  dbPath?: string;
  upsert?: boolean;
}): Promise<{
  success: boolean;
  id: string;
  embedding?: { dimensions: number; model: string };
  error?: string;
}> {
  // ADR-053: Try SQLite-backed memory bridge first
  const bridge = await getBridge();
  if (bridge) {
    const bridgeResult = await bridge.bridgeStoreEntry(options);
    if (bridgeResult) return bridgeResult;
  }

  // Fallback: raw sql.js
  const {
    key,
    value,
    namespace = 'default',
    generateEmbeddingFlag = true,
    tags = [],
    ttl,
    dbPath: customPath,
    upsert = false,
  } = options;

  const swarmDir = path.resolve(process.cwd(), '.swarm');
  const dbPath = customPath ? path.resolve(customPath) : path.join(swarmDir, 'memory.db');

  try {
    if (!fs.existsSync(dbPath)) {
      return {
        success: false,
        id: '',
        error: 'Database not initialized. Run: monomind memory init',
      };
    }

    await ensureSchemaColumns(dbPath);

    return await withDbLock(dbPath, async () => {
      const initSqlJs = (await import('sql.js')).default;
      const SQL = await initSqlJs();

      const storeStat = fs.statSync(dbPath);
      if (storeStat.size > MAX_DB_FILE_BYTES) {
        return {
          success: false,
          id: '',
          error: `Database file too large: ${storeStat.size} bytes`,
        };
      }

      const fileBuffer = fs.readFileSync(dbPath);
      const db = new SQL.Database(fileBuffer);

      let id = `entry_${Date.now()}_${Math.random().toString(36).substring(7)}`;
      let existingCreatedAt: number | null = null;
      let matchedExisting = false;
      if (upsert) {
        const existingIdResult = db.exec(
          "SELECT id, created_at FROM memory_entries WHERE key = ? AND namespace = ? AND status = 'active' LIMIT 1",
          [key, namespace],
        );
        const existingRow = existingIdResult[0]?.values?.[0];
        const existingId = existingRow?.[0];
        if (typeof existingId === 'string') {
          id = existingId;
          matchedExisting = true;
          const createdAt = existingRow?.[1];
          if (typeof createdAt === 'number') existingCreatedAt = createdAt;
        }
      }
      const now = Date.now();
      const createdAt = existingCreatedAt ?? now;

      let embeddingJson: string | null = null;
      let embeddingDimensions: number | null = null;
      let embeddingModel: string | null = null;

      if (generateEmbeddingFlag && value.length > 0) {
        const embResult = await generateEmbedding(value);
        embeddingJson = JSON.stringify(embResult.embedding);
        embeddingDimensions = embResult.dimensions;
        embeddingModel = embResult.model;
      }

      const isUpdate = upsert && matchedExisting;
      if (isUpdate) {
        // #88: upsert against an existing row must UPDATE in place. The old
        // INSERT OR REPLACE omitted access_count, confidence, importance_score,
        // last_accessed_at, owner_id, agent_id, session_id and hardcoded
        // metadata '{}' — every update silently wiped all learned stats.
        db.run(
          `UPDATE memory_entries SET
           content = ?,
           embedding = ?,
           embedding_dimensions = ?,
           embedding_model = ?,
           tags = ?,
           updated_at = ?,
           expires_at = ?
         WHERE id = ?`,
          [
            value,
            embeddingJson,
            embeddingDimensions,
            embeddingModel,
            tags.length > 0 ? JSON.stringify(tags) : null,
            now,
            ttl ? now + ttl * 1000 : null,
            id,
          ],
        );
      } else {
        const insertSql = `INSERT INTO memory_entries (
          id, key, namespace, content, type,
          embedding, embedding_dimensions, embedding_model,
          tags, metadata, created_at, updated_at, expires_at, status
        ) VALUES (?, ?, ?, ?, 'semantic', ?, ?, ?, ?, ?, ?, ?, ?, 'active')`;

        db.run(insertSql, [
          id,
          key,
          namespace,
          value,
          embeddingJson,
          embeddingDimensions,
          embeddingModel,
          tags.length > 0 ? JSON.stringify(tags) : null,
          '{}',
          createdAt,
          now,
          ttl ? now + ttl * 1000 : null,
        ]);
      }

      // Save atomically
      const data = db.export();
      const dbTmpStore = `${dbPath}.tmp`;
      fs.writeFileSync(dbTmpStore, Buffer.from(data));
      fs.renameSync(dbTmpStore, dbPath);
      secureDbFilePermissions(dbPath);
      db.close();

      return {
        success: true,
        id,
        embedding: embeddingJson
          ? { dimensions: embeddingDimensions!, model: embeddingModel! }
          : undefined,
      };
    });
  } catch (error) {
    return {
      success: false,
      id: '',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
