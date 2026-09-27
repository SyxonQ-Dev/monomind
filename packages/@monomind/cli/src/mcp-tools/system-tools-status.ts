import { existsSync, readFileSync, statSync } from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import type { SystemMetrics } from './system-tools-core.js';
import {
  loadMetrics,
  MAX_SYSTEM_STORE_BYTES,
  PKG_VERSION,
  saveMetrics,
} from './system-tools-core.js';
import { getMonomindDataRoot, type MCPTool } from './types.js';

export const systemStatusTool: MCPTool = {
  name: 'system_status',
  description: 'Get overall system status',
  category: 'system',
  inputSchema: {
    type: 'object',
    properties: {
      verbose: { type: 'boolean', description: 'Include detailed information' },
      components: {
        type: 'array',
        items: { type: 'string' },
        description: 'Specific components to check',
      },
    },
  },
  handler: async (input) => {
    const metrics = loadMetrics();
    const uptime = Date.now() - new Date(metrics.startTime).getTime();

    const status = {
      status: metrics.health >= 0.8 ? 'healthy' : metrics.health >= 0.5 ? 'degraded' : 'unhealthy',
      uptime,
      uptimeFormatted: `${Math.floor(uptime / 3600000)}h ${Math.floor((uptime % 3600000) / 60000)}m`,
      version: PKG_VERSION,
      components: {
        swarm: {
          status: 'unknown',
          _note:
            'Swarm status not measured — no live health probe wired up here; use system_health for real checks',
        },
        memory: {
          status: 'unknown',
          _note: 'Health not measured — use system_health for real checks',
        },
        neural: {
          status: 'unknown',
          _note: 'Health not measured — use system_health for real checks',
        },
        mcp: {
          status: 'unknown',
          _note: 'Health not measured — use system_health for real checks',
        },
      },
      lastCheck: new Date().toISOString(),
    };

    if (input.verbose) {
      return {
        ...status,
        metrics: {
          cpu: metrics.cpu,
          memory: metrics.memory,
          agents: metrics.agents,
          tasks: metrics.tasks,
        },
      };
    }

    return status;
  },
};

