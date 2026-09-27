/**
 * Memory Migration Utility
 *
 * Migrates data from legacy memory systems (Markdown, JSON, etc.)
 * to the unified memory system (any IMemoryBackend — SQLite via
 * better-sqlite3/sql.js as of 2026-07).
 *
 * File-size sweep: the class's method BODIES are grouped into sibling
 * modules — legacy source loaders (SQLite/Markdown/JSON/swarm/distributed) in
 * migration-loaders.ts, and batch processing + legacy-entry transformation in
 * migration-transform.ts — mixed onto MemoryMigrator.prototype below. Each
 * stays a real method here (same signature, same visibility) so callers and
 * TypeScript see no difference; the body is just
 * `return theSiblingImpl.call(this, ...args)`. Fields those bodies read/write
 * moved from `private` to `protected` (compile-time only; no runtime change)
 * — TypeScript allows a standalone function typed `this: MemoryMigrator` to
 * reach `protected` members but not `private` ones, so `protected` is the
 * minimum visibility the split needs.
 *
 * @module v1/memory/migration
 */

import { EventEmitter } from 'node:events';
import { type LegacyEntry, migrationLoaderMethods } from './migration-loaders.js';
import { migrationTransformMethods } from './migration-transform.js';
import type {
  EmbeddingGenerator,
  IMemoryBackend,
  MemoryEntry,
  MigrationConfig,
  MigrationError,
  MigrationProgress,
  MigrationResult,
  MigrationSource,
} from './types.js';

export type { LegacyEntry };

/**
 * Default migration configuration
 */
const DEFAULT_MIGRATION_CONFIG: Partial<MigrationConfig> = {
  batchSize: 100,
  generateEmbeddings: true,
  validateData: true,
  continueOnError: true,
};

/**
 * Memory Migration Manager
 *
 * Handles migration from:
 * - SQLite backends (.db files)
 * - Markdown backends (.md files)
 * - JSON memory stores (.json files)
 * - MemoryManager instances
 * - SwarmMemory instances
 * - DistributedMemory instances
 */
export class MemoryMigrator extends EventEmitter {
  protected config: MigrationConfig;
  protected target: IMemoryBackend;
  protected embeddingGenerator?: EmbeddingGenerator;
  protected progress: MigrationProgress;

  constructor(
    target: IMemoryBackend,
    config: Partial<MigrationConfig>,
    embeddingGenerator?: EmbeddingGenerator,
  ) {
    super();
    this.target = target;
    this.config = { ...DEFAULT_MIGRATION_CONFIG, ...config } as MigrationConfig;
    this.embeddingGenerator = embeddingGenerator;
    this.progress = this.initializeProgress();
  }

  /**
   * Run the migration
   */
  async migrate(): Promise<MigrationResult> {
    const startTime = Date.now();
    this.progress = this.initializeProgress();

    this.emit('migration:started', { source: this.config.source });

    try {
      // Load entries from source
      const entries = await this.loadFromSource();
      this.progress.total = entries.length;
      this.progress.totalBatches = Math.ceil(entries.length / this.config.batchSize);

      this.emit('migration:progress', { ...this.progress });

      // Process in batches
      for (let i = 0; i < entries.length; i += this.config.batchSize) {
        const batch = entries.slice(i, i + this.config.batchSize);
        this.progress.currentBatch = Math.floor(i / this.config.batchSize) + 1;

        await this.processBatch(batch);

        this.progress.percentage = Math.round((this.progress.migrated / this.progress.total) * 100);
        this.progress.estimatedTimeRemaining = this.estimateTimeRemaining(
          startTime,
          this.progress.migrated,
          this.progress.total,
        );

        this.emit('migration:progress', { ...this.progress });
      }

      const duration = Date.now() - startTime;

      const result: MigrationResult = {
        success: this.progress.failed === 0 || this.config.continueOnError,
        progress: { ...this.progress },
        duration,
        summary: this.generateSummary(),
      };

      this.emit('migration:completed', result);
      return result;
    } catch (error) {
      const duration = Date.now() - startTime;

      const result: MigrationResult = {
        success: false,
        progress: { ...this.progress },
        duration,
        summary: `Migration failed: ${(error as Error).message}`,
      };

      this.emit('migration:failed', { error, result });
      return result;
    }
  }

  /**
   * Get current migration progress
   */
  getProgress(): MigrationProgress {
    return { ...this.progress };
  }

  // ===== Source Loaders (bodies live in migration-loaders.ts) =====

  protected async loadFromSource(): Promise<LegacyEntry[]> {
    return migrationLoaderMethods.loadFromSource.call(this);
  }

  protected async loadFromSQLite(): Promise<LegacyEntry[]> {
    return migrationLoaderMethods.loadFromSQLite.call(this);
  }

