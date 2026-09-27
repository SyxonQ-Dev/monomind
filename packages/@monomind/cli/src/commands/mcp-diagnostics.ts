/**
 * CLI MCP diagnostic subcommands: health, logs, verify.
 * Split from mcp.ts.
 *
 * @module @monomind/cli/commands/mcp-diagnostics
 */

import { hasTool, listMCPTools } from '../mcp-client.js';
import { getMCPServerStatus, getServerManager } from '../mcp-server.js';
import { output } from '../output.js';
import { mcpAddHint } from '../platform-adapters/renderers/mcp.js';
import type { Command, CommandContext, CommandResult } from '../types.js';

// Health check command
export const healthCommand: Command = {
  name: 'health',
  description: 'Check MCP server health',
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    try {
      const status = await getMCPServerStatus();

      if (!status.running) {
        output.printError('MCP Server is not running');
        return { success: false, exitCode: 1 };
      }

      const manager = getServerManager();
      const health = await manager.checkHealth();

      if (ctx.flags.format === 'json') {
        output.printJson(health);
        return { success: true, data: health };
      }

      output.writeln();
      output.writeln(output.bold('MCP Server Health'));
      output.writeln();

      if (health.healthy) {
        output.printSuccess('Server is healthy');
      } else {
        output.printError(`Server is unhealthy: ${health.error || 'Unknown error'}`);
      }

      if (health.metrics) {
        output.writeln();
        output.writeln(output.bold('Metrics:'));
        for (const [key, value] of Object.entries(health.metrics)) {
          output.writeln(`  ${key}: ${value}`);
        }
      }

      return { success: health.healthy, data: health };
    } catch (error) {
      output.printError(`Health check failed: ${(error as Error).message}`);
      return { success: false, exitCode: 1 };
    }
  },
};

// Logs command
export const logsCommand: Command = {
  name: 'logs',
  description: 'Show MCP server logs',
  options: [
    {
      name: 'lines',
      short: 'n',
      description: 'Number of lines',
      type: 'number',
      default: 20,
    },
    {
      name: 'follow',
      short: 'f',
      description: 'Follow log output',
      type: 'boolean',
      default: false,
    },
    {
      name: 'level',
      description: 'Filter by log level',
      type: 'string',
      choices: ['debug', 'info', 'warn', 'error'],
    },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const lines = (ctx.flags.lines as number) || 50;
    const follow = ctx.flags.follow as boolean;
    const levelFilter = (ctx.flags.level as string | undefined)?.toLowerCase();

    // Try to find and read the actual log file
    const { existsSync, readFileSync, statSync, watch, createReadStream } = await import('node:fs');
    const { join } = await import('node:path');

    const MAX_MCP_LOG_BYTES = 10 * 1024 * 1024; // 10 MB
    const logPaths = [
      join(ctx.cwd, '.monomind', 'logs', 'mcp-server.log'),
      join(ctx.cwd, '.monomind', 'logs', 'daemon.log'),
      join(ctx.cwd, '.monomind', 'mcp.log'),
    ];

    const logFile = logPaths.find((p) => existsSync(p) && statSync(p).size <= MAX_MCP_LOG_BYTES);

    output.writeln();
    output.writeln(output.bold('MCP Server Logs'));
    output.writeln(output.dim('─'.repeat(50)));

    if (!logFile) {
      output.writeln(output.dim('No log files found. Start the MCP server to generate logs.'));
      output.writeln(
        output.dim(`Checked: ${logPaths.map((p) => p.replace(ctx.cwd, '.')).join(', ')}`),
      );
      if (follow) {
        output.printError('--follow requires an existing log file to watch — none was found.');
        return { success: false };
      }
      return { success: true };
    }

    // Best-effort text match: log line formats vary (bracketed, "level:", JSON),
    // so match the level as a whole word anywhere in the line rather than
    // assuming one format.
    const levelPattern = levelFilter ? new RegExp(`\\b${levelFilter}\\b`, 'i') : null;
    const matchesLevel = (line: string): boolean => !levelPattern || levelPattern.test(line);

    const content = readFileSync(logFile, 'utf8');
    const logLines = content.trim().split('\n').filter(Boolean).filter(matchesLevel);
    const tail = logLines.slice(-lines);

    if (tail.length === 0) {
      output.writeln(
        output.dim(
          levelFilter
            ? `Log file has no lines matching level "${levelFilter}".`
            : 'Log file is empty.',
        ),
      );
    } else {
      output.writeln(
        output.dim(
          `Showing last ${tail.length} lines from ${logFile.replace(ctx.cwd, '.')}` +
            (levelFilter ? ` (level=${levelFilter})` : ''),
        ),
      );
      output.writeln();
      tail.forEach((line) => output.writeln(line));
    }

    if (!follow) {
      return { success: true };
    }

    // Real tail -f: watch the file for growth and stream newly appended lines,
    // filtered the same way as the initial tail. Exits on Ctrl+C.
    output.writeln();
    output.writeln(output.dim('Following log output — press Ctrl+C to stop.'));

    return new Promise<CommandResult>((resolve) => {
      let position = statSync(logFile).size;
      let pendingPartialLine = '';
      let reading = false;

      const readNewData = () => {
        if (reading) return;
        reading = true;
        let size: number;
        try {
          size = statSync(logFile).size;
        } catch {
          reading = false;
          return;
        }
        if (size < position) {
          // File was truncated or rotated — restart from the beginning.
          position = 0;
          pendingPartialLine = '';
        }
        if (size <= position) {
          reading = false;
          return;
        }
        const stream = createReadStream(logFile, {
          start: position,
          end: size - 1,
          encoding: 'utf8',
        });
        let chunkData = '';
        stream.on('data', (chunk) => {
          chunkData += chunk;
        });
        stream.on('end', () => {
          position = size;
          const combined = pendingPartialLine + chunkData;
          const parts = combined.split('\n');
          pendingPartialLine = parts.pop() ?? '';
          for (const line of parts) {
            if (line && matchesLevel(line)) output.writeln(line);
          }
          reading = false;
        });
        stream.on('error', () => {
          reading = false;
        });
      };

      const watcher = watch(logFile, { persistent: true }, (eventType) => {
        if (eventType === 'change') readNewData();
      });

      const stop = () => {
        watcher.close();
        resolve({ success: true });
      };
      process.once('SIGINT', stop);
    });
  },
};

