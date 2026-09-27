import { output } from '../output.js';
import type { getSystemStatus } from './status-system.js';

// Display status in text format
export async function displayStatus(
  status: Awaited<ReturnType<typeof getSystemStatus>>,
): Promise<void> {
  output.writeln();

  // Header with overall status
  const statusIcon = status.running ? output.success('[RUNNING]') : output.warning('[STOPPED]');
  output.writeln(`${output.bold('Monomind')} ${statusIcon}`);
  output.writeln();

  // Swarm section. monoswarm_status never returns a health verdict, an uptime,
  // or an active/idle breakdown — only `status`/`topology`/`agentCount` — so
  // those are the only fields shown here.
  output.writeln(output.bold('Swarm'));
  if (status.swarm.id) {
    output.printTable({
      columns: [
        { key: 'property', header: 'Property', width: 15 },
        { key: 'value', header: 'Value', width: 30 },
      ],
      data: [
        { property: 'ID', value: status.swarm.id },
        { property: 'Topology', value: status.swarm.topology },
        { property: 'Status', value: status.swarm.status },
      ],
    });
  } else {
    output.printInfo('  No active swarm');
  }
  output.writeln();

  // Agents section
  output.writeln(output.bold('Agents'));
  output.printTable({
    columns: [
      { key: 'status', header: 'Status', width: 12 },
      { key: 'count', header: 'Count', width: 10, align: 'right' },
    ],
    data: [{ status: output.bold('Total'), count: status.swarm.agents.total }],
  });
  output.writeln();

  // Tasks section
  output.writeln(output.bold('Tasks'));
  output.printTable({
    columns: [
      { key: 'status', header: 'Status', width: 12 },
      { key: 'count', header: 'Count', width: 10, align: 'right' },
    ],
    data: [
      { status: 'Pending', count: status.tasks.pending },
      { status: 'Running', count: status.tasks.running },
      { status: 'Completed', count: status.tasks.completed },
      { status: 'Failed', count: status.tasks.failed },
      { status: output.bold('Total'), count: status.tasks.total },
    ],
  });
  output.writeln();

  // Memory section
  output.writeln(output.bold('Memory'));
  output.printTable({
    columns: [
      { key: 'property', header: 'Property', width: 18 },
      { key: 'value', header: 'Value', width: 20, align: 'right' },
    ],
    data: [
      { property: 'Backend', value: status.memory.backend },
      { property: 'Entries', value: status.memory.entries },
      { property: 'Size', value: status.memory.size },
      { property: 'Search Time', value: `${status.memory.performance.searchTime.toFixed(2)}ms` },
      {
        property: 'Cache Hit Rate',
        value: `${(status.memory.performance.cacheHitRate * 100).toFixed(1)}%`,
      },
    ],
  });
  output.writeln();

  // MCP section
  output.writeln(output.bold('MCP Server'));
  if (status.mcp.running) {
    if (status.mcp.transport === 'stdio') {
      output.printInfo('  Running (stdio mode)');
    } else {
      output.printInfo(`  Running on port ${status.mcp.port} (${status.mcp.transport})`);
    }
  } else {
    output.printInfo('  Not running');
  }
  output.writeln();

  // Performance section
  if (status.running) {
    output.writeln(output.bold('Performance'));
    output.printList([
      `Vector Search: ${output.success(status.performance.searchSpeed)}`,
      `CPU Usage: ${status.performance.cpuUsage.toFixed(1)}%`,
      `Memory Usage: ${status.performance.memoryUsage.toFixed(1)}%`,
    ]);
  }

  // System resources section
  output.writeln(output.bold('System Resources'));
  try {
    const { checkResources } = await import('../utils/resource-governor.js');
    const res = checkResources();
    // Bound as closures, not bare method references — output.error/.warning/.success
    // are prototype methods that read `this.colorEnabled` via `this.color()`, so
    // assigning one directly (`output.warning`) and calling it later as `memColor(...)`
    // loses that binding and throws "Cannot read properties of undefined (reading 'color')".
    const memColor =
      res.freeMemPct < 15
        ? (text: string) => output.error(text)
        : res.freeMemPct < 30
          ? (text: string) => output.warning(text)
          : (text: string) => output.success(text);
    output.printTable({
      columns: [
        { key: 'property', header: 'Property', width: 18 },
        { key: 'value', header: 'Value', width: 25, align: 'right' },
      ],
      data: [
        { property: 'Available RAM', value: memColor(`${res.freeMemMB}MB (${res.freeMemPct}%)`) },
        { property: 'SDK Processes', value: `${res.sdkProcesses} / ${res.maxSdkProcesses} max` },
        {
          property: 'Status',
          value: res.ok ? output.success('OK') : output.warning(res.reason ?? 'pressure'),
        },
      ],
    });
  } catch (err) {
    output.printInfo('  Resource governor not available');
    output.printDebug(`resource governor error: ${err instanceof Error ? err.stack : String(err)}`);
  }
}

// Format health status with color
export function formatHealth(health: string): string {
  switch (health) {
    case 'healthy':
      return output.success(health);
    case 'degraded':
      return output.warning(health);
    case 'unhealthy':
    case 'stopped':
      return output.error(health);
    default:
      return health;
  }
}