  protected safeJsonParse<T>(value: string | undefined, fallback: T): T {
    return migrationLoaderMethods.safeJsonParse.call(this, value, fallback) as T;
  }

  protected async loadFromMarkdown(): Promise<LegacyEntry[]> {
    return migrationLoaderMethods.loadFromMarkdown.call(this);
  }

  protected async loadFromJSON(filePathOverride?: string): Promise<LegacyEntry[]> {
    return migrationLoaderMethods.loadFromJSON.call(this, filePathOverride);
  }

  protected async loadFromMemoryManager(): Promise<LegacyEntry[]> {
    return migrationLoaderMethods.loadFromMemoryManager.call(this);
  }

  protected async loadFromSwarmMemory(): Promise<LegacyEntry[]> {
    return migrationLoaderMethods.loadFromSwarmMemory.call(this);
  }

  protected async loadFromDistributedMemory(): Promise<LegacyEntry[]> {
    return migrationLoaderMethods.loadFromDistributedMemory.call(this);
  }

  protected async walkDirectory(dir: string, extension: string): Promise<string[]> {
    return migrationLoaderMethods.walkDirectory.call(this, dir, extension);
  }

  protected parseMarkdownEntry(
    filePath: string,
    content: string,
    basePath: string,
  ): LegacyEntry | null {
    return migrationLoaderMethods.parseMarkdownEntry.call(this, filePath, content, basePath);
  }

  // ===== Batch Processing (bodies live in migration-transform.ts) =====

  protected async processBatch(batch: LegacyEntry[]): Promise<void> {
    return migrationTransformMethods.processBatch.call(this, batch);
  }

  protected async transformEntry(legacy: LegacyEntry): Promise<MemoryEntry> {
    return migrationTransformMethods.transformEntry.call(this, legacy);
  }

  // ===== Helper Methods =====

  private initializeProgress(): MigrationProgress {
    return {
      total: 0,
      migrated: 0,
      failed: 0,
      skipped: 0,
      currentBatch: 0,
      totalBatches: 0,
      percentage: 0,
      estimatedTimeRemaining: 0,
      errors: [],
    };
  }

  protected validateEntry(entry: LegacyEntry): { valid: boolean; reason?: string } {
    return migrationTransformMethods.validateEntry.call(this, entry);
  }

  protected addError(entryId: string, message: string, code: string, recoverable: boolean): void {
    const error: MigrationError = {
      entryId,
      message,
      code,
      recoverable,
    };
    this.progress.errors.push(error);
    this.emit('migration:error', error);
  }

  protected parseTimestamp(value: string | number | undefined): number {
    return migrationTransformMethods.parseTimestamp.call(this, value);
  }

  protected isValidMemoryType(type: string): boolean {
    return migrationTransformMethods.isValidMemoryType.call(this, type);
  }

  private estimateTimeRemaining(startTime: number, completed: number, total: number): number {
    if (completed === 0) return 0;

    const elapsed = Date.now() - startTime;
    const rate = completed / elapsed;
    const remaining = total - completed;

    return Math.round(remaining / rate);
  }

  private generateSummary(): string {
    const { migrated, failed, skipped, total, errors } = this.progress;

    let summary = `Migrated ${migrated}/${total} entries`;

    if (failed > 0) {
      summary += `, ${failed} failed`;
    }

    if (skipped > 0) {
      summary += `, ${skipped} skipped`;
    }

    if (errors.length > 0) {
      const errorTypes = new Map<string, number>();
      for (const error of errors) {
        errorTypes.set(error.code, (errorTypes.get(error.code) || 0) + 1);
      }

      const errorSummary = Array.from(errorTypes.entries())
        .map(([code, count]) => `${code}: ${count}`)
        .join(', ');

      summary += `. Errors: ${errorSummary}`;
    }

    return summary;
  }
}

/**
 * Convenience function to create a migrator
 */
export function createMigrator(
  target: IMemoryBackend,
  source: MigrationSource,
  sourcePath: string,
  options: Partial<MigrationConfig> = {},
  embeddingGenerator?: EmbeddingGenerator,
): MemoryMigrator {
  return new MemoryMigrator(target, { source, sourcePath, ...options }, embeddingGenerator);
}

/**
 * Migrate from multiple sources
 */
export async function migrateMultipleSources(
  target: IMemoryBackend,
  sources: Array<{ source: MigrationSource; path: string }>,
  options: Partial<MigrationConfig> = {},
  embeddingGenerator?: EmbeddingGenerator,
): Promise<MigrationResult[]> {
  const results: MigrationResult[] = [];

  for (const { source, path: sourcePath } of sources) {
    const migrator = createMigrator(target, source, sourcePath, options, embeddingGenerator);
    const result = await migrator.migrate();
    results.push(result);
  }

  return results;
}

export default MemoryMigrator;
