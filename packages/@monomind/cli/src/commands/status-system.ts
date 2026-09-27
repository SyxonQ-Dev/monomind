import { callMCPTool } from '../mcp-client.js';
import { output } from '../output.js';
import {
  formatBytes,
  getProcessCpuUsage,
  getProcessMemoryUsage,
  isDaemonRunning,
} from './status-helpers.js';

// Get system status data
export async function getSystemStatus(cwd: string): Promise<{
  initialized: boolean;
  running: boolean;
  swarm: {
    id: string | null;
    topology: string;
    // monoswarm_status (mcp-tools/monoswarm-tools.ts) only ever returns a `status`
    // string and an `agentCount` number for agents — never a health verdict,
    // an uptime, or an active/idle breakdown. Those used to be read anyway
    // and silently resolved to `undefined`/`NaN` in the display.
    status: string;
    agents: { total: number };
  };
  mcp: {
    running: boolean;
    port: number | null;
    transport: string;
  };
  memory: {
    entries: number;
    size: string;
    backend: string;
    performance: { searchTime: number; cacheHitRate: number };
  };
  tasks: {
    total: number;
    pending: number;
    running: number;
    completed: number;
    failed: number;
  };
  performance: {
    cpuUsage: number;
    memoryUsage: number;
    searchSpeed: string;
  };
}> {
  // Real daemon liveness — replaces a literal `running: true` that claimed
  // "running" for every project where the MCP tool calls below happened not
  // to throw, regardless of whether any Monomind process was actually alive.
  const daemonRunning = isDaemonRunning(cwd);

  try {
    // Get monoswarm status. monoswarm_status genuinely returns: monoswarmId,
    // status, topology, maxAgents, agentCount, taskCount, config, createdAt,
    // updatedAt — no `agents.{total,active,idle}` object, no `health`, no
    // `uptime`. Reading those non-existent fields used to resolve to
    // `undefined`/`NaN` in the rendered table instead of throwing.
    const swarmStatus = await callMCPTool<{
      monoswarmId?: string;
      status?: string;
      topology?: string;
      agentCount?: number;
    }>('monoswarm_status', { verbose: true });

    // Get MCP status
    let mcpStatus = { running: false, port: null as number | null, transport: 'stdio' };
    try {
      const mcp = await callMCPTool<{
        running: boolean;
        port: number;
        transport: string;
      }>('mcp_status', {});
      mcpStatus = mcp;
    } catch {
      // MCP not running
    }

    // Memory status — measured, not assumed.
    //
    // This block used to be hardcoded literals ({entries: 0, size: 0, backend:
    // 'sqlite', ...}) behind the comment "no MCP tool available; use defaults".
    // Every number in the Memory panel was therefore a constant presented as
    // telemetry: a project with a 139KB store and retrievable entries was told
    // "Entries 0, Size 0 B". Worse, the derived Memory Backend health check
    // compared against the same hardcoded 'sqlite', so it could never fail.
    //
    // On failure we report backend 'unknown' rather than a plausible-looking
    // zero, so "cannot measure" is distinguishable from "measured empty".
    const memoryStatus = {
      entries: 0,
      size: 0,
      backend: 'unknown',
      performance: { avgSearchTime: 0, cacheHitRate: 0 },
    };
    try {
      const { bridgeListEntries, bridgeGetDbPath } = await import('../memory/memory-bridge.js');
      const listed = await bridgeListEntries({ limit: 100_000 });
      if (listed?.success) {
        memoryStatus.entries = listed.entries?.length ?? 0;
        memoryStatus.backend = 'sqlite';
        try {
          const { statSync } = await import('node:fs');
          const { join } = await import('node:path');
          memoryStatus.size = statSync(join(bridgeGetDbPath(), 'memory.db')).size;
        } catch {
          /* size is a nicety; entries and backend are the load-bearing parts */
        }
      }
    } catch {
      /* leaves backend 'unknown' — an honest "could not read" */
    }

    // Get task status
    const taskStatus = await callMCPTool<{
      total: number;
      pending: number;
      running: number;
      completed: number;
      failed: number;
    }>('task_summary', {});

    return {
      initialized: true,
      running: daemonRunning,
      swarm: {
        id: swarmStatus.monoswarmId ?? null,
        topology: swarmStatus.topology ?? 'none',
        status: swarmStatus.status ?? 'no_swarm',
        agents: { total: swarmStatus.agentCount ?? 0 },
      },
      mcp: mcpStatus,
      memory: {
        entries: memoryStatus.entries,
        size: formatBytes(memoryStatus.size),
        backend: memoryStatus.backend,
        performance: {
          searchTime: memoryStatus.performance.avgSearchTime,
          cacheHitRate: memoryStatus.performance.cacheHitRate,
        },
      },
      tasks: taskStatus,
      performance: {
        cpuUsage: getProcessCpuUsage(),
        memoryUsage: getProcessMemoryUsage(),
        searchSpeed: 'not measured',
      },
    };
  } catch (error) {
    // Reaching here does NOT prove the system is stopped — it means reading its
    // state threw. The block below reports zeros for every panel, so swallowing
    // the cause made a failed read indistinguishable from a genuinely idle
    // project: a repo with a populated memory store and a live agent was told
    // "Total 0 / Entries 0 / Backend none".
    if (process.env.DEBUG || process.env.MONOMIND_DEBUG) {
      console.error('[status] could not read system state:', error);
    } else {
      output.writeln(
        output.warning(
          `Could not read full system state (${error instanceof Error ? error.message : String(error)}) — ` +
            'the figures below are defaults, not measurements. Re-run with DEBUG=1 for detail.',
        ),
      );
    }
    return {
      initialized: true,
      running: daemonRunning,
      swarm: {
        id: null,
        topology: 'none',
        status: 'no_swarm',
        agents: { total: 0 },
      },
      mcp: { running: false, port: null, transport: 'stdio' },
      memory: {
        entries: 0,
        size: '0 B',
        backend: 'none',
        performance: { searchTime: 0, cacheHitRate: 0 },
      },
      tasks: { total: 0, pending: 0, running: 0, completed: 0, failed: 0 },
      performance: {
        cpuUsage: 0,
        memoryUsage: 0,
        searchSpeed: 'N/A',
      },
    };
  }
}
