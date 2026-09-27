import { output } from '../output.js';
import type { CommandResult } from '../types.js';
import type { getSystemStatus } from './status-system.js';

// Perform health checks
export async function performHealthCheck(
  status: Awaited<ReturnType<typeof getSystemStatus>>,
): Promise<CommandResult> {
  output.writeln();
  output.writeln(output.bold('Health Check'));
  output.writeln();

  const checks: Array<{ name: string; status: 'pass' | 'fail' | 'warn'; message: string }> = [];

  // Check if system is running
  checks.push({
    name: 'System Running',
    status: status.running ? 'pass' : 'fail',
    message: status.running ? 'System is running' : 'System is not running',
  });

  // Check swarm health
  if (status.running) {
    checks.push({
      name: 'Swarm Status',
      status:
        status.swarm.status === 'running'
          ? 'pass'
          : status.swarm.status === 'no_swarm'
            ? 'fail'
            : 'warn',
      message: `Swarm status: ${status.swarm.status}`,
    });

    // Check agent count
    checks.push({
      name: 'Agents Available',
      status: status.swarm.agents.total > 0 ? 'pass' : 'fail',
      message: `${status.swarm.agents.total} agent(s)`,
    });

    // Check MCP
    checks.push({
      name: 'MCP Server',
      status: status.mcp.running ? 'pass' : 'warn',
      message: status.mcp.running
        ? status.mcp.transport === 'stdio'
          ? 'Running (stdio mode)'
          : `Running on port ${status.mcp.port}`
        : 'Not running',
    });

    // Check memory backend
    checks.push({
      name: 'Memory Backend',
      status: status.memory.backend !== 'none' ? 'pass' : 'fail',
      message: `Using ${status.memory.backend} backend`,
    });

    // Check for failed tasks
    const failRate = status.tasks.total > 0 ? status.tasks.failed / status.tasks.total : 0;
    checks.push({
      name: 'Task Success Rate',
      status: failRate < 0.05 ? 'pass' : failRate < 0.2 ? 'warn' : 'fail',
      message: `${((1 - failRate) * 100).toFixed(1)}% success rate`,
    });
  }

  // Display results
  for (const check of checks) {
    const icon =
      check.status === 'pass'
        ? output.success('[PASS]')
        : check.status === 'warn'
          ? output.warning('[WARN]')
          : output.error('[FAIL]');
    output.writeln(`${icon} ${check.name}: ${check.message}`);
  }

  output.writeln();

  const passed = checks.filter((c) => c.status === 'pass').length;
  const warned = checks.filter((c) => c.status === 'warn').length;
  const failed = checks.filter((c) => c.status === 'fail').length;

  if (failed === 0) {
    output.printSuccess(`All checks passed (${passed} passed, ${warned} warnings)`);
  } else {
    output.printError(
      `Health check failed (${passed} passed, ${warned} warnings, ${failed} failed)`,
    );
  }

  return {
    success: failed === 0,
    exitCode: failed > 0 ? 1 : 0,
    data: { checks, summary: { passed, warned, failed } },
  };
}
