/**
 * Legacy source loaders for MemoryMigrator (SQLite/Markdown/JSON/swarm/
 * distributed-memory sources).
 * File-size sweep: split out of migration.ts. Mixed into
 * MemoryMigrator.prototype at the bottom of migration.ts.
 *
 * @module v1/memory/migration-loaders
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { MemoryMigrator } from './migration.js';

/**
 * Legacy entry format (common structure)
 */
export interface LegacyEntry {
  id?: string;
  key: string;
  value: unknown;
  namespace?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  timestamp?: number;
  createdAt?: string | number;
  updatedAt?: string | number;
  created_at?: string | number;
  updated_at?: string | number;
}

export const migrationLoaderMethods = {
  async loadFromSource(this: MemoryMigrator): Promise<LegacyEntry[]> {
    switch (this.config.source) {
      case 'sqlite':
        return this.loadFromSQLite();
      case 'markdown':
        return this.loadFromMarkdown();
      case 'json':
        return this.loadFromJSON();
      case 'memory-manager':
        return this.loadFromMemoryManager();
      case 'monoswarm-memory':
        return this.loadFromSwarmMemory();
      case 'distributed-memory':
        return this.loadFromDistributedMemory();
      default:
        throw new Error(`Unknown migration source: ${this.config.source}`);
    }
  },

  async loadFromSQLite(this: MemoryMigrator): Promise<LegacyEntry[]> {
    const dbPath = this.config.sourcePath;

    // A .json-suffixed "sqlite" source is actually an exported JSON dump —
    // route it through the real JSON loader instead of opening it as a DB.
    if (dbPath.endsWith('.json')) {
      return this.loadFromJSON();
    }

    let Database: new (
      path: string,
      opts?: Record<string, unknown>,
    ) => {
      prepare: (sql: string) => { all: (...params: unknown[]) => unknown[] };
      close: () => void;
    };
    try {
      const mod = await import('better-sqlite3');
      Database = (mod as { default: typeof Database }).default;
    } catch (error) {
      throw new Error(
        `Cannot read SQLite source "${dbPath}": better-sqlite3 is not available (${(error as Error).message})`,
      );
    }

    let db: InstanceType<typeof Database> | undefined;
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true });
    } catch (error) {
      throw new Error(`Failed to open SQLite database "${dbPath}": ${(error as Error).message}`);
    }

    try {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_entries'")
        .all() as Array<{ name: string }>;
      if (tables.length === 0) {
        throw new Error(
          `SQLite source "${dbPath}" has no "memory_entries" table — not a recognized memory backend database`,
        );
      }

      const rows = db.prepare('SELECT * FROM memory_entries').all() as Array<
        Record<string, unknown>
      >;
      return rows.map(
        (row): LegacyEntry => ({
          id: row.id as string,
          key: row.key as string,
          value: row.content,
          namespace: row.namespace as string | undefined,
          tags: this.safeJsonParse(row.tags as string, []),
          metadata: this.safeJsonParse(row.metadata as string, {}),
          createdAt: row.created_at as number,
          updatedAt: row.updated_at as number,
        }),
      );
    } finally {
      db.close();
    }
  },

  safeJsonParse<T>(this: MemoryMigrator, value: string | undefined, fallback: T): T {
    if (!value) return fallback;
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  },

  async loadFromMarkdown(this: MemoryMigrator): Promise<LegacyEntry[]> {
    const entries: LegacyEntry[] = [];
    const basePath = this.config.sourcePath;

    try {
      const files = await this.walkDirectory(basePath, '.md');

      for (const filePath of files) {
        try {
          const content = await fs.readFile(filePath, 'utf-8');
          const entry = this.parseMarkdownEntry(filePath, content, basePath);
          if (entry) {
            entries.push(entry);
          }
        } catch (error) {
          this.addError(filePath, (error as Error).message, 'PARSE_ERROR', true);
        }
      }

      return entries;
    } catch (error) {
      throw new Error(`Failed to load Markdown: ${(error as Error).message}`);
    }
  },

  async loadFromJSON(this: MemoryMigrator, filePathOverride?: string): Promise<LegacyEntry[]> {
    const filePath = filePathOverride ?? this.config.sourcePath;

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const data = JSON.parse(content);

      // Handle different JSON formats
      if (Array.isArray(data)) {
        return data;
      } else if (data.entries) {
        return data.entries;
      } else if (typeof data === 'object') {
        // Assume it's a namespace -> entries map
        const entries: LegacyEntry[] = [];
        for (const [namespace, namespaceEntries] of Object.entries(data)) {
          if (Array.isArray(namespaceEntries)) {
            for (const entry of namespaceEntries) {
              entries.push({ ...entry, namespace });
            }
          }
        }
        return entries;
      }

      return [];
    } catch (error) {
      throw new Error(`Failed to load JSON: ${(error as Error).message}`);
    }
  },

  async loadFromMemoryManager(this: MemoryMigrator): Promise<LegacyEntry[]> {
    // Would integrate with existing MemoryManager instance
    // For now, try to load from common paths
    const possiblePaths = ['./memory/memory-store.json', './.swarm/memory.db', './memory.json'];

    for (const p of possiblePaths) {
      try {
        const fullPath = path.resolve(this.config.sourcePath, p);
        await fs.access(fullPath);
        // #85: read the verified fullPath, not this.config.sourcePath — the
        // latter is the search directory, so readFile() on it throws EISDIR,
        // the catch swallowed it, and the migration silently returned [].
        // `await` is required: a bare `return promise` inside try/catch does
        // not route rejections through the catch below.
        const stat = await fs.stat(fullPath);
        if (!stat.isFile()) continue;
        return await this.loadFromJSON(fullPath);
      } catch {}
    }

    return [];
  },

  async loadFromSwarmMemory(this: MemoryMigrator): Promise<LegacyEntry[]> {
    // Would integrate with SwarmMemory partitions
    const entries: LegacyEntry[] = [];
    const basePath = this.config.sourcePath;

    try {
      // Check for swarm memory directory structure
      const partitionsPath = path.join(basePath, '.swarm', 'memory');
      const files = await this.walkDirectory(partitionsPath, '.json');

      for (const filePath of files) {
        try {
          const content = await fs.readFile(filePath, 'utf-8');
          const data = JSON.parse(content);

          // Extract namespace from file path
          const relativePath = path.relative(partitionsPath, filePath);
          const namespace = path.dirname(relativePath).replace(/\\/g, '/');

          if (Array.isArray(data)) {
            entries.push(...data.map((e: LegacyEntry) => ({ ...e, namespace })));
          } else if (data.entries) {
            entries.push(...data.entries.map((e: LegacyEntry) => ({ ...e, namespace })));
          }
        } catch (error) {
          this.addError(filePath, (error as Error).message, 'PARSE_ERROR', true);
        }
      }

      return entries;
    } catch (_error) {
      return [];
    }
  },

  async loadFromDistributedMemory(this: MemoryMigrator): Promise<LegacyEntry[]> {
    // Would integrate with DistributedMemorySystem nodes
    return this.loadFromSwarmMemory(); // Similar structure
  },

  async walkDirectory(this: MemoryMigrator, dir: string, extension: string): Promise<string[]> {
    const files: string[] = [];

    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          const subFiles = await this.walkDirectory(fullPath, extension);
          files.push(...subFiles);
        } else if (entry.isFile() && entry.name.endsWith(extension)) {
          files.push(fullPath);
        }
      }
    } catch (_error) {
      // Directory doesn't exist or isn't readable
    }

    return files;
  },

  parseMarkdownEntry(
    this: MemoryMigrator,
    filePath: string,
    content: string,
    basePath: string,
  ): LegacyEntry | null {
    // Extract frontmatter if present
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);

    const metadata: Record<string, unknown> = {};
    let body = content;

    if (frontmatterMatch) {
      try {
        // Simple YAML-like parsing
        const frontmatter = frontmatterMatch[1];
        for (const line of frontmatter.split('\n')) {
          const colonIndex = line.indexOf(':');
          if (colonIndex > 0) {
            const key = line.substring(0, colonIndex).trim();
            let value: unknown = line.substring(colonIndex + 1).trim();

            // Parse common types
            if (value === 'true') value = true;
            else if (value === 'false') value = false;
            else if (typeof value === 'string' && /^\d+$/.test(value)) value = parseInt(value, 10);
            else if (typeof value === 'string' && value.startsWith('[') && value.endsWith(']')) {
              try {
                value = JSON.parse(value.replace(/'/g, '"'));
              } catch {
                // Keep as string
              }
            }

            metadata[key] = value;
          }
        }
        body = frontmatterMatch[2];
      } catch {
        // Failed to parse frontmatter, use whole content
      }
    }

    // Derive key from file path
    const relativePath = path.relative(basePath, filePath);
    const key = relativePath.replace(/\\/g, '/').replace(/\.md$/, '').replace(/\//g, ':');

    // Derive namespace from directory structure
    const namespace = path.dirname(relativePath).replace(/\\/g, '/') || 'default';

    return {
      key,
      value: body.trim(),
      namespace,
      tags: Array.isArray(metadata.tags) ? metadata.tags : [],
      metadata,
      timestamp: Date.now(),
    };
  },
};
