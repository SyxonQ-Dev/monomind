import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getProjectCwd } from './types.js';

// Read version dynamically from package.json
function getPackageVersion(): string {
  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const pkgPath = join(__dirname, '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return pkg.version || '3.0.0';
  } catch {
    return '3.0.0';
  }
}
export const PKG_VERSION = getPackageVersion();

// Storage paths
const STORAGE_DIR = '.monomind';
const SYSTEM_DIR = 'system';
const METRICS_FILE = 'metrics.json';

export interface SystemMetrics {
  startTime: string;
  lastCheck: string;
  uptime: number;
  health: number;
  cpu: number;
  memory: { used: number; total: number };
  agents: { active: number; total: number };
  tasks: { pending: number; completed: number; failed: number };
  requests: { total: number; success: number; errors: number };
}

function getSystemDir(): string {
  return join(getProjectCwd(), STORAGE_DIR, SYSTEM_DIR);
}

function getMetricsPath(): string {
  return join(getSystemDir(), METRICS_FILE);
}

function ensureSystemDir(): void {
  const dir = getSystemDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export const MAX_SYSTEM_STORE_BYTES = 50 * 1024 * 1024; // 50 MB

export function loadMetrics(): SystemMetrics {
  try {
    const path = getMetricsPath();
    if (existsSync(path) && statSync(path).size <= MAX_SYSTEM_STORE_BYTES) {
      return JSON.parse(readFileSync(path, 'utf-8'));
    }
  } catch (e) {
    if (process.env.DEBUG || process.env.MONOMIND_DEBUG)
      console.error('[loadMetrics] failed to read/parse metrics.json, using defaults:', e);
  }
  return {
    startTime: new Date().toISOString(),
    lastCheck: new Date().toISOString(),
    uptime: 0,
    health: 1.0,
    cpu: (os.loadavg()[0] * 100) / os.cpus().length,
    memory: {
      used: Math.round((os.totalmem() - os.freemem()) / 1024 / 1024),
      total: Math.round(os.totalmem() / 1024 / 1024),
    },
    agents: { active: 0, total: 0 },
    tasks: { pending: 0, completed: 0, failed: 0 },
    requests: { total: 0, success: 0, errors: 0 },
  };
}

export function saveMetrics(metrics: SystemMetrics): void {
  ensureSystemDir();
  metrics.lastCheck = new Date().toISOString();
  const tmpPath = `${getMetricsPath()}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(metrics, null, 2), 'utf-8');
  renameSync(tmpPath, getMetricsPath());
}
