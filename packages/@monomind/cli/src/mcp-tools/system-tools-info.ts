import * as os from 'node:os';
import type { SystemMetrics } from './system-tools-core.js';
import { PKG_VERSION, saveMetrics } from './system-tools-core.js';
import type { MCPTool } from './types.js';

export const systemInfoTool: MCPTool = {
  name: 'system_info',
  description: 'Get system information',
  category: 'system',
  inputSchema: {
    type: 'object',
    properties: {
      include: {
        type: 'array',
        items: { type: 'string' },
        description: 'Information to include',
      },
    },
  },
  handler: async () => {
    return {
      version: PKG_VERSION,
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      pid: process.pid,
      env: process.env.NODE_ENV || 'development',
      features: {
        swarm: true,
        memory: true,
        // Neural pattern learning and the HNSW index are dead paths at
        // runtime (keyword routing only; HNSW is a sql.js-fallback that's
        // a no-op unless the SQLite bridge is down) — see hooks-intelligence.ts
        // where both report 'not-loaded'.
        neural: false,
        hnsw: false,
        quantization: true,
        flashAttention: false,
      },
      limits: {
        // Real clamp applied in monoswarm-tools.ts: Math.min(Math.max(x || 8, 1), 50)
        maxAgents: 50,
        maxTasks: 1000,
        maxMemory: `${Math.round(os.totalmem() / 1024 / 1024 / 1024)}GB`,
      },
    };
  },
};

export const systemResetTool: MCPTool = {
  name: 'system_reset',
  description: 'Reset system state',
  category: 'system',
  inputSchema: {
    type: 'object',
    properties: {
      component: {
        type: 'string',
        description: 'Component to reset (all, metrics)',
      },
      confirm: { type: 'boolean', description: 'Confirm reset' },
    },
    required: ['confirm'],
  },
  handler: async (input) => {
    if (!input.confirm) {
      return { success: false, error: 'Reset requires confirmation' };
    }

    // The implementation below only ever resets metrics — there is no
    // separate agents/tasks reset path. `component` used to accept
    // 'agents'/'tasks' and silently reset metrics anyway while reporting
    // success for whatever was asked, which misrepresented what actually
    // happened. Only accept the values this handler can genuinely fulfill.
    const VALID_COMPONENTS = new Set(['all', 'metrics']);
    const rawComponent = (input.component as string) || 'metrics';
    if (!VALID_COMPONENTS.has(rawComponent)) {
      return {
        success: false,
        error: `Unsupported component '${rawComponent}'. system_reset only supports: ${[...VALID_COMPONENTS].join(', ')}.`,
      };
    }
    const component = rawComponent;

    // Reset metrics to defaults
    const defaultMetrics: SystemMetrics = {
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

    saveMetrics(defaultMetrics);

    return {
      success: true,
      component,
      resetAt: new Date().toISOString(),
      message: `System ${component} has been reset`,
    };
  },
};
