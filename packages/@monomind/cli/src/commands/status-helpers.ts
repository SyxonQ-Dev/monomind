import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Status refresh interval (ms)
export const DEFAULT_WATCH_INTERVAL = 2000;

// Track CPU usage over time
let lastCpuUsage: { user: number; system: number } | null = null;
let lastCpuTime = Date.now();

// Get real process CPU usage percentage
export function getProcessCpuUsage(): number {
  const cpuUsage = process.cpuUsage(
    lastCpuUsage ? { user: lastCpuUsage.user, system: lastCpuUsage.system } : undefined,
  );
  const now = Date.now();
  const elapsed = now - lastCpuTime;

  // Calculate percentage (cpuUsage is in microseconds)
  const totalCpu = (cpuUsage.user + cpuUsage.system) / 1000; // Convert to ms
  const percentage = elapsed > 0 ? (totalCpu / elapsed) * 100 : 0;

  // Update for next call
  lastCpuUsage = cpuUsage;
  lastCpuTime = now;

  return Math.min(100, Math.max(0, percentage));
}

// Get real process memory usage percentage
export function getProcessMemoryUsage(): number {
  const memoryUsage = process.memoryUsage();
  const totalMemory = os.totalmem();
  const usedMemory = memoryUsage.heapUsed + memoryUsage.external;

  return (usedMemory / totalMemory) * 100;
}

// Check if project is initialized
export function isInitialized(cwd: string): boolean {
  const configPath = path.join(cwd, '.monomind', 'config.yaml');
  return fs.existsSync(configPath);
}

// Check liveness of a pid via a zero-signal, matching the pattern used in
// commands/start.ts (isPidAlive) / .claude/helpers/control-start.cjs.
function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Whether the `monomind start --daemon` background process is actually
// alive, determined by reading its real pid file — not assumed.
export function isDaemonRunning(cwd: string): boolean {
  const daemonPidPath = path.join(cwd, '.monomind', 'daemon.pid');
  if (!fs.existsSync(daemonPidPath)) return false;
  try {
    const pid = Number(fs.readFileSync(daemonPidPath, 'utf-8').trim());
    return isPidAlive(pid);
  } catch {
    return false;
  }
}

// Format bytes
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / k ** i).toFixed(1))} ${sizes[i]}`;
}