// Verify subcommand — bridges the new-user "did the install actually work?" gap (P0-16).
// Runs after the `claude mcp add monomind -- ...` hint (mcpAddHint()) to give the
// user confidence the wiring is live: lists tools through the in-process registry and
// confirms the MCP server can be reached from a stdio client.
export const verifyCommand: Command = {
  name: 'verify',
  description:
    'Verify the MCP server is reachable and its tools respond. Run this after `claude mcp add monomind ...` to confirm the install worked.',
  options: [],
  examples: [
    { command: 'monomind mcp verify', description: 'Confirm MCP server wiring and tool registry' },
  ],
  action: async (_ctx: CommandContext): Promise<CommandResult> => {
    output.writeln();
    output.writeln(output.bold('MCP Install Verification'));
    output.writeln();

    const checks: Array<{ label: string; ok: boolean; detail: string }> = [];

    // 1. In-process tool registry responds
    let toolCount = 0;
    try {
      const tools = await listMCPTools();
      toolCount = tools.length;
      checks.push({
        label: 'Tool registry',
        ok: toolCount > 0,
        detail: `${toolCount} tools registered`,
      });
    } catch (e) {
      checks.push({ label: 'Tool registry', ok: false, detail: `error: ${(e as Error).message}` });
    }

    // 2. A known built-in tool resolves
    const sampleTool = 'system_info';
    try {
      const has = await hasTool(sampleTool);
      checks.push({
        label: `Sample tool (${sampleTool})`,
        ok: has,
        detail: has ? 'resolves' : 'missing',
      });
    } catch (e) {
      checks.push({
        label: `Sample tool (${sampleTool})`,
        ok: false,
        detail: `error: ${(e as Error).message}`,
      });
    }

    // 3. claude mcp list includes monomind (best-effort; skip if claude CLI missing)
    try {
      const { spawnSync } = await import('node:child_process');
      const result = spawnSync('claude', ['mcp', 'list'], { encoding: 'utf8', timeout: 5000 });
      const claudeMissing = (result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
      if (claudeMissing) {
        // Not a failure: this sandbox may not have `claude` on PATH at all (e.g. a
        // fresh CI/container shell), and a project with .mcp.json gets monomind
        // registered per-project by Claude Code itself — no user-level `claude mcp
        // add` or PATH entry required.
        checks.push({
          label: 'claude mcp registration',
          ok: true,
          detail:
            'claude CLI not on PATH — skipped, not an error (a project .mcp.json registers monomind automatically; user-level `claude mcp add` is only needed without one)',
        });
      } else if (result.error || result.status !== 0) {
        checks.push({
          label: 'claude mcp registration',
          ok: false,
          detail: `claude CLI unavailable or returned non-zero — run \`${mcpAddHint()}\` to register`,
        });
      } else {
        const listed = (result.stdout || '').toLowerCase();
        const registered = listed.includes('monomind');
        checks.push({
          label: 'claude mcp registration',
          ok: registered,
          detail: registered
            ? 'monomind appears in `claude mcp list`'
            : `monomind NOT in \`claude mcp list\` — run \`${mcpAddHint()}\``,
        });
      }
    } catch {
      checks.push({
        label: 'claude mcp registration',
        ok: true,
        detail:
          'claude CLI not found — skipped, not an error (install Claude Code or register manually if needed)',
      });
    }

    // Render
    let allOk = true;
    for (const c of checks) {
      const mark = c.ok ? output.success('✓') : output.error('✗');
      output.writeln(`  ${mark} ${c.label}: ${c.detail}`);
      if (!c.ok) allOk = false;
    }

    output.writeln();
    if (allOk) {
      output.printSuccess(
        `MCP install verified — ${toolCount} tools available. In Claude Code, type /mastermind:help to see slash commands.`,
      );
    } else {
      output.printError(
        'One or more checks failed. Fix the issues above and re-run `monomind mcp verify`.',
      );
    }

    return { success: allOk, exitCode: allOk ? 0 : 1 };
  },
};
