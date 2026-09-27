import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_SYSTEM_STORE_BYTES } from './system-tools-core.js';
import { getMonomindDataRoot, type MCPTool } from './types.js';

export const mcpStatusTool: MCPTool = {
  name: 'mcp_status',
  description: 'Get MCP server status, including stdio mode detection',
  category: 'system',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: async () => {
    // Detect if we are running inside an MCP stdio session.
    // When Claude Code launches us via `claude mcp add`, stdin is piped (not a TTY)
    // and the process IS the MCP server, so it is running.
    const isStdio = !process.stdin.isTTY;
    const transport = process.env.MONOMIND_MCP_TRANSPORT || (isStdio ? 'stdio' : 'http');
    const port = parseInt(process.env.MONOMIND_MCP_PORT || '3000', 10);

    if (transport === 'stdio' || isStdio) {
      // In stdio mode the MCP server is this process itself
      return {
        running: true,
        pid: process.pid,
        transport: 'stdio',
        port: null,
        host: null,
      };
    }

    // For HTTP/WebSocket, try to check if the server is listening
    const host = process.env.MONOMIND_MCP_HOST || 'localhost';
    try {
      const { createConnection } = await import('node:net');
      const connected = await new Promise<boolean>((resolve) => {
        const socket = createConnection({ host, port }, () => {
          socket.destroy();
          resolve(true);
        });
        socket.on('error', () => resolve(false));
        socket.setTimeout(2000, () => {
          socket.destroy();
          resolve(false);
        });
      });

      return {
        running: connected,
        transport,
        port,
        host,
      };
    } catch {
      return {
        running: false,
        transport,
        port,
        host,
      };
    }
  },
};

export const taskSummaryTool: MCPTool = {
  name: 'task_summary',
  description: 'Get a summary of all tasks by status',
  category: 'task',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: async () => {
    // Read from the task store file
    const storePath = join(getMonomindDataRoot(), 'tasks', 'store.json');
    let tasks: Array<{ status: string }> = [];
    try {
      if (existsSync(storePath) && statSync(storePath).size <= MAX_SYSTEM_STORE_BYTES) {
        const data = readFileSync(storePath, 'utf-8');
        const store = JSON.parse(data);
        tasks = Object.values(store.tasks || {});
      }
    } catch (e) {
      if (process.env.DEBUG || process.env.MONOMIND_DEBUG)
        console.error('[task_summary] failed to read/parse task store:', e);
    }

    return {
      total: tasks.length,
      pending: tasks.filter((t) => t.status === 'pending').length,
      running: tasks.filter((t) => t.status === 'in_progress').length,
      completed: tasks.filter((t) => t.status === 'completed').length,
      failed: tasks.filter((t) => t.status === 'failed').length,
    };
  },
};
