/**
 * CLI MCP Command
 * MCP server control and management with real server integration
 *
 * @module @monomind/cli/commands/mcp
 * @version 3.0.0
 */

import { runMonoesProxy } from '../mcp/monoes-proxy.js';
import { output } from '../output.js';
import type { Command, CommandContext, CommandResult } from '../types.js';
import { healthCommand, logsCommand, verifyCommand } from './mcp-diagnostics.js';
import { restartCommand, startCommand, statusCommand, stopCommand } from './mcp-lifecycle.js';
import { execCommand, toggleCommand, toolsCommand } from './mcp-tool-commands.js';

export { logsCommand } from './mcp-diagnostics.js';

// monoes.me MCP proxy — internal subcommand run by the `monoes` stdio entry
// .mcp.json's init/dashboard writers generate (mcp-generator.ts,
// routes-monoes.mjs). Not advertised in the top-level subcommand list below:
// it isn't something a user runs directly, only something Claude Code spawns.
// Body lives in mcp/monoes-proxy.ts — this is deliberately a thin registration.
const monoesProxyCommand: Command = {
  name: 'monoes-proxy',
  description: 'Internal: stdio<->HTTP proxy for the monoes.me MCP server (i-066)',
  options: [],
  action: async (): Promise<CommandResult> => {
    await runMonoesProxy();
    return { success: true };
  },
};

// Main MCP command
export const mcpCommand: Command = {
  name: 'mcp',
  description: 'MCP server management',
  subcommands: [
    startCommand,
    stopCommand,
    statusCommand,
    healthCommand,
    restartCommand,
    toolsCommand,
    toggleCommand,
    execCommand,
    logsCommand,
    verifyCommand,
    monoesProxyCommand,
  ],
  options: [],
  examples: [
    { command: 'monomind mcp start', description: 'Start MCP server' },
    {
      command: 'monomind mcp start -t http -p 8080',
      description: 'Start HTTP server on port 8080',
    },
    { command: 'monomind mcp status', description: 'Show server status' },
    { command: 'monomind mcp tools', description: 'List tools' },
    {
      command: 'monomind mcp verify',
      description: 'Verify the MCP server is reachable and tools respond',
    },
    { command: 'monomind mcp stop', description: 'Stop the server' },
  ],
  action: async (_ctx: CommandContext): Promise<CommandResult> => {
    output.writeln();
    output.writeln(output.bold('MCP Server Management'));
    output.writeln();
    output.writeln('Usage: monomind mcp <subcommand> [options]');
    output.writeln();
    output.writeln('Subcommands:');
    output.printList([
      `${output.highlight('start')}    - Start MCP server`,
      `${output.highlight('stop')}     - Stop MCP server`,
      `${output.highlight('status')}   - Show server status`,
      `${output.highlight('health')}   - Check server health`,
      `${output.highlight('restart')}  - Restart MCP server`,
      `${output.highlight('tools')}    - List available tools`,
      `${output.highlight('toggle')}   - Enable/disable tools`,
      `${output.highlight('exec')}     - Execute a tool`,
      `${output.highlight('logs')}     - Show server logs`,
      `${output.highlight('verify')}   - Verify the MCP server is reachable and tools respond`,
    ]);

    return { success: true };
  },
};

export default mcpCommand;
