/**
 * Doctor — background worker output checks: metrics freshness and security
 * audit findings. Extracted from doctor-project-checks.ts.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { HealthCheck } from './doctor-env-checks.js';

// Workers refresh at session start when output is >6h old — allow a grace
// window beyond that before flagging staleness.
const METRICS_FRESHNESS_MS = 12 * 60 * 60 * 1000; // 12 hours
const MAX_DOCTOR_METRICS_BYTES = 5 * 1024 * 1024;

function readMetricsJSON(name: string): unknown | null {
  try {
    const p = join(process.cwd(), '.monomind', 'metrics', name);
    if (!existsSync(p) || statSync(p).size > MAX_DOCTOR_METRICS_BYTES) return null;
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch (e) {
    if (process.env.DEBUG || process.env.MONOMIND_DEBUG)
      console.error(`[readMetricsJSON] failed to read ${name}:`, e);
    return null;
  }
}

/**
 * Worker metrics freshness — reports the age of the @monoes/hooks worker
 * output files (written at session start with a 6h staleness gate, or on
 * demand via `monomind hooks worker run <name>`), so missing/stale worker
 * output is visible without digging through .monomind/metrics.
 */
export async function checkMetricsFreshness(): Promise<HealthCheck> {
  const metricsDir = join(process.cwd(), '.monomind', 'metrics');
  const knownOutputs = [
    'codebase-map.json',
    'security-audit.json',
    'performance.json',
    'consolidation.json',
    'ddd-progress.json',
  ];
  if (!existsSync(metricsDir)) {
    return {
      name: 'Worker Metrics',
      status: 'warn',
      message: 'No .monomind/metrics — workers have not run yet (they run at session start)',
      fix: 'monomind hooks worker run map',
    };
  }
  const now = Date.now();
  const fresh: string[] = [];
  const stale: string[] = [];
  for (const name of knownOutputs) {
    const p = join(metricsDir, name);
    if (!existsSync(p)) continue;
    try {
      const ageMs = now - statSync(p).mtimeMs;
      if (ageMs <= METRICS_FRESHNESS_MS) fresh.push(name);
      else stale.push(name);
    } catch {
      /* skip unreadable */
    }
  }
  if (fresh.length === 0 && stale.length === 0) {
    return {
      name: 'Worker Metrics',
      status: 'warn',
      message: 'No worker output files found yet (they run at session start)',
      fix: 'monomind hooks worker run map',
    };
  }
  if (stale.length === 0) {
    return {
      name: 'Worker Metrics',
      status: 'pass',
      message: `${fresh.length} metrics file(s) fresh (<12h)`,
    };
  }
  return {
    name: 'Worker Metrics',
    status: 'warn',
    message: `${stale.length} stale (>12h): ${stale.join(', ')}${fresh.length > 0 ? ` — ${fresh.length} fresh` : ''}`,
    fix: 'monomind hooks worker run <name>  # map, audit, consolidate, ddd',
  };
}

/**
 * Surfaces critical findings from the security-audit worker output.
 */
export async function checkSecurityAuditFindings(): Promise<HealthCheck> {
  const audit = readMetricsJSON('security-audit.json') as {
    riskLevel?: string;
    recommendations?: string[];
    priorityScanTargets?: Array<{ file: string; reason?: string }>;
    timestamp?: string;
  } | null;

  if (!audit) {
    return {
      name: 'Security Audit',
      status: 'warn',
      message: 'No security-audit.json yet',
      fix: 'monomind hooks worker run audit',
    };
  }

  const riskLevel = (audit.riskLevel || 'low').toLowerCase();
  const recommendations = audit.recommendations || [];
  const priorityTargets = audit.priorityScanTargets || [];
  const criticalCount =
    recommendations.length +
    (riskLevel === 'high' || riskLevel === 'critical' ? priorityTargets.length : 0);

  if (riskLevel === 'critical' || riskLevel === 'high') {
    return {
      name: 'Security Audit',
      status: 'fail',
      message: `risk=${riskLevel}, ${criticalCount} critical finding(s) — ${priorityTargets.length} priority scan target(s)`,
      fix: 'Review .monomind/metrics/security-audit.json priorityScanTargets and recommendations',
    };
  }
  if (recommendations.length > 0) {
    return {
      name: 'Security Audit',
      status: 'warn',
      message: `risk=${riskLevel}, ${recommendations.length} recommendation(s)`,
    };
  }
  return { name: 'Security Audit', status: 'pass', message: `risk=${riskLevel}, no open findings` };
}
