/**
 * Search entries in the memory database.
 *
 * Split out of memory-read.ts (file-size sweep). Pure move: no behaviour change.
 *
 * @module v1/cli/memory-search-entries
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { cosineSimilarity as cosineSim } from '../utils/cosine-similarity.js';
import { generateEmbedding } from './embedding-operations.js';
import { safeParseEmbedding } from './memory-bridge.js';
import { ensureSchemaColumns } from './memory-migrations.js';
import { getBridge, MAX_DB_FILE_BYTES } from './memory-read-bridge.js';

/**
 * Search entries using sql.js with vector similarity
 * Uses HNSW index for search when available
 */
export async function searchEntries(options: {
  query: string;
  namespace?: string;
  limit?: number;
  threshold?: number;
  dbPath?: string;
}): Promise<{
  success: boolean;
  results: {
    id: string;
    key: string;
    content: string;
    score: number;
    namespace: string;
  }[];
  searchTime: number;
  /** What actually ran — propagated from the bridge so callers can report the
   *  real method instead of echoing the requested one.
   *
   *  'hash-vector'/'hash-hybrid' are the sql.js paths running on
   *  generateEmbedding()'s deterministic hash fallback: a vector search was
   *  performed, but over hashes with no semantic content, so neither may be
   *  reported as 'semantic'/'hybrid'. */
  searchMethod?:
    | 'semantic'
    | 'keyword'
    | 'keyword-fallback'
    | 'hybrid'
    | 'hash-vector'
    | 'hash-hybrid';
  fallbackReason?: string;
  error?: string;
}> {
  // ADR-053: Try SQLite-backed memory bridge first
  const bridge = await getBridge();
  if (bridge) {
    const bridgeResult = await bridge.bridgeSearchEntries(options);
    if (bridgeResult) return bridgeResult;
  }

  // Fallback: raw sql.js
  const { query, namespace, limit = 10, threshold = 0.3, dbPath: customPath } = options;
  const effectiveNamespace = namespace || 'all';

  const swarmDir = path.resolve(process.cwd(), '.swarm');
  const dbPath = customPath ? path.resolve(customPath) : path.join(swarmDir, 'memory.db');
  const startTime = Date.now();

  try {
    if (!fs.existsSync(dbPath)) {
      return { success: false, results: [], searchTime: 0, error: 'Database not found' };
    }

    await ensureSchemaColumns(dbPath);

    const searchStat = fs.statSync(dbPath);
    if (searchStat.size > MAX_DB_FILE_BYTES) {
      return {
        success: false,
        results: [],
        searchTime: 0,
        error: `Database file too large: ${searchStat.size} bytes`,
      };
    }

    const queryEmb = await generateEmbedding(query);
    const queryEmbedding = queryEmb.embedding;

    // generateEmbedding() never fails — when no ONNX model can be loaded it
    // silently returns generateHashEmbedding() output tagged 'hash-fallback'.
    // Cosine over those hashes is a deterministic lexical trick with no
    // semantic content, so the methods below must not claim otherwise.
    const realVectors = queryEmb.model !== 'hash-fallback';

    // Brute-force SQLite search. This is the legacy raw sql.js path, only
    // reached when the SQLite bridge itself is unavailable (import failure) —
    // the real ANN fast path lives inside the bridge's backend
    // (SqlBackend.search(), size-gated by MONOMIND_HNSW_THRESHOLD) and is
    // already exercised via bridge.bridgeSearchEntries() above.
    const initSqlJs = (await import('sql.js')).default;
    const SQL = await initSqlJs();

    const searchFbStat = fs.statSync(dbPath);
    if (searchFbStat.size > MAX_DB_FILE_BYTES) {
      return {
        success: false,
        results: [],
        searchTime: Date.now() - startTime,
        error: `Database file too large: ${searchFbStat.size} bytes`,
      };
    }

    const fileBuffer = fs.readFileSync(dbPath);
    const db = new SQL.Database(fileBuffer);

    const searchStmt = db.prepare(
      effectiveNamespace !== 'all'
        ? `SELECT id, key, namespace, content, embedding FROM memory_entries WHERE status = 'active' AND namespace = ? LIMIT 1000`
        : `SELECT id, key, namespace, content, embedding FROM memory_entries WHERE status = 'active' LIMIT 1000`,
    );
    if (effectiveNamespace !== 'all') {
      searchStmt.bind([effectiveNamespace]);
    }
    const searchRows: unknown[][] = [];
    while (searchStmt.step()) {
      searchRows.push(searchStmt.get());
    }
    searchStmt.free();
    const entries = searchRows.length > 0 ? [{ values: searchRows }] : [];

    const results: {
      id: string;
      key: string;
      content: string;
      score: number;
      namespace: string;
    }[] = [];

    if (entries[0]?.values) {
      for (const row of entries[0].values) {
        const [id, key, ns, content, embeddingJson] = row as [
          string,
          string,
          string,
          string,
          string | null,
        ];

        let score = 0;

        if (embeddingJson) {
          const embedding = safeParseEmbedding(embeddingJson);
          if (embedding && embedding.length === queryEmbedding.length) {
            score = cosineSim(queryEmbedding, embedding);
          }
        }

        if (score < threshold) {
          const lowerContent = (content || '').toLowerCase();
          const lowerQuery = query.toLowerCase();
          const words = lowerQuery.split(/\s+/).filter((w) => w.length > 0);
          if (words.length > 0) {
            const matchCount = words.filter((w) => lowerContent.includes(w)).length;
            const keywordScore = (matchCount / words.length) * 0.5;
            score = Math.max(score, keywordScore);
          }
        }

        if (score >= threshold) {
          results.push({
            id: id.substring(0, 12),
            key: key || id.substring(0, 15),
            content: (content || '').substring(0, 60) + ((content || '').length > 60 ? '...' : ''),
            score,
            namespace: ns || 'default',
          });
        }
      }
    }

    db.close();

    results.sort((a, b) => b.score - a.score);

    return {
      success: true,
      results: results.slice(0, limit),
      searchTime: Date.now() - startTime,
      // Per-row: cosine when the entry had a vector, keyword overlap otherwise.
      // With hash-fallback vectors the cosine half is not semantic either.
      searchMethod: realVectors ? 'hybrid' : 'hash-hybrid',
      ...(realVectors ? {} : { fallbackReason: 'no-embedding-model' }),
    };
  } catch (error) {
    return {
      success: false,
      results: [],
      searchTime: Date.now() - startTime,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