export const systemMetricsTool: MCPTool = {
  name: 'system_metrics',
  description: 'Get system metrics and performance data',
  category: 'system',
  inputSchema: {
    type: 'object',
    properties: {
      category: {
        type: 'string',
        enum: ['all', 'cpu', 'memory', 'agents', 'tasks', 'requests'],
        description: 'Metrics category',
      },
      timeRange: { type: 'string', description: 'Time range (e.g., 1h, 24h, 7d)' },
      format: {
        type: 'string',
        enum: ['json', 'table', 'summary'],
        description: 'Output format',
      },
    },
  },
  handler: async (input) => {
    const store = loadMetrics();
    const VALID_CATEGORIES = new Set(['all', 'cpu', 'memory', 'agents', 'tasks', 'requests']);
    const rawCategory = (input.category as string) || 'all';
    const category = VALID_CATEGORIES.has(rawCategory) ? rawCategory : 'all';

    // Get REAL system metrics via Node.js APIs
    const memUsage = process.memoryUsage();
    const loadAvg = os.loadavg();
    const cpus = os.cpus();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();

    // Read real agent/task counts — try memory backend first, fallback to JSON stores
    let agentCounts = { active: 0, total: 0 };
    let taskCounts = { pending: 0, completed: 0, failed: 0 };
    let _metricsSource: 'sqlite' | 'json-store' | 'none' = 'none';

    // Primary: SQLite-backed memory bridge
    try {
      const bridge = await import('../memory/memory-bridge.js');
      const agentResults = (await bridge.bridgeListEntries({
        namespace: 'agents',
        limit: 10000,
      })) as { entries?: Array<{ metadata?: string; value?: string }> } | null;
      const agentEntries = agentResults?.entries;
      if (agentEntries && agentEntries.length > 0) {
        let active = 0;
        for (const a of agentEntries) {
          try {
            const meta = a.metadata ? JSON.parse(a.metadata) : a.value ? JSON.parse(a.value) : {};
            if (meta.status === 'active' || meta.status === 'running') active++;
          } catch {
            /* skip unparseable */
          }
        }
        agentCounts = { total: agentEntries.length, active };
        _metricsSource = 'sqlite';
      }
      const taskResults = (await bridge.bridgeListEntries({
        namespace: 'tasks',
        limit: 10000,
      })) as { entries?: Array<{ metadata?: string; value?: string }> } | null;
      const taskEntries = taskResults?.entries;
      if (taskEntries && taskEntries.length > 0) {
        let pending = 0,
          completed = 0,
          failed = 0;
        for (const t of taskEntries) {
          try {
            const meta = t.metadata ? JSON.parse(t.metadata) : t.value ? JSON.parse(t.value) : {};
            if (meta.status === 'pending' || meta.status === 'assigned') pending++;
            else if (meta.status === 'completed') completed++;
            else if (meta.status === 'failed') failed++;
          } catch {
            /* skip */
          }
        }
        taskCounts = { pending, completed, failed };
        _metricsSource = 'sqlite';
      }
    } catch {
      /* memory backend unavailable, try JSON fallback */
    }

    // Fallback: JSON store files (backward compatibility)
    if (_metricsSource === 'none') {
      try {
        const agentStorePath = join(getMonomindDataRoot(), 'agents', 'store.json');
        if (existsSync(agentStorePath) && statSync(agentStorePath).size <= MAX_SYSTEM_STORE_BYTES) {
          const agentStore = JSON.parse(readFileSync(agentStorePath, 'utf-8'));
          const agents = Object.values(agentStore.agents || {}) as Array<{ status: string }>;
          agentCounts = {
            total: agents.length,
            active: agents.filter((a) => a.status === 'active' || a.status === 'running').length,
          };
          _metricsSource = 'json-store';
        }
      } catch {
        /* agent store not available */
      }
      try {
        const taskStorePath = join(getMonomindDataRoot(), 'tasks', 'store.json');
        if (existsSync(taskStorePath) && statSync(taskStorePath).size <= MAX_SYSTEM_STORE_BYTES) {
          const taskStore = JSON.parse(readFileSync(taskStorePath, 'utf-8'));
          const tasks = Object.values(taskStore.tasks || {}) as Array<{ status: string }>;
          taskCounts = {
            pending: tasks.filter((t) => t.status === 'pending' || t.status === 'assigned').length,
            completed: tasks.filter((t) => t.status === 'completed').length,
            failed: tasks.filter((t) => t.status === 'failed').length,
          };
          _metricsSource = 'json-store';
        }
      } catch {
        /* task store not available */
      }
    }

    const currentMetrics: SystemMetrics = {
      ...store,
      cpu: (loadAvg[0] * 100) / cpus.length, // Real CPU load percentage
      memory: {
        used: Math.round((totalMem - freeMem) / 1024 / 1024), // Real MB used
        total: Math.round(totalMem / 1024 / 1024), // Real total MB
      },
      agents: agentCounts,
      tasks: taskCounts,
      requests: await (async () => {
        try {
          const { getRequestCounts } = await import('./request-tracker.js');
          const live = getRequestCounts();
          if (live.total > 0) {
            return { total: live.total, success: live.success, errors: live.errors };
          }
        } catch {
          /* tracker not available — fall back to stored value */
        }
        return store.requests;
      })(),
      uptime: Date.now() - new Date(store.startTime).getTime(),
      lastCheck: new Date().toISOString(),
    };

    saveMetrics(currentMetrics);

    if (category === 'all') {
      return {
        ...currentMetrics,
        _real: true,
        _metricsSource,
        heap: {
          used: Math.round(memUsage.heapUsed / 1024 / 1024),
          total: Math.round(memUsage.heapTotal / 1024 / 1024),
          external: Math.round(memUsage.external / 1024 / 1024),
        },
        loadAverage: loadAvg,
        cpuCores: cpus.length,
      };
    }

    const categoryMap: Record<string, unknown> = {
      cpu: {
        usage: currentMetrics.cpu,
        cores: cpus.length,
        load: loadAvg,
        model: cpus[0]?.model,
        _real: true,
      },
      memory: {
        ...currentMetrics.memory,
        heap: Math.round(memUsage.heapUsed / 1024 / 1024),
        heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
        free: Math.round(freeMem / 1024 / 1024),
        _real: true,
      },
      agents: currentMetrics.agents,
      tasks: currentMetrics.tasks,
      requests: currentMetrics.requests,
    };

    return categoryMap[category] || currentMetrics;
  },
};
