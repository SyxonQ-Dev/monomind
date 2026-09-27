/**
 * Batch processing and legacy-entry transformation for MemoryMigrator.
 * File-size sweep: split out of migration.ts. Mixed into
 * MemoryMigrator.prototype at the bottom of migration.ts.
 *
 * @module v1/memory/migration-transform
 */

import type { MemoryMigrator } from './migration.js';
import type { LegacyEntry } from './migration-loaders.js';
import {
  createDefaultEntry,
  type MemoryEntry,
  type MemoryEntryInput,
  type MemoryType,
} from './types.js';

export const migrationTransformMethods = {
  async processBatch(this: MemoryMigrator, batch: LegacyEntry[]): Promise<void> {
    for (const legacyEntry of batch) {
      try {
        // Validate if enabled
        if (this.config.validateData) {
          const validation = this.validateEntry(legacyEntry);
          if (!validation.valid) {
            if (this.config.continueOnError) {
              this.addError(
                legacyEntry.key || 'unknown',
                validation.reason || 'Validation failed',
                'VALIDATION_ERROR',
                false,
              );
              this.progress.skipped++;
              continue;
            } else {
              throw new Error(validation.reason);
            }
          }
        }

        // Transform to new format
        const newEntry = await this.transformEntry(legacyEntry);

        // Store in target
        await this.target.store(newEntry);
        this.progress.migrated++;
      } catch (error) {
        if (this.config.continueOnError) {
          this.addError(
            legacyEntry.key || 'unknown',
            (error as Error).message,
            'STORE_ERROR',
            true,
          );
          this.progress.failed++;
        } else {
          throw error;
        }
      }
    }
  },

  async transformEntry(this: MemoryMigrator, legacy: LegacyEntry): Promise<MemoryEntry> {
    // Map namespace if configured
    let namespace = legacy.namespace || 'default';
    if (this.config.namespaceMapping?.[namespace]) {
      namespace = this.config.namespaceMapping[namespace];
    }

    // Determine content
    const content = typeof legacy.value === 'string' ? legacy.value : JSON.stringify(legacy.value);

    // Map type if configured
    let type: MemoryType = 'semantic';
    if (legacy.metadata?.type && typeof legacy.metadata.type === 'string') {
      if (this.config.typeMapping?.[legacy.metadata.type]) {
        type = this.config.typeMapping[legacy.metadata.type];
      } else if (this.isValidMemoryType(legacy.metadata.type)) {
        type = legacy.metadata.type as MemoryType;
      }
    }

    // Parse timestamps
    const createdAt = this.parseTimestamp(
      legacy.createdAt || legacy.created_at || legacy.timestamp,
    );
    const updatedAt = this.parseTimestamp(
      legacy.updatedAt || legacy.updated_at || legacy.timestamp,
    );

    const input: MemoryEntryInput = {
      key: legacy.key,
      content,
      type,
      namespace,
      tags: legacy.tags || [],
      metadata: {
        ...legacy.metadata,
        migrated: true,
        migrationSource: this.config.source,
        migrationTimestamp: Date.now(),
        originalValue: legacy.value,
      },
    };

    const entry = createDefaultEntry(input);
    entry.createdAt = createdAt;
    entry.updatedAt = updatedAt;

    // Generate embedding if configured
    if (this.config.generateEmbeddings && this.embeddingGenerator) {
      try {
        entry.embedding = await this.embeddingGenerator(content);
      } catch (error) {
        // Log but don't fail
        this.emit('migration:warning', {
          message: `Failed to generate embedding for ${legacy.key}: ${(error as Error).message}`,
        });
      }
    }

    return entry;
  },

  validateEntry(this: MemoryMigrator, entry: LegacyEntry): { valid: boolean; reason?: string } {
    if (!entry.key || typeof entry.key !== 'string') {
      return { valid: false, reason: 'Missing or invalid key' };
    }

    if (entry.value === undefined) {
      return { valid: false, reason: 'Missing value' };
    }

    if (entry.key.length > 500) {
      return { valid: false, reason: 'Key too long (max 500 chars)' };
    }

    return { valid: true };
  },

  isValidMemoryType(this: MemoryMigrator, type: string): boolean {
    // 'procedural' kept here for legacy migration compatibility only —
    // it is no longer a valid MemoryType (procedural memory removed).
    return ['episodic', 'semantic', 'procedural', 'working', 'cache'].includes(type);
  },

  parseTimestamp(this: MemoryMigrator, value: string | number | undefined): number {
    if (!value) return Date.now();

    if (typeof value === 'number') {
      // Handle both milliseconds and seconds
      return value > 1e12 ? value : value * 1000;
    }

    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? Date.now() : parsed;
  },
};
