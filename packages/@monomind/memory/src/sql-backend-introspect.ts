/**
 * Introspection methods for SqlBackend (stats/health/persist).
 *
 * File-size sweep: split out of sql-backend.ts. Mixed into
 * SqlBackend.prototype at the bottom of sql-backend.ts.
 *
 * @module v1/memory/sql-backend-introspect
 */

import type { SqlBackend } from './sql-backend.js';
import type { BackendStats, ComponentHealth, HealthCheckResult, MemoryType } from './types.js';

export const sqlBackendIntrospectMethods = {
  async getStats(this: SqlBackend): Promise<BackendStats> {
    this.ensureInitialized();
    const d = this.driver!;

    const entriesByNamespace: Record<string, number> = {};
    for (const row of d.all(
      'SELECT namespace, COUNT(*) as count FROM memory_entries GROUP BY namespace',
    )) {
      entriesByNamespace[String(row.namespace)] = Number(row.count);
    }

    const entriesByType: Record<MemoryType, number> = {
      episodic: 0,
      semantic: 0,
      working: 0,
      cache: 0,
    };
    for (const row of d.all('SELECT type, COUNT(*) as count FROM memory_entries GROUP BY type')) {
      entriesByType[String(row.type) as MemoryType] = Number(row.count);
    }

    // page_count/page_size are native-only; sql.js reports 0 rather than a
    // fabricated figure.
    let memoryUsage = 0;
    const pageCount = d.pragma('page_count');
    const pageSize = d.pragma('page_size');
    if (typeof pageCount === 'number' && typeof pageSize === 'number') {
      memoryUsage = pageCount * pageSize;
    }

    return {
      totalEntries: await this.count(),
      entriesByNamespace,
      entriesByType,
      memoryUsage,
      avgQueryTime:
        this.stats.queryCount > 0 ? this.stats.totalQueryTime / this.stats.queryCount : 0,
      avgSearchTime: 0,
    };
  },

  async healthCheck(this: SqlBackend): Promise<HealthCheckResult> {
    const issues: string[] = [];
    const recommendations: string[] = [];

    if (!this.initialized || !this.driver) {
      return {
        status: 'unhealthy',
        components: {
          storage: { status: 'unhealthy', latency: 0, message: 'Not initialized' },
          index: { status: 'healthy', latency: 0 },
          cache: { status: 'healthy', latency: 0 },
        },
        timestamp: Date.now(),
        issues: ['Backend not initialized'],
        recommendations: ['Call initialize() before using'],
      };
    }

    let storageHealth: ComponentHealth;
    try {
      const integrity = this.driver.pragma('integrity_check');
      if (integrity === undefined || integrity === 'ok') {
        // undefined means the driver cannot run the check, not that it failed.
        storageHealth = { status: 'healthy', latency: 0 };
      } else {
        issues.push('Database integrity check failed');
        recommendations.push('Run VACUUM to repair database');
        storageHealth = { status: 'unhealthy', latency: 0, message: 'Integrity check failed' };
      }
    } catch (error) {
      issues.push('Failed to check database integrity');
      storageHealth = { status: 'unhealthy', latency: 0, message: String(error) };
    }

    const totalEntries = await this.count();
    const utilizationPercent = (totalEntries / this.config.maxEntries) * 100;
    if (utilizationPercent > 95) {
      issues.push('Storage utilization critical (>95%)');
      recommendations.push('Cleanup old data or increase maxEntries');
      storageHealth = { status: 'unhealthy', latency: 0, message: 'Near capacity' };
    } else if (utilizationPercent > 80) {
      issues.push('Storage utilization high (>80%)');
      recommendations.push('Consider cleanup');
      if (storageHealth.status === 'healthy') {
        storageHealth = { status: 'degraded', latency: 0, message: 'High utilization' };
      }
    }

    const status =
      storageHealth.status === 'unhealthy'
        ? 'unhealthy'
        : storageHealth.status === 'degraded'
          ? 'degraded'
          : 'healthy';

    return {
      status,
      components: {
        storage: storageHealth,
        index: { status: 'healthy', latency: 0 },
        cache: { status: 'healthy', latency: 0 },
      },
      timestamp: Date.now(),
      issues,
      recommendations,
    };
  },

  /** Flush to durable storage. No-op on write-through drivers. */
  async persist(this: SqlBackend): Promise<void> {
    if (!this.driver) return;
    await this.driver.persist();
  },
};
